"""Six rate limiting algorithms, in-process, standard library only.

Every limiter takes an injectable clock, so the same code runs against real time in a server
and against a fake clock in tests and in compare.py. Each `try_acquire()` returns a Decision
the HTTP layer can turn into a 429 with Retry-After.

Run the self-checks:  python limiters.py
"""

from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

Clock = Callable[[], float]  # returns seconds


@dataclass(frozen=True)
class Decision:
    allowed: bool
    remaining: int  # requests still available right now
    retry_after: float = 0.0  # seconds until a request could pass; 0 when allowed
    delay: float = 0.0  # leaky bucket queue only: how long this request waits before it runs


class TokenBucket:
    """Bucket of `capacity` tokens, refilled at `rate` tokens per second. One request = one token.

    The refill is computed lazily from elapsed time, so no background timer is needed and the
    whole state is two numbers: tokens and the time we last looked.
    """

    def __init__(self, capacity: int, rate: float, clock: Clock = time.monotonic) -> None:
        self.capacity = capacity
        self.rate = rate
        self.clock = clock
        self.tokens = float(capacity)  # start full: a new client may burst immediately
        self.updated = clock()

    def try_acquire(self, cost: int = 1) -> Decision:
        now = self.clock()
        elapsed = max(0.0, now - self.updated)  # never refill backwards if the clock jumps
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.updated = now
        # A tiny tolerance: ten refills of 0.1 add up to 0.9999999999999999, not 1.0.
        if self.tokens + 1e-9 >= cost:
            self.tokens = max(0.0, self.tokens - cost)
            return Decision(True, math.floor(self.tokens))
        return Decision(False, 0, retry_after=(cost - self.tokens) / self.rate)


class LeakyBucketQueue:
    """Leaky bucket as a queue: requests wait their turn and leave at exactly `rate` per second.

    Instead of a real queue we track `next_free`, the moment the next request may run. The
    queue depth is how far that moment is in the future, times the rate.
    """

    def __init__(self, capacity: int, rate: float, clock: Clock = time.monotonic) -> None:
        self.capacity = capacity
        self.rate = rate
        self.clock = clock
        self.next_free = clock()

    def try_acquire(self) -> Decision:
        now = self.clock()
        start = max(self.next_free, now)
        waiting = (start - now) * self.rate  # requests already queued ahead of this one
        if waiting + 1 > self.capacity + 1e-9:
            return Decision(False, 0, retry_after=(waiting + 1 - self.capacity) / self.rate)
        self.next_free = start + 1 / self.rate
        return Decision(True, math.floor(self.capacity - waiting - 1), delay=start - now)


class GCRA:
    """Generic cell rate algorithm: a token bucket stored as ONE timestamp.

    `tat` (theoretical arrival time) is when the bucket would be full again if no more
    requests came. Each request pushes it forward by one emission interval (1 / rate).
    A request is allowed while `tat` is no more than `burst` intervals in the future.
    """

    def __init__(self, burst: int, rate: float, clock: Clock = time.monotonic) -> None:
        self.interval = 1 / rate
        self.tolerance = burst * self.interval  # how far ahead of now tat may run
        self.clock = clock
        self.tat = clock()

    def try_acquire(self) -> Decision:
        now = self.clock()
        new_tat = max(self.tat, now) + self.interval
        allow_at = new_tat - self.tolerance
        if now + 1e-9 < allow_at:
            return Decision(False, 0, retry_after=allow_at - now)
        self.tat = new_tat
        remaining = math.floor((self.tolerance - (new_tat - now)) / self.interval + 1e-9)
        return Decision(True, remaining)


class FixedWindow:
    """At most `limit` requests per window of `window` seconds, windows aligned to the clock."""

    def __init__(self, limit: int, window: float, clock: Clock = time.monotonic) -> None:
        self.limit = limit
        self.window = window
        self.clock = clock
        self.current = -1  # window number
        self.count = 0

    def try_acquire(self) -> Decision:
        now = self.clock()
        number = math.floor(now / self.window)
        if number != self.current:  # a new window: the count starts again from zero
            self.current, self.count = number, 0
        if self.count < self.limit:
            self.count += 1
            return Decision(True, self.limit - self.count)
        window_ends = (number + 1) * self.window
        return Decision(False, 0, retry_after=window_ends - now)


