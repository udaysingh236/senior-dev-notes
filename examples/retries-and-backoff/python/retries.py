"""Retries three ways, against a dependency that fails 5%, 20% or 100% of the time.

1. naive: retry at once, on any exception
2. backoff: only transient errors, capped exponential backoff with full jitter, inside a deadline
3. budget: the same, plus a retry budget that lets retries add at most 10% to the load

The dependency and the clock are fakes so the run takes a second, not minutes: `sleep` moves a
virtual clock forward instead of waiting. The retry code itself is what you would ship.

Run: python3 retries.py
"""

from __future__ import annotations

import random
import threading
import time
from typing import Callable, TypeVar

from jitter_storm import mulberry32  # seeded generator shared with the JS twin

T = TypeVar("T")


class TransientError(Exception):
    """Worth retrying: a timeout, a reset connection, 503, 429. May carry the server's Retry-After."""

    def __init__(self, message: str = "", retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class PermanentError(Exception):
    """Not worth retrying: 400, 403, 404, 422. A second try repeats the mistake."""


# --- 1. Naive: what most retry loops look like -------------------------------------------------

def call_naive(fn: Callable[[], T], retries: int = 3) -> T:
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception:  # retries bugs and bad input too
            if attempt == retries:
                raise
    raise AssertionError("unreachable")
    # No wait between tries and no deadline: every client hits the server again at once.


# --- 2. Correct: classify, back off with full jitter, respect the deadline ---------------------

def backoff_delay(retry: int, base: float, cap: float, rand: Callable[[], float] = random.random) -> float:
    """Full jitter: anywhere between 0 and the capped exponential (base, 2×base, 4×base...)."""
    return rand() * min(cap, base * 2 ** (retry - 1))


class RetryBudget:
    """Retries may add at most `ratio` extra load. Share one per client process and dependency."""

    def __init__(self, ratio: float = 0.1, max_tokens: float = 10.0):
        self.ratio, self.max_tokens, self.tokens = ratio, max_tokens, max_tokens
        self._lock = threading.Lock()

    def on_request(self) -> None:  # every new request earns a fraction of a retry
        with self._lock:
            self.tokens = min(self.max_tokens, self.tokens + self.ratio)

    def try_spend(self) -> bool:  # every retry costs a whole one
        with self._lock:
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True


def call_with_retries(
    fn: Callable[[], T],
    *,
    deadline: float,  # a time.monotonic() value: the caller's whole budget
    retries: int = 3,
    base: float = 0.1,
    cap: float = 2.0,
    budget: RetryBudget | None = None,
    rand: Callable[[], float] = random.random,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    if budget:
        budget.on_request()
    retry = 0
    while True:
        try:
            return fn()
        except TransientError as err:  # PermanentError and bugs propagate on the first try
            retry += 1
            if retry > retries:
                raise
            delay = max(err.retry_after or 0.0, backoff_delay(retry, base, cap, rand))
            if clock() + delay >= deadline:
                raise  # the caller will have given up before the next answer arrives
            if budget and not budget.try_spend():
                raise  # many attempts are failing: fail fast, don't add load
            sleep(delay)


# --- The demo ------------------------------------------------------------------------------------

class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def run(policy: str, failure_rate: float, requests: int = 10_000) -> tuple[float, float]:
    failures = mulberry32(7)  # the same failures for every policy, and the same as the JS twin
    jitter = mulberry32(8)
    clock = FakeClock()
    budget = RetryBudget(ratio=0.1) if policy == "budget" else None
    attempts = ok = 0

    def dependency() -> str:
        nonlocal attempts
        attempts += 1
        if failures() < failure_rate:
            raise TransientError("503 Service Unavailable")
        return "200 OK"

    for _ in range(requests):
        try:
            if policy == "naive":
                call_naive(dependency)
            else:
                call_with_retries(dependency, deadline=clock.now + 5.0, budget=budget,
                                  rand=jitter, clock=lambda: clock.now, sleep=clock.sleep)
            ok += 1
        except TransientError:
            pass
    return ok / requests, attempts / requests


if __name__ == "__main__":
    print(f"{'failing':>8}  {'policy':<8} {'succeeded':>10} {'attempts/request':>17}")
    for failure_rate in (0.05, 0.20, 1.00):
        for policy in ("naive", "backoff", "budget"):
            success, amplification = run(policy, failure_rate)
            print(f"{failure_rate:>8.0%}  {policy:<8} {success:>10.2%} {amplification:>17.2f}")
