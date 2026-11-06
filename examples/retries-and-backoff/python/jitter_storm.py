"""600 clients fail at the same moment and retry with exponential backoff, with and without jitter.

Retry k waits about 0.5 s × 2^(k-1), at most 6 retries. The server completes 60 attempts per
100 ms slot; attempts beyond that in a slot fail and back off again. The same model draws the
jitter diagram on the page, and js/jitter-storm.mjs prints the same numbers.

Run: python3 jitter_storm.py
"""

from __future__ import annotations

from typing import Callable

CLIENTS, PER_SLOT, SLOT_MS, BASE_MS, MAX_RETRIES, SLOTS = 600, 60, 100, 500, 6, 120
M32 = 0xFFFFFFFF


def mulberry32(seed: int) -> Callable[[], float]:
    """The same small seeded generator as the JavaScript twin, so both print identical runs."""
    state = seed & M32

    def imul(a: int, b: int) -> int:
        return (a * b) & M32

    def nxt() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & M32
        t = state
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return nxt


WAITS: dict[str, Callable[[float, Callable[[], float]], float]] = {
    "none": lambda d, r: d,                      # everyone waits exactly the same
    "±20%": lambda d, r: d * (0.8 + 0.4 * r()),  # gRPC's jitter
    "full": lambda d, r: r() * d,                # anywhere from 0 to d
}


def storm(kind: str) -> tuple[int, int, float, int]:
    r = mulberry32(7)
    pending = [(0.0, 0) for _ in range(CLIENTS)]  # (when the attempt is sent, retries so far)
    done = attempts = peak = 0
    last_done = 0
    for slot in range(SLOTS):
        lo, hi = slot * SLOT_MS, slot * SLOT_MS + SLOT_MS
        here = [c for c in pending if lo <= c[0] < hi]
        pending = [c for c in pending if c[0] >= hi]
        attempts += len(here)
        if slot > 0:
            peak = max(peak, len(here))
        for i in range(len(here) - 1, 0, -1):  # shuffle: who gets served is random
            j = int(r() * (i + 1))
            here[i], here[j] = here[j], here[i]
        for i, (_, retry) in enumerate(here):
            if i < PER_SLOT:
                done += 1
                last_done = hi
                continue
            retry += 1
            if retry > MAX_RETRIES:
                continue
            pending.append((hi + WAITS[kind](BASE_MS * 2 ** (retry - 1), r), retry))
    return done, attempts, last_done / 1000, peak


if __name__ == "__main__":
    print("jitter   done in 12 s   last success   attempts   busiest retry slot")
    for kind in WAITS:
        done, attempts, last, peak = storm(kind)
        print(f"{kind:<8} {done:>6}/600 {f'{last:g} s':>12} {attempts:>10,} {peak:>14}")
