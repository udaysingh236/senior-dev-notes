"""A latency histogram: count requests into buckets, merge servers, estimate percentiles.

This is the production shape: each server keeps a few counters instead of every request,
the counters from many servers add up, and the percentile is estimated from the totals.

Run: python3 histogram.py
"""
import bisect
import math

# Upper edges of the buckets, in ms. The last bucket catches everything slower.
BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, math.inf]


class Histogram:
    def __init__(self) -> None:
        self.counts = [0] * len(BOUNDS_MS)

    def record(self, ms: float) -> None:
        self.counts[bisect.bisect_left(BOUNDS_MS, ms)] += 1

    def merge(self, other: "Histogram") -> None:
        # Merging is adding counts bucket by bucket. This is why histograms
        # combine and finished percentiles do not.
        self.counts = [a + b for a, b in zip(self.counts, other.counts)]

    def percentile(self, p: float) -> float:
        """Find the bucket holding the p-th percentile, then guess linearly inside it."""
        target = p / 100 * sum(self.counts)  # requests at or below the answer
        seen = 0
        for i, count in enumerate(self.counts):
            if seen + count >= target and count > 0:
                lower = BOUNDS_MS[i - 1] if i > 0 else 0
                upper = BOUNDS_MS[i]
                if math.isinf(upper):
                    return lower  # cannot guess inside an open-ended bucket
                return lower + (upper - lower) * (target - seen) / count
            seen += count
        return 0.0


def exact_percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return ordered[max(math.ceil(p / 100 * len(ordered)), 1) - 1]


def mulberry32(seed: int):  # same generator as percentiles.py, so JS prints the same numbers
    state = seed & 0xFFFFFFFF

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_float


rand = mulberry32(7)

# Server A: 9,000 requests, all fast. Server B: 1,000 requests, 150 of them slow (a bad disk).
servers = {
    "A": [20 + 30 * rand() for _ in range(9000)],
    "B": [600 + 300 * rand() if i < 150 else 20 + 30 * rand() for i in range(1000)],
}

fleet = Histogram()
all_values: list[float] = []
per_server_p99 = []
for name, values in servers.items():
    h = Histogram()
    for v in values:
        h.record(v)
    fleet.merge(h)
    all_values += values
    per_server_p99.append(h.percentile(99))
    print(f"server {name}: {len(values):5} requests   p99 about {h.percentile(99):6.0f} ms")

print(f"\naverage of the two p99s      {sum(per_server_p99) / 2:6.0f} ms   <- wrong: no request took this")
print(f"p99 of the merged histogram  {fleet.percentile(99):6.0f} ms   <- estimate from bucket counts")
print(f"exact p99 of all requests    {exact_percentile(all_values, 99):6.0f} ms   <- needs every value")
print(f"\nbucket counts kept: {len(BOUNDS_MS)} numbers per server instead of {len(all_values):,} values")
