"""A leader and followers in one process, with a simulated clock, to show three things:

1. Naive: the app writes to two databases itself, and one write fails -> the copies differ.
2. Replication through a log: asynchronous loses the changes still in flight when the leader
   crashes; synchronous loses none, but every commit waits one round trip.
3. Read-your-writes: remember the log position of your last write, and only read from a follower
   that has reached it.

Times are simulated milliseconds, so the output is the same on every run. Run: python3 replication_demo.py
"""
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------------------------
# 1. The naive fix: the application writes every change to two databases.
# ---------------------------------------------------------------------------------------------
def naive_dual_write() -> None:
    db_a: dict[str, str] = {}
    db_b: dict[str, str] = {}
    changes = [("order-1", "Pune"), ("order-2", "Delhi"), ("order-1", "Mumbai")]
    for number, (key, value) in enumerate(changes, start=1):
        db_a[key] = value
        if number == 3:  # the second database times out on the third write
            print(f"  write {number} to db_b failed: timeout (db_a already has it)")
            continue
        db_b[key] = value
    print(f"  db_a: {db_a}")
    print(f"  db_b: {db_b}")
    print(f"  copies agree? {db_a == db_b}")


# ---------------------------------------------------------------------------------------------
# 2. Replication through a log.
# ---------------------------------------------------------------------------------------------
@dataclass
class Node:
    name: str
    one_way_ms: int = 0                                  # network delay from the leader
    log: list[tuple[str, str]] = field(default_factory=list)
    rows: dict[str, str] = field(default_factory=dict)

    @property
    def position(self) -> int:
        """How many log entries this node has applied."""
        return len(self.log)

    def apply(self, entry: tuple[str, str]) -> None:
        self.log.append(entry)
        key, value = entry
        self.rows[key] = value


class Leader(Node):
    def __init__(self, followers: list[Node], synchronous: bool):
        super().__init__("leader")
        self.followers = followers
        self.synchronous = synchronous
        self.in_flight: list[tuple[int, Node, tuple[str, str]]] = []  # (arrives_at, follower, entry)

    def write(self, key: str, value: str, now: int) -> tuple[int, int]:
        """Apply a change, send it to every follower, and return (log position, commit time)."""
        entry = (key, value)
        self.apply(entry)
        for f in self.followers:
            self.in_flight.append((now + f.one_way_ms, f, entry))
        if not self.synchronous:
            return self.position, now  # reply at once; the followers get it later
        # Synchronous: wait until the nearest follower has it and its "got it" has come back.
        nearest = min(f.one_way_ms for f in self.followers)
        return self.position, now + 2 * nearest

    def deliver_until(self, now: int) -> None:
        """Hand every change whose travel time is over to its follower, in order."""
        arrived = [m for m in self.in_flight if m[0] <= now]
        self.in_flight = [m for m in self.in_flight if m[0] > now]
        for _, follower, entry in sorted(arrived, key=lambda m: m[0]):
            follower.apply(entry)


def crash_test(synchronous: bool) -> None:
    follower = Node("follower", one_way_ms=40)
    leader = Leader([follower], synchronous)
    now, waited = 0, 0
    for n in range(1, 6):
        _, committed_at = leader.write(f"order-{n}", "placed", now)
        waited += committed_at - now                     # time the customer waited for "saved"
        now = committed_at + 1                            # the next order arrives 1 ms later
        if synchronous:
            leader.deliver_until(committed_at)
    leader.deliver_until(now)                            # the leader crashes at this moment
    lost = leader.position - follower.position
    mode = "synchronous " if synchronous else "asynchronous"
    print(f"  {mode}: waited {waited:3} ms for 5 commits, leader crashes at t={now} ms,"
          f" follower has {follower.position} of 5, lost {lost}")


# ---------------------------------------------------------------------------------------------
# 3. Read-your-writes: route a read to a follower only if it has reached your last write.
# ---------------------------------------------------------------------------------------------
def read(key: str, leader: Leader, follower: Node, min_position: int) -> tuple[str, str | None]:
    if follower.position >= min_position:
        return follower.name, follower.rows.get(key)
    return leader.name, leader.rows.get(key)              # the follower is behind: ask the leader


def read_your_writes() -> None:
    follower = Node("follower", one_way_ms=40)
    leader = Leader([follower], synchronous=False)
    leader.write("address:42", "Pune", now=0)
    leader.deliver_until(100)                             # long ago: everyone agrees on Pune
    my_position, _ = leader.write("address:42", "Mumbai", now=100)

    for t in (105, 145):
        leader.deliver_until(t)
        naive = follower.rows.get("address:42")
        served_by, value = read("address:42", leader, follower, my_position)
        print(f"  t={t} ms: follower alone says {naive!r:9}"
              f" | with position check: {value!r} from the {served_by}")


if __name__ == "__main__":
    print("1. Naive: the app writes to two databases")
    naive_dual_write()
    print("2. Replication through a log, follower 40 ms away")
    crash_test(synchronous=False)
    crash_test(synchronous=True)
    print("3. Read-your-writes, address changed from Pune to Mumbai at t=100 ms")
    read_your_writes()
