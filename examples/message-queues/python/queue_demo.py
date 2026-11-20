"""A message queue with leases, acks and a dead-letter queue, and five things that go wrong.

Time is simulated (seconds passed in by the caller), so every run prints the same output.
Run: python3 queue_demo.py
"""
from collections import deque
from dataclasses import dataclass


@dataclass
class Message:
    id: int
    body: dict
    receives: int = 0  # how many times a worker has taken it


class Queue:
    """Receiving hides a message for `visibility_s` seconds (its lease). Ack deletes it.
    A lease that runs out puts the message back. Too many receives sends it to the DLQ."""

    def __init__(self, visibility_s: float = 30, max_receives: int = 5):
        self.visibility_s = visibility_s
        self.max_receives = max_receives
        self.waiting: deque[Message] = deque()
        self.in_flight: dict[int, tuple[Message, float]] = {}  # receipt -> (message, lease end)
        self.dead_letters: list[Message] = []
        self._next_id = 1
        self._next_receipt = 1

    def send(self, body: dict) -> int:
        msg = Message(self._next_id, body)
        self._next_id += 1
        self.waiting.append(msg)  # a real broker writes it to disk before answering
        return msg.id

    def _expire_leases(self, now: float) -> None:
        for receipt, (msg, lease_end) in list(self.in_flight.items()):
            if now >= lease_end:  # nobody acked in time: give it to someone else
                del self.in_flight[receipt]
                self.waiting.appendleft(msg)

    def receive(self, now: float) -> tuple[int, Message] | None:
        self._expire_leases(now)
        while self.waiting:
            msg = self.waiting.popleft()
            if msg.receives >= self.max_receives:  # tried enough: park it
                self.dead_letters.append(msg)
                continue
            msg.receives += 1
            receipt = self._next_receipt
            self._next_receipt += 1
            self.in_flight[receipt] = (msg, now + self.visibility_s)
            return receipt, msg
        return None

    def ack(self, receipt: int, now: float) -> bool:
        """Delete for good. False if the lease already ran out (someone else may have it)."""
        self._expire_leases(now)
        return self.in_flight.pop(receipt, None) is not None

    def extend(self, receipt: int, now: float) -> None:
        """Heartbeat: 'still working on it', the lease restarts from now."""
        msg, _ = self.in_flight[receipt]
        self.in_flight[receipt] = (msg, now + self.visibility_s)

    def size(self) -> int:
        return len(self.waiting) + len(self.in_flight)


emails: list[str] = []  # what the email provider actually sent


def send_email(order_id: int, now: float) -> None:
    emails.append(f"t={now:>5.0f}s confirmation for order {order_id}")


def show(title: str, q: Queue) -> None:
    print(title)
    for line in emails:
        print("   ", line)
    print(f"    emails sent: {len(emails)}, left in queue: {q.size()}, dead letters: {len(q.dead_letters)}")
    emails.clear()


# 1. Ack first, then work: a crash loses the message.
q = Queue()
q.send({"order_id": 1042})
receipt, msg = q.receive(now=0)
q.ack(receipt, now=0)  # "got it" before doing anything
# ...the worker crashes here, before sending the email
show("1. Ack on receive, worker crashes before sending", q)

# 2. Work first, then ack: a crash after sending means the email goes twice.
q = Queue()
q.send({"order_id": 1042})
receipt, msg = q.receive(now=0)
send_email(msg.body["order_id"], now=1)
# ...worker A crashes here, before its ack. 30 s later the lease runs out.
receipt, msg = q.receive(now=31)  # worker B
send_email(msg.body["order_id"], now=32)
q.ack(receipt, now=32)
show("2. Ack after sending, worker A crashes between send and ack", q)

# 3. Same crash, idempotent consumer: remember which orders were already emailed.
already_sent: set[int] = set()  # in production: a table with a unique key, see the page


def handle(msg: Message, now: float) -> None:
    order_id = msg.body["order_id"]
    if order_id in already_sent:
        return  # a duplicate delivery: do nothing, but still ack it
    send_email(order_id, now)
    already_sent.add(order_id)


q = Queue()
q.send({"order_id": 1042})
receipt, msg = q.receive(now=0)
handle(msg, now=1)
# ...worker A crashes before its ack
receipt, msg = q.receive(now=31)
handle(msg, now=32)
q.ack(receipt, now=32)
show("3. Same crash, idempotent consumer", q)

# 4. No crash at all, but the work takes 45 s and the lease is 30 s.
q = Queue()
q.send({"order_id": 1042})
receipt_a, msg = q.receive(now=0)   # worker A starts a slow send
receipt_b, msg_b = q.receive(now=30)  # lease ran out at 30 s: worker B gets it too
send_email(msg_b.body["order_id"], now=40)
q.ack(receipt_b, now=40)
send_email(msg.body["order_id"], now=45)
late = q.ack(receipt_a, now=45)
show(f"4. Work takes 45 s, lease is 30 s (worker A's ack accepted: {late})", q)

q = Queue()
q.send({"order_id": 1042})
receipt, msg = q.receive(now=0)
for t in (10, 20, 30, 40):  # heartbeat every 10 s while working
    q.extend(receipt, now=t)
send_email(msg.body["order_id"], now=45)
q.ack(receipt, now=45)
show("   Same slow send, worker extends its lease every 10 s", q)

# 5. A poison message: every attempt crashes the worker.
q = Queue(visibility_s=30, max_receives=5)
q.send({"order_id": "10x42"})  # a bad order id that makes the handler crash
print("5. Poison message, lease 30 s, max 5 receives")
t = 0
while q.dead_letters == []:
    got = q.receive(now=t)
    if got:
        print(f"    t={t:>4}s attempt {got[1].receives}: handler crashes, no ack")
    t += 30
print(f"    t={t - 30:>4}s next receive moves order {q.dead_letters[0].body['order_id']} to the dead-letter queue")

# 6. A sale: 300 orders a second for 10 minutes, workers send 100 emails a second.
print("6. Backlog: 300 orders/s for 600 s, then 40/s; workers send 100 emails/s")
backlog, peak, peak_at, drained_at = 0, 0, 0, None
for second in range(1, 3601):
    arrivals = 300 if second <= 600 else 40
    backlog = max(0, backlog + arrivals - 100)
    if backlog > peak:
        peak, peak_at = backlog, second
    if second > 600 and backlog == 0 and drained_at is None:
        drained_at = second
print(f"    peak backlog {peak:,} messages at t={peak_at} s")
print(f"    backlog empty again at t={drained_at} s ({drained_at // 60} min {drained_at % 60} s)")
print(f"    an order placed at t=600 s waits {peak // 100} s for its email")
