"""Cache-aside writes racing with reads: set on write, delete on write, and a versioned marker.

Part 1 replays the two classic interleavings step by step.
Part 2 runs one hot key for 10 simulated minutes with random timing and measures how long the
cache holds a version older than one a writer has already told it about. (The millisecond
between a commit and its own cache command is stale under every strategy, so it is not counted.)

Run: python race.py
"""
import heapq
import math

M32 = 0xFFFFFFFF


class Rng:
    """mulberry32, the same generator as the JavaScript version, so both print the same numbers."""

    def __init__(self, seed: int) -> None:
        self.state = seed & M32

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & M32
        t = self.state
        t = ((t ^ (t >> 15)) * (t | 1)) & M32
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & M32)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    def exp(self, mean: float) -> float:
        return -math.log(1 - self.next()) * mean


class Cache:
    """One key. An entry is (kind, version): kind 'value', or 'marker' for "deleted at version v"."""

    def __init__(self, mode: str) -> None:
        self.mode, self.entry = mode, None

    def fill(self, version: int) -> bool:
        """What a reader does after a miss. Returns False if the write was refused."""
        if self.mode == "versioned" and self.entry is not None:
            kind, current = self.entry
            # Refuse anything older than what the cache already knows about.
            if version < current or (kind == "value" and version == current):
                return False
        self.entry = ("value", version)
        return True

    def after_write(self, version: int) -> None:
        """What a writer does after committing `version` to the database."""
        if self.mode == "set":
            self.entry = ("value", version)
        elif self.mode == "delete":
            self.entry = None
        else:
            self.entry = ("marker", version)

    def get(self) -> int | None:
        return self.entry[1] if self.entry and self.entry[0] == "value" else None


def replay() -> None:
    print("Set on write, two writers (database: v1 then v2; cache updates arrive v2 then v1)")
    db, cache = 0, Cache("set")
    db = 1  # writer A commits v1
    db = 2  # writer B commits v2
    cache.after_write(2)  # B's SET reaches the cache first
    cache.after_write(1)  # A's SET was delayed
    print(f"  database v{db}, cache v{cache.get()}  -> stale until the next write or the TTL\n")

    for mode in ("delete", "versioned"):
        label = "Delete on write" if mode == "delete" else "Versioned marker"
        print(f"{label}, one reader and one writer")
        db, cache = 1, Cache(mode)
        steps = []
        seen = db  # reader: cache miss, SELECT returns v1
        steps.append(f"reader misses and reads v{seen}")
        db = 2  # writer commits v2
        cache.after_write(db)
        steps.append(f"writer commits v2 and {'deletes the key' if mode == 'delete' else 'writes marker v2'}")
        ok = cache.fill(seen)
        steps.append(f"reader fills v{seen}: {'stored' if ok else 'refused, the marker is newer'}")
        for s in steps:
            print("  " + s)
        if cache.get() is None:
            seen = db  # the next reader misses and reads v2
            cache.fill(seen)
            print(f"  next reader misses, reads v{seen} and fills it")
        print(f"  database v{db}, cache v{cache.get()}\n")


def simulate(mode: str, writes_per_s: float, seed: int = 11) -> tuple[float, float, int]:
    """One key, 500 reads/s and `writes_per_s` writes/s, Poisson. A DB read takes 10 ms on
    average, a commit 5 ms, a cache command 1 ms. TTL 60 s. Returns (share of time stale,
    longest stale stretch in ms, number of refused fills)."""
    rng, cache = Rng(seed), Cache(mode)
    end, ttl = 600_000.0, 60_000.0
    db, set_at, told = 0, 0.0, 0  # told: newest version whose cache command has landed
    cache.entry = ("value", 0)
    events: list[tuple[float, int, str, int]] = []
    seq = 0

    def push(t: float, kind: str, v: int = 0) -> None:
        nonlocal seq
        seq += 1
        heapq.heappush(events, (t, seq, kind, v))

    push(rng.exp(1000 / 500), "read")
    push(rng.exp(1000 / writes_per_s), "write")
    stale_ms = longest = 0.0
    stale_since, last_t, refused = None, 0.0, 0
    while events:
        t, _, kind, v = heapq.heappop(events)
        if t > end:
            break
        if cache.entry and t - set_at > ttl:  # expired
            cache.entry = None
        current = cache.get()
        if current is not None and current < told:
            stale_ms += t - last_t
        last_t = t
        if kind == "read":
            if cache.get() is None:
                push(t + rng.exp(5), "snapshot")  # the SELECT sees the database a moment later
            push(t + rng.exp(1000 / 500), "read")
        elif kind == "snapshot":
            push(t + rng.exp(5) + rng.exp(1), "fill", db)  # result returns, then SET to cache
        elif kind == "fill":
            if cache.fill(v):
                set_at = t
            else:
                refused += 1
        elif kind == "write":
            push(t + rng.exp(5), "commit")
            push(t + rng.exp(1000 / writes_per_s), "write")
        elif kind == "commit":
            db += 1
            push(t + rng.exp(1), "cache-op", db)
        elif kind == "cache-op":
            cache.after_write(v)
            set_at, told = t, max(told, v)
        now = cache.get()
        if now is not None and now < told:
            stale_since = t if stale_since is None else stale_since
        elif stale_since is not None:
            longest = max(longest, t - stale_since)
            stale_since = None
    return stale_ms / end, longest, refused


def main() -> None:
    replay()
    print("One key, 500 reads/s, 10 minutes, TTL 60 s: time the cache holds an outdated version")
    print(f"  {'writes/s':<10}{'set on write':>22}{'delete on write':>22}{'versioned marker':>22}")
    for w in (1, 5, 20):
        cells = []
        for mode in ("set", "delete", "versioned"):
            share, longest, _ = simulate(mode, w)
            cells.append(f"{100 * share:.2f}% (max {longest / 1000:.2f} s)")
        print(f"  {w:<10}" + "".join(f"{c:>22}" for c in cells))


if __name__ == "__main__":
    main()
