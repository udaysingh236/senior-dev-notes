"""Circuit breakers two ways, in front of a Reviews service that goes down for 20 seconds.

1. naive: count every failure ever, and stop calling after 10
2. breaker: closed / open / half-open, deciding from the last 20 calls

The page service makes 200 calls a second to Reviews. Reviews is healthy (1 call in 1,000
fails) until t = 10 s, then every call hangs until the 300 ms timeout, then it recovers at
t = 30 s. Time is simulated, so the run takes well under a second; the breaker itself is what
you would ship, with the clock passed in so it can be tested.

Run: python3 breaker.py
"""

from __future__ import annotations

from collections import deque
from typing import Callable


def mulberry32(seed: int) -> Callable[[], float]:
    """Seeded generator shared with the JS twin, so both print the same numbers."""
    state = seed & 0xFFFFFFFF

    def imul(a: int, b: int) -> int:
        return (a * b) & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return nxt


# --- 1. Naive: count failures, stop after 10 -------------------------------------------------

class NaiveBreaker:
    def __init__(self, max_failures: int = 10):
        self.max_failures = max_failures
        self.failures = 0  # never reset, never forgets

    def allow(self, now_ms: float) -> bool:
        return self.failures < self.max_failures  # once off, off for ever

    def record(self, ok: bool, now_ms: float, trial: bool = False) -> None:
        if not ok:
            self.failures += 1


# --- 2. A circuit breaker: closed, open, half-open --------------------------------------------

class CircuitBreaker:
    """Opens when at least `threshold` of the last `window` calls failed.

    closed:    calls go through; each outcome goes into the window.
    open:      calls are refused at once, for `open_ms`.
    half_open: one trial call goes through; the rest are refused until it ends.
    """

    def __init__(self, window: int = 20, threshold: float = 0.5, open_ms: float = 5000,
                 on_change: Callable[[str, float], None] | None = None):
        self.window = window
        self.threshold = threshold
        self.open_ms = open_ms
        self.on_change = on_change or (lambda state, now: None)
        self.state = "closed"
        self.outcomes: deque[bool] = deque(maxlen=window)  # True = failed
        self.opened_at = 0.0
        self.trial_in_flight = False

    def _move(self, state: str, now_ms: float) -> None:
        self.state = state
        self.on_change(state, now_ms)

    def allow(self, now_ms: float) -> bool:
        """Ask before every call. False means: do not call, use the fallback."""
        if self.state == "open" and now_ms - self.opened_at >= self.open_ms:
            self._move("half_open", now_ms)
        if self.state == "closed":
            return True
        if self.state == "half_open" and not self.trial_in_flight:
            self.trial_in_flight = True  # this call is the trial
            return True
        return False

    def record(self, ok: bool, now_ms: float, trial: bool = False) -> None:
        """Report how an allowed call ended. `trial` marks the half-open trial call."""
        if trial:
            self.trial_in_flight = False
            if ok:
                self.outcomes.clear()  # start counting afresh
                self._move("closed", now_ms)
            else:
                self.opened_at = now_ms
                self._move("open", now_ms)
            return
        if self.state != "closed":
            return  # a call that started before the breaker opened; ignore it
        self.outcomes.append(not ok)
        full = len(self.outcomes) == self.window  # never decide from fewer calls
        if full and sum(self.outcomes) / self.window >= self.threshold:
            self.opened_at = now_ms
            self._move("open", now_ms)


# --- The simulation: 200 calls a second against a Reviews service that goes down ---------------

GAP_MS = 5          # one call every 5 ms = 200 calls a second
TIMEOUT_MS = 300    # the page's timeout on Reviews
DOWN_FROM, UP_AT = 10_000, 30_000


def reviews(start_ms: float, rand: Callable[[], float], outage: bool) -> tuple[bool, float]:
    """(succeeded, how long the call held a worker) for a call starting at start_ms."""
    if outage and DOWN_FROM <= start_ms < UP_AT:
        return False, TIMEOUT_MS                   # hangs until our timeout gives up
    if rand() < 0.001:
        return False, 40                           # the odd healthy-day error
    return True, 20 + 40 * rand()                  # 20-60 ms, 40 ms on average


def run(breaker, label: str, outage: bool = True, end_ms: float = 40_000) -> None:
    rand = mulberry32(7)
    pending: list[tuple[float, bool, bool]] = []   # (ends at, ok, was the trial)
    calls = refused = 0
    wait_ms_in_outage = 0.0
    t = 0.0
    while t < end_ms:
        # Calls that have ended report to the breaker, in the order they end.
        pending.sort()
        while pending and pending[0][0] <= t:
            ends, ok, trial = pending.pop(0)
            if breaker:
                breaker.record(ok, ends, trial)
        if breaker is None or breaker.allow(t):
            trial = getattr(breaker, "state", "") == "half_open"
            ok, held = reviews(t, rand, outage)
            pending.append((t + held, ok, trial))
            calls += 1
            if outage and DOWN_FROM <= t < UP_AT:
                wait_ms_in_outage += held
        else:
            refused += 1                           # fallback: page without reviews, at once
        t += GAP_MS
    outage_s = (UP_AT - DOWN_FROM) / 1000
    waiting = f"   workers waiting on Reviews in the outage: {wait_ms_in_outage / 1000 / outage_s:5.1f}"
    print(f"{label:<10} calls made {calls:>7,}   refused {refused:>7,}" + (waiting if outage else ""))


if __name__ == "__main__":
    log = lambda state, now: print(f"  t={now / 1000:6.3f}s  breaker -> {state}")
    print("40 s, Reviews down from 10 s to 30 s")
    run(None, "none")
    run(NaiveBreaker(), "naive")
    print("Circuit breaker (last 20 calls, open at 50%, 5 s open):")
    run(CircuitBreaker(on_change=log), "breaker")
    print("\n10 healthy minutes, 1 call in 1,000 fails, no outage at all")
    run(NaiveBreaker(), "naive", outage=False, end_ms=600_000)
    run(CircuitBreaker(on_change=log), "breaker", outage=False, end_ms=600_000)
