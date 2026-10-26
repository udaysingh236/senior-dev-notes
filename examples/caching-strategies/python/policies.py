"""Four eviction policies on the same traffic: LRU, LFU, W-TinyLFU (simplified) and S3-FIFO.

The traffic: 10,000 keys with Zipf popularity (the k-th most popular key gets 1/k of the
traffic of the first). Three scenarios:

  steady   only the Zipf traffic
  scans    a batch job reads keys nobody else reads, one for every two normal requests
  shift    halfway through, popularity flips: the coldest keys become the hottest

The hit ratio counts only the normal traffic; the scan's own reads miss under every policy.
"Best static" is the hit ratio of a cache that always holds exactly the most popular keys.

Run: python policies.py
"""
from bisect import bisect_right
from collections import OrderedDict, deque

KEYS, REQUESTS, SEED = 10_000, 200_000, 7
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


def mix(x: int) -> int:
    """A 32-bit integer hash, identical in both languages."""
    x &= M32
    x = ((x ^ (x >> 16)) * 0x45D9F3B) & M32
    x = ((x ^ (x >> 16)) * 0x45D9F3B) & M32
    return x ^ (x >> 16)


class Lru:
    def __init__(self, capacity: int) -> None:
        self.capacity, self.items = capacity, OrderedDict()

    def access(self, key: int) -> bool:
        if key in self.items:
            self.items.move_to_end(key)  # most recently used goes to the back
            return True
        self.items[key] = True
        if len(self.items) > self.capacity:
            self.items.popitem(last=False)  # least recently used is at the front
        return False


class Lfu:
    """Exact LFU in O(1): one bucket of keys per hit count. Counts are never aged."""

    def __init__(self, capacity: int) -> None:
        self.capacity, self.count, self.buckets, self.min = capacity, {}, {}, 0

    def access(self, key: int) -> bool:
        if key in self.count:
            c = self.count[key]
            del self.buckets[c][key]
            if not self.buckets[c]:
                del self.buckets[c]
                if self.min == c:
                    self.min = c + 1
            self.count[key] = c + 1
            self.buckets.setdefault(c + 1, OrderedDict())[key] = True
            return True
        if len(self.count) >= self.capacity:
            victim, _ = self.buckets[self.min].popitem(last=False)
            if not self.buckets[self.min]:
                del self.buckets[self.min]
            del self.count[victim]
        self.count[key] = 1
        self.buckets.setdefault(1, OrderedDict())[key] = True
        self.min = 1
        return False


class Sketch:
    """Count-min sketch: 4 rows of 4-bit counters. Estimate = the smallest of the 4 counters.
    Every 10 x capacity increments all counters are halved, so old popularity fades."""

    def __init__(self, capacity: int) -> None:
        self.width = 1
        while self.width < capacity * 4:
            self.width *= 2
        self.rows = [[0] * self.width for _ in range(4)]
        self.added, self.reset_at = 0, 10 * capacity

    def slots(self, key: int):
        return [(i, mix(key * 4 + i) & (self.width - 1)) for i in range(4)]

    def add(self, key: int) -> None:
        for i, j in self.slots(key):
            if self.rows[i][j] < 15:
                self.rows[i][j] += 1
        self.added += 1
        if self.added >= self.reset_at:
            self.rows = [[c >> 1 for c in row] for row in self.rows]
            self.added //= 2

    def estimate(self, key: int) -> int:
        return min(self.rows[i][j] for i, j in self.slots(key))


