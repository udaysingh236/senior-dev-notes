"""Run every limiter on the same traffic and measure what actually got through.

All six are configured as "10 requests per 10 seconds" (bucket of 10 refilling at 1 per
second). For each traffic pattern we print how many requests were accepted and the most
that got through in any 10 s span and in any 1 s span.

Run:  python compare.py
"""

from __future__ import annotations

from limiters import (
    GCRA,
    FakeClock,
    FixedWindow,
    LeakyBucketQueue,
    SlidingLog,
    SlidingWindowCounter,
    TokenBucket,
)

LIMIT, WINDOW = 10, 10.0
RATE = LIMIT / WINDOW  # 1 request per second


def make_limiters(clock: FakeClock) -> dict[str, object]:
    return {
        "token bucket": TokenBucket(LIMIT, RATE, clock),
        "GCRA": GCRA(LIMIT, RATE, clock),
        "leaky bucket (queue)": LeakyBucketQueue(LIMIT, RATE, clock),
        "fixed window": FixedWindow(LIMIT, WINDOW, clock),
        "sliding log": SlidingLog(LIMIT, WINDOW, clock),
        "sliding counter": SlidingWindowCounter(LIMIT, WINDOW, clock),
    }


def peak(times: list[float], span: float) -> int:
    """Most timestamps inside any half-open interval [t, t + span)."""
    times = sorted(times)
    best, start = 0, 0
    for end, t in enumerate(times):
        while t - times[start] >= span - 1e-9:
            start += 1
        best = max(best, end - start + 1)
    return best


def boundary_attack() -> list[float]:
    """Ten requests just before a window boundary, ten right on it."""
    return [9.9] * 10 + [10.0] * 10


def bursty_overload() -> list[float]:
    """A burst of 6 requests every 2 seconds for a minute: 3 req/s on average, 3x the limit."""
    return [round(start + i * 0.05, 2) for start in range(0, 60, 2) for i in range(6)]


def late_burst_then_steady() -> list[float]:
    """Ten requests at the very end of one window, then one every 0.1 s through the next.
    This is the case the sliding counter's 'evenly spread' assumption gets wrong."""
    return [9.9] * 10 + [round(10 + i * 0.1, 1) for i in range(100)]


def run(name: str, arrivals: list[float]) -> None:
    clock = FakeClock()
    limiters = make_limiters(clock)
    passed: dict[str, list[float]] = {k: [] for k in limiters}
    for t in arrivals:
        clock.now = t
        for label, limiter in limiters.items():
            decision = limiter.try_acquire()
            if decision.allowed:
                # For the queue, what reaches the server is when the request leaves the queue.
                passed[label].append(t + decision.delay)

    print(f"\n{name}: {len(arrivals)} requests")
    print(f"  {'algorithm':<22}{'accepted':>9}{'peak in 10 s':>14}{'peak in 1 s':>13}")
    for label, times in passed.items():
        print(f"  {label:<22}{len(times):>9}{peak(times, 10):>14}{peak(times, 1):>13}")


if __name__ == "__main__":
    run("Boundary attack", boundary_attack())
    run("Bursty overload (6 every 2 s for 60 s)", bursty_overload())
    run("Late burst, then steady", late_burst_then_steady())
