"""Logging, from print() to a production-shaped logger, in four steps:

1. Naive: three services print free-text lines. Finding one customer's request means guessing.
2. Structured: every line is one JSON object with a request ID, so one search finds the whole story.
3. Redaction: a filter masks passwords, card numbers and tokens before anything is written.
4. Non-blocking: a slow log destination blocks every request, unless the app hands lines to a
   bounded queue that a background thread drains, and counts what it has to drop.

Run: python3 logging_demo.py   (standard library only, Python 3.11+)
"""
import contextvars
import io
import json
import logging
import logging.handlers
import queue
import time

# ---------------------------------------------------------------------------------------------
# 1. Naive: print free text.
# ---------------------------------------------------------------------------------------------
def naive() -> None:
    out = io.StringIO()
    def say(line: str) -> None:
        print(line, file=out)
    say("checkout: placing order for asha@example.com")
    say("checkout: placing order for ravi@example.com")
    say("payments: charged card ending 4242")
    say("payments: charged card ending 1881")
    say("checkout: ERROR timeout talking to payments")
    say("checkout: order placed")
    lines = out.getvalue().splitlines()
    print(f"  {len(lines)} lines. Which charge belongs to the order that failed? The lines cannot say.")
    for line in lines:
        print("   ", line)


# ---------------------------------------------------------------------------------------------
# 2. Structured: one JSON object per line, with the request ID added automatically.
# ---------------------------------------------------------------------------------------------
request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class JsonFormatter(logging.Formatter):
    """Turns a log record into one line of JSON: fixed fields first, then the event's own fields."""

    def format(self, record: logging.LogRecord) -> str:
        event = {
            "time": time.strftime("%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}",
            "level": record.levelname,
            "service": record.name,
            "request_id": request_id.get(),
            "msg": record.getMessage(),
        }
        event.update(getattr(record, "fields", {}))
        return json.dumps(event)


def make_logger(service: str, stream: io.StringIO) -> logging.Logger:
    log = logging.getLogger(service)
    log.handlers.clear()
    log.propagate = False
    log.setLevel(logging.INFO)
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    log.addHandler(handler)
    return log


def structured() -> None:
    out = io.StringIO()
    checkout, payments = make_logger("checkout", out), make_logger("payments", out)

    def place_order(rid: str, order_id: int, payment_ms: int) -> None:
        request_id.set(rid)                      # set once when the request arrives
        checkout.info("order received", extra={"fields": {"order_id": order_id}})
        charged = {"fields": {"order_id": order_id, "amount_inr": 1499, "took_ms": payment_ms}}
        if payment_ms > 2000:  # Checkout gives up at 2,000 ms; the charge finishes later
            checkout.error("payments timed out", extra={"fields": {"order_id": order_id, "timeout_ms": 2000}})
            payments.info("card charged", extra=charged)
        else:
            payments.info("card charged", extra=charged)
            checkout.info("order placed", extra={"fields": {"order_id": order_id}})

    place_order("req-7f3a", 1041, payment_ms=180)
    place_order("req-9c21", 1042, payment_ms=2400)

    # "Search" the central store: every line for the request the customer complained about.
    hits = [json.loads(l) for l in out.getvalue().splitlines() if json.loads(l)["request_id"] == "req-9c21"]
    print(f"  search request_id = req-9c21 -> {len(hits)} lines:")
    for e in hits:
        print("   ", json.dumps(e))


# ---------------------------------------------------------------------------------------------
# 3. Redaction: never let a secret reach a log line.
# ---------------------------------------------------------------------------------------------
SECRET_KEYS = {"password", "card_number", "token", "authorization"}


class RedactSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        fields = getattr(record, "fields", None)
        if fields:
            record.fields = {k: ("[REDACTED]" if k in SECRET_KEYS else v) for k, v in fields.items()}
        return True  # keep the line, only with the secrets masked


def redaction() -> None:
    out = io.StringIO()
    log = make_logger("login", out)
    log.handlers[0].addFilter(RedactSecrets())
    request_id.set("req-11aa")
    log.info("login attempt", extra={"fields": {"user": "asha", "password": "hunter2"}})
    print("   ", out.getvalue().strip())


# ---------------------------------------------------------------------------------------------
# 4. A slow destination: blocking vs a bounded queue drained by a background thread.
# ---------------------------------------------------------------------------------------------
class SlowNetworkHandler(logging.Handler):
    """Stands in for a log server across a slow network: every line takes 20 ms to send."""

    def __init__(self) -> None:
        super().__init__()
        self.sent = 0

    def emit(self, record: logging.LogRecord) -> None:
        time.sleep(0.020)
        self.sent += 1


class DroppingQueueHandler(logging.handlers.QueueHandler):
    """Puts records on a bounded queue; if the queue is full, drops the record and counts it."""

    def __init__(self, q: queue.Queue) -> None:
        super().__init__(q)
        self.dropped = 0

    def enqueue(self, record: logging.LogRecord) -> None:
        try:
            self.queue.put_nowait(record)
        except queue.Full:
            self.dropped += 1  # never make the request wait for the logs


def handle_requests(log: logging.Logger, requests: int, lines_per_request: int) -> float:
    """Serves requests one after another and returns the average time per request in ms."""
    start = time.perf_counter()
    for r in range(requests):
        for n in range(lines_per_request):
            log.info("step done", extra={"fields": {"request": r, "step": n}})
    return (time.perf_counter() - start) * 1000 / requests


def slow_destination() -> None:
    # Blocking: the request thread itself sends every line.
    blocking = logging.getLogger("blocking")
    blocking.handlers.clear(); blocking.propagate = False; blocking.setLevel(logging.INFO)
    slow = SlowNetworkHandler()
    blocking.addHandler(slow)
    ms = handle_requests(blocking, requests=20, lines_per_request=4)
    print(f"  blocking:     {ms:6.1f} ms per request (4 lines x 20 ms each)")

    # Non-blocking: lines go into a queue of 50; a background thread sends them.
    q: queue.Queue = queue.Queue(maxsize=50)
    nonblocking = logging.getLogger("nonblocking")
    nonblocking.handlers.clear(); nonblocking.propagate = False; nonblocking.setLevel(logging.INFO)
    qh = DroppingQueueHandler(q)
    nonblocking.addHandler(qh)
    slow2 = SlowNetworkHandler()
    listener = logging.handlers.QueueListener(q, slow2)
    listener.start()
    ms = handle_requests(nonblocking, requests=20, lines_per_request=4)
    while not q.empty():  # let the background thread finish sending what was queued
        time.sleep(0.01)
    listener.stop()
    print(f"  non-blocking: {ms:6.3f} ms per request; of 80 lines, {slow2.sent} sent,"
          f" {qh.dropped} dropped because the queue of 50 was full")


if __name__ == "__main__":
    print("1. Naive: free-text lines from two services")
    naive()
    print("2. Structured: JSON lines with a request ID")
    structured()
    print("3. Redaction")
    redaction()
    print("4. A destination that takes 20 ms per line")
    slow_destination()