class WTinyLfu:
    """A 1% LRU window, then a main area (20% probation, 80% protected). A key leaving the
    window gets into the main area only if the sketch says it is more popular than the key
    the main area would evict."""

    def __init__(self, capacity: int) -> None:
        self.window_cap = max(1, capacity // 100)
        self.main_cap = capacity - self.window_cap
        self.protected_cap = self.main_cap * 8 // 10
        self.window, self.probation, self.protected = OrderedDict(), OrderedDict(), OrderedDict()
        self.sketch = Sketch(capacity)

    def access(self, key: int) -> bool:
        self.sketch.add(key)
        if key in self.window:
            self.window.move_to_end(key)
            return True
        if key in self.protected:
            self.protected.move_to_end(key)
            return True
        if key in self.probation:  # second hit in the main area: promote
            del self.probation[key]
            self.protected[key] = True
            if len(self.protected) > self.protected_cap:
                demoted, _ = self.protected.popitem(last=False)
                self.probation[demoted] = True
            return True
        self.window[key] = True
        if len(self.window) > self.window_cap:
            candidate, _ = self.window.popitem(last=False)
            if len(self.probation) + len(self.protected) < self.main_cap:
                self.probation[candidate] = True
            else:
                area = self.probation if self.probation else self.protected
                victim = next(iter(area))
                if self.sketch.estimate(candidate) > self.sketch.estimate(victim):
                    del area[victim]
                    self.probation[candidate] = True
                # else: the candidate is dropped and the victim stays
        return False


class S3Fifo:
    """Small FIFO (10%), main FIFO (90%) and a ghost FIFO of recently evicted keys (no values).
    A hit only bumps a 2-bit counter; nothing moves on a hit."""

    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.small_cap = max(1, capacity // 10)
        self.small, self.main, self.freq = deque(), deque(), {}
        self.ghost, self.ghost_cap = OrderedDict(), capacity - self.small_cap

    def access(self, key: int) -> bool:
        if key in self.freq:
            self.freq[key] = min(self.freq[key] + 1, 3)
            return True
        while len(self.small) + len(self.main) >= self.capacity:
            if len(self.small) >= self.small_cap or not self.main:
                self.evict_small()
            else:
                self.evict_main()
        self.freq[key] = 0
        if key in self.ghost:  # seen recently and evicted too early: straight to main
            del self.ghost[key]
            self.main.append(key)
        else:
            self.small.append(key)
        return False

    def evict_small(self) -> None:
        key = self.small.popleft()
        if self.freq[key] > 0:  # used again while in small: keep it
            self.freq[key] = 0
            self.main.append(key)
        else:  # a one-hit wonder: drop it, remember only the key
            del self.freq[key]
            self.ghost[key] = True
            if len(self.ghost) > self.ghost_cap:
                self.ghost.popitem(last=False)

    def evict_main(self) -> None:
        while True:
            key = self.main.popleft()
            if self.freq[key] > 0:  # second chance: reinsert with one less
                self.freq[key] -= 1
                self.main.append(key)
            else:
                del self.freq[key]
                return


POLICIES = {"LRU": Lru, "LFU": Lfu, "W-TinyLFU": WTinyLfu, "S3-FIFO": S3Fifo}


def zipf_cdf(n: int) -> list[float]:
    cdf, total = [], 0.0
    for k in range(1, n + 1):
        total += 1 / k
        cdf.append(total)
    return [c / total for c in cdf]


def traffic(scenario: str) -> list[tuple[int, bool]]:
    """(key, counts) pairs. counts=False for the batch job's reads."""
    rng, cdf, out, scan_key = Rng(SEED), zipf_cdf(KEYS), [], KEYS
    for i in range(REQUESTS):
        if scenario == "scans" and i % 2 == 1:  # a batch job interleaved with the traffic
            out.append((scan_key, False))
            scan_key += 1
        rank = bisect_right(cdf, rng.next())
        if scenario == "shift" and i >= REQUESTS // 2:
            rank = KEYS - 1 - rank
        out.append((rank, scenario != "shift" or i >= REQUESTS // 2))
    return out


def run(policy, requests: list[tuple[int, bool]]) -> float:
    hits = counted = 0
    warm = len(requests) // 10  # skip the first 10% while the cache fills
    for i, (key, counts) in enumerate(requests):
        hit = policy.access(key)
        if counts and i >= warm:
            counted += 1
            hits += hit
    return hits / counted


def main() -> None:
    cdf = zipf_cdf(KEYS)
    for scenario in ("steady", "scans", "shift"):
        print(f"\n{scenario}: hit ratio of the normal traffic")
        print(f"  {'cache size':<12}" + "".join(f"{n:>11}" for n in POLICIES) + f"{'best static':>13}")
        for pct in (1, 5, 10):
            capacity = KEYS * pct // 100
            requests = traffic(scenario)
            ratios = [run(make(capacity), requests) for make in POLICIES.values()]
            row = "".join(f"{100 * r:>10.1f}%" for r in ratios)
            print(f"  {f'{pct}% of keys':<12}{row}{100 * cdf[capacity - 1]:>12.1f}%")


if __name__ == "__main__":
    main()