class SlidingLog:
    """Exact: keep the timestamp of every accepted request in the last `window` seconds."""

    def __init__(self, limit: int, window: float, clock: Clock = time.monotonic) -> None:
        self.limit = limit
        self.window = window
        self.clock = clock
        self.log: deque[float] = deque()

    def try_acquire(self) -> Decision:
        now = self.clock()
        while self.log and self.log[0] <= now - self.window:
            self.log.popleft()  # older than the window: forget it
        if len(self.log) < self.limit:
            self.log.append(now)
            return Decision(True, self.limit - len(self.log))
        return Decision(False, 0, retry_after=self.log[0] + self.window - now)


class SlidingWindowCounter:
    """Approximate sliding window from two fixed-window counters.

    estimate = previous_count * (share of the previous window still inside the sliding
    window) + current_count. It assumes the previous window's requests were evenly spread.
    """

    def __init__(self, limit: int, window: float, clock: Clock = time.monotonic) -> None:
        self.limit = limit
        self.window = window
        self.clock = clock
        self.current = -1
        self.current_count = 0
        self.previous_count = 0

    def estimate(self, now: float) -> float:
        number = math.floor(now / self.window)
        if number != self.current:
            # Moved on by one window: current becomes previous. Moved on by more: both empty.
            self.previous_count = self.current_count if number == self.current + 1 else 0
            self.current, self.current_count = number, 0
        elapsed = (now - number * self.window) / self.window  # 0.0 at the start, ~1.0 at the end
        return self.previous_count * (1 - elapsed) + self.current_count

    def try_acquire(self) -> Decision:
        now = self.clock()
        estimate = self.estimate(now)
        if estimate + 1 <= self.limit + 1e-9:
            self.current_count += 1
            return Decision(True, math.floor(self.limit - estimate - 1))
        # The estimate falls as the previous window slides out; solve for when it fits again.
        need = estimate + 1 - self.limit
        if self.previous_count:
            wait = need / self.previous_count * self.window
        else:
            wait = (self.current + 1) * self.window - now
        return Decision(False, 0, retry_after=wait)


class FakeClock:
    """A clock you move by hand, so tests and comparisons are exact and instant."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


def _self_check() -> None:
    clock = FakeClock()

    # Token bucket: 10 tokens, 5 per second. A burst of 40 in one instant gets 10 through.
    bucket = TokenBucket(capacity=10, rate=5, clock=clock)
    burst = sum(bucket.try_acquire().allowed for _ in range(40))
    clock.now += 1.0
    after_1s = sum(bucket.try_acquire().allowed for _ in range(40))
    print(f"token bucket  C=10 r=5/s: burst of 40 -> {burst} pass, one second later {after_1s} more")

    # GCRA gives the same answers as the token bucket with one number of state.
    clock.now = 0.0
    gcra = GCRA(burst=10, rate=5, clock=clock)
    g_burst = sum(gcra.try_acquire().allowed for _ in range(40))
    clock.now += 1.0
    g_after = sum(gcra.try_acquire().allowed for _ in range(40))
    print(f"GCRA          burst=10 r=5/s: burst of 40 -> {g_burst} pass, one second later {g_after} more")

    # Fixed window: 10 per 10 s. Ten at 9.9 s and ten at 10.0 s all pass.
    clock.now = 9.9
    window = FixedWindow(limit=10, window=10, clock=clock)
    first = sum(window.try_acquire().allowed for _ in range(10))
    clock.now = 10.0
    second = sum(window.try_acquire().allowed for _ in range(10))
    print(f"fixed window  10 per 10 s: {first} at t=9.9 s + {second} at t=10.0 s = {first + second} in 0.1 s")

    # Sliding window counter, with numbers you can check by hand:
    # previous window 80, current 30, 40% of the way in -> 80 * 0.6 + 30 = 78.
    clock.now = 0.0
    counter = SlidingWindowCounter(limit=100, window=60, clock=clock)
    counter.estimate(60.0)  # roll into window 1
    counter.current_count = 80
    counter.estimate(120.0)  # roll into window 2: previous = 80
    counter.current_count = 30
    clock.now = 120 + 0.4 * 60
    print(f"sliding counter: prev 80, curr 30, 40% in -> estimate {counter.estimate(clock.now):.1f}")

    # Leaky bucket queue: 5 slots draining 1 per second. A burst of 8: 5 queue, 3 rejected.
    clock.now = 0.0
    leaky = LeakyBucketQueue(capacity=5, rate=1, clock=clock)
    results = [leaky.try_acquire() for _ in range(8)]
    delays = [round(r.delay, 1) for r in results if r.allowed]
    print(f"leaky queue   5 slots, 1/s: burst of 8 -> waits {delays}, {sum(not r.allowed for r in results)} rejected")


if __name__ == "__main__":
    _self_check()
