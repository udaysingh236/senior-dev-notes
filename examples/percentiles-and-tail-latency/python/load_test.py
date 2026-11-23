"""Coordinated omission: a load test that waits for each answer hides a 1-second freeze.

A server answers each request in 10 ms, one at a time. From t = 5.0 s to t = 6.0 s it freezes
(think: a long garbage-collection pause). The test wants to send one request every 20 ms
(50 a second) for 10 seconds. Simulated time, so it runs instantly and prints the same every time.

Run: python3 load_test.py
"""
import math

SERVICE_MS = 10
INTERVAL_MS = 20
RUN_MS = 10_000
FREEZE_START, FREEZE_END = 5_000, 6_000


def server_finish(arrive: float, server_free_at: float) -> float:
    """When a request that arrives at `arrive` gets its answer (one request at a time)."""
    start = max(arrive, server_free_at)
    if FREEZE_START <= start < FREEZE_END:
        start = FREEZE_END  # frozen: nothing starts until the pause ends
    finish = start + SERVICE_MS
    if start < FREEZE_START < finish:
        finish += FREEZE_END - FREEZE_START  # the pause hits a request mid-way
    return finish


def p(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    return ordered[max(math.ceil(pct / 100 * len(ordered)), 1) - 1]


def closed_loop() -> list[float]:
    """Naive tester: send, WAIT for the answer, then send the next one.
    Latency is measured from when the request was actually sent."""
    latencies, now, free_at = [], 0.0, 0.0
    while now < RUN_MS:
        done = server_finish(now, free_at)
        free_at = done
        latencies.append(done - now)
        now = max(now + INTERVAL_MS, done)  # cannot send the next one before this answer
    return latencies


def open_loop() -> list[float]:
    """Correct tester: send on schedule whatever happens (like real users do).
    Latency is measured from when the request was SUPPOSED to be sent."""
    latencies, free_at = [], 0.0
    for planned in range(0, RUN_MS, INTERVAL_MS):
        done = server_finish(planned, free_at)
        free_at = done
        latencies.append(done - planned)
    return latencies


for name, lat in (("waits for each answer", closed_loop()), ("sends on schedule", open_loop())):
    slow = sum(1 for x in lat if x > 100)
    print(f"{name:22} {len(lat):4} requests   p50 {p(lat, 50):5.0f} ms   "
          f"p99 {p(lat, 99):5.0f} ms   max {max(lat):5.0f} ms   over 100 ms: {slow}")
