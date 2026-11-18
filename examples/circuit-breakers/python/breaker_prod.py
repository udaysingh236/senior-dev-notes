"""A production-shaped circuit breaker.

What it adds to breaker.py:
- a time window: the last 10 seconds in 1-second buckets, so old calls fall out on their own
- a minimum number of calls before it may open, so 1 failure out of 2 calls opens nothing
- a classifier: timeouts, connection errors and 5xx count; 4xx (the caller's own mistake) do not
- slow calls count as failures, so a dependency that answers in 2 s instead of hanging is caught
- several trial calls in half-open, all of which must succeed
- an open time that doubles after each failed trial, capped, with jitter so that many copies
  of the service do not all send their trials in the same instant
- a state-change hook for metrics and alerts

Run: python3 breaker_prod.py
"""

from __future__ import annotations

import random
from typing import Callable

from breaker import mulberry32


class Bucket:
    __slots__ = ("second", "calls", "failures")

    def __init__(self) -> None:
        self.second, self.calls, self.failures = -1, 0, 0


def counts_as_failure(status: int | None, elapsed_ms: float, slow_ms: float) -> bool:
    """status None means no answer: a timeout or a connection error."""
    if status is None or status >= 500:
        return True
    if 400 <= status < 500:
        return False   # bad input, wrong ID, no permission: Reviews is fine, the caller is not
    return elapsed_ms >= slow_ms


class ProductionBreaker:
    def __init__(self, *, window_s: int = 10, min_calls: int = 20, threshold: float = 0.5,
                 slow_ms: float = 1000, trials: int = 3, open_ms: float = 5000,
                 max_open_ms: float = 60_000, jitter: float = 0.2,
                 rand: Callable[[], float] = random.random,
                 on_change: Callable[[str, float, str], None] = lambda s, t, why: None):
        self.buckets = [Bucket() for _ in range(window_s)]
        self.min_calls, self.threshold, self.slow_ms = min_calls, threshold, slow_ms
        self.trials, self.base_open_ms, self.max_open_ms = trials, open_ms, max_open_ms
        self.jitter, self.rand, self.on_change = jitter, rand, on_change
        self.state, self.open_until, self.failed_trials = "closed", 0.0, 0
        self.trials_started = self.trials_passed = 0

    # -- the window ---------------------------------------------------------------------------
    def _bucket(self, now_ms: float) -> Bucket:
        second = int(now_ms // 1000)
        b = self.buckets[second % len(self.buckets)]
        if b.second != second:             # this slot held an old second: wipe it
            b.second, b.calls, b.failures = second, 0, 0
        return b

    def _totals(self, now_ms: float) -> tuple[int, int]:
        oldest = int(now_ms // 1000) - len(self.buckets) + 1
        live = [b for b in self.buckets if b.second >= oldest]
        return sum(b.calls for b in live), sum(b.failures for b in live)

    # -- the states ---------------------------------------------------------------------------
    def _open(self, now_ms: float, why: str) -> None:
        wait = min(self.max_open_ms, self.base_open_ms * 2 ** self.failed_trials)
        wait *= 1 - self.jitter + 2 * self.jitter * self.rand()   # ±20% by default
        self.state, self.open_until = "open", now_ms + wait
        self.on_change("open", now_ms, f"{why}; trying again in {wait / 1000:.1f} s")

    def allow(self, now_ms: float) -> bool:
        if self.state == "open" and now_ms >= self.open_until:
            self.state, self.trials_started, self.trials_passed = "half_open", 0, 0
            self.on_change("half_open", now_ms, f"letting {self.trials} trial calls through")
        if self.state == "closed":
            return True
        if self.state == "half_open" and self.trials_started < self.trials:
            self.trials_started += 1
            return True
        return False

    def record(self, status: int | None, elapsed_ms: float, now_ms: float) -> None:
        failed = counts_as_failure(status, elapsed_ms, self.slow_ms)
        if self.state == "half_open":
            if failed:
                self.failed_trials += 1
                self._open(now_ms, "a trial call failed")
            else:
                self.trials_passed += 1
                if self.trials_passed == self.trials:
                    self.state, self.failed_trials = "closed", 0
                    for b in self.buckets:
                        b.second = -1      # forget the outage
                    self.on_change("closed", now_ms, "every trial call succeeded")
            return
        if self.state != "closed":
            return
        b = self._bucket(now_ms)
        b.calls += 1
        b.failures += failed
        calls, failures = self._totals(now_ms)
        if calls >= self.min_calls and failures / calls >= self.threshold:
            self._open(now_ms, f"{failures} of the last {calls} calls failed")


if __name__ == "__main__":
    log = lambda state, now, why: print(f"  t={now / 1000:6.2f}s  -> {state:<9} ({why})")

    print("1. Every call returns 404 for 10 s (the caller asks for products that do not exist)")
    br = ProductionBreaker(on_change=log)
    for i in range(2000):
        br.allow(i * 5)
        br.record(404, 30, i * 5)
    print(f"  still {br.state}")

    print("2. Quiet traffic: 2 calls a second, and 3 of the first 4 fail")
    br = ProductionBreaker(on_change=log)
    for i, status in enumerate([503, 503, 200, 503] + [200] * 16):
        br.allow(i * 500)
        br.record(status, 40, i * 500)
    print(f"  still {br.state}: 4 calls are too few to judge")

    print("3. 200 calls a second; Reviews answers in 2.5 s (slow, not dead) from 10 s to 40 s")
    br = ProductionBreaker(rand=mulberry32(3), on_change=log)
    pending: list[tuple[float, float]] = []        # (ends at, elapsed)
    for i in range(60_000 // 5):
        t = i * 5
        pending.sort()
        while pending and pending[0][0] <= t:
            ends, elapsed = pending.pop(0)
            br.record(200, elapsed, ends)
        if br.allow(t):
            elapsed = 2500 if 10_000 <= t < 40_000 else 40
            pending.append((t + elapsed, elapsed))
