"""Average vs percentiles, then fan-out: why one slow call in 100 slows most pages.

Run: python3 percentiles.py
"""
import math


# ---- 1. The ten requests from the page -----------------------------------------------------
ten_ms = [45, 52, 40, 2000, 48, 55, 42, 60, 50, 45]


def average(values: list[float]) -> float:
    """The naive summary: add everything up, divide by how many."""
    return sum(values) / len(values)


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile: sort, then take the value at rank ceil(p/100 * n)."""
    ordered = sorted(values)
    rank = math.ceil(p / 100 * len(ordered))  # 1-based rank
    return ordered[max(rank, 1) - 1]


print("ten requests, sorted:", sorted(ten_ms))
print(f"average  {average(ten_ms):7.1f} ms   <- nobody waited this long")
for p in (50, 90, 100):
    print(f"p{p:<3}     {percentile(ten_ms, p):7.1f} ms")


# ---- 2. A seeded random generator, identical in the Python and JavaScript versions ----------
def mulberry32(seed: int):
    state = seed & 0xFFFFFFFF

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_float


rand = mulberry32(42)


def one_call() -> float:
    """One backend call: 99 in 100 take 20-50 ms, 1 in 100 takes 500-1,500 ms."""
    if rand() < 0.01:
        return 500 + 1000 * rand()
    return 20 + 30 * rand()


# ---- 3. Fan-out: a page waits for its slowest call -------------------------------------------
PAGES = 100_000
print(f"\n{PAGES:,} pages, each calling N backends in parallel (page time = slowest call)")
print("    N   page p50   page p99   pages over 100 ms   predicted 1 - 0.99^N")
for n in (1, 10, 100):
    pages = [max(one_call() for _ in range(n)) for _ in range(PAGES)]
    slow = sum(1 for t in pages if t > 100) / PAGES
    print(f"  {n:3}   {percentile(pages, 50):5.0f} ms   {percentile(pages, 99):5.0f} ms"
          f"   {slow:16.1%}   {1 - 0.99 ** n:18.1%}")


# ---- 4. Hedging: if a call is not back after 50 ms, ask a second copy and take the first answer
def hedged_call(hedge_after_ms: float = 50) -> tuple[float, int]:
    first = one_call()
    if first <= hedge_after_ms:
        return first, 1
    second = hedge_after_ms + one_call()  # the backup starts late
    return min(first, second), 2


print("\nN = 10 with hedging after 50 ms")
calls = 0
pages = []
for _ in range(PAGES):
    slowest = 0.0
    for _ in range(10):
        t, sent = hedged_call()
        calls += sent
        slowest = max(slowest, t)
    pages.append(slowest)
slow = sum(1 for t in pages if t > 100) / PAGES
print(f"   10   {percentile(pages, 50):5.0f} ms   {percentile(pages, 99):5.0f} ms   {slow:16.1%}"
      f"   extra calls sent: {calls / (PAGES * 10) - 1:.1%}")
