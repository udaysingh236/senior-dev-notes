"""Many balancers, one pool: how each picking rule copes with a slow backend and a partial view.

Eight backends serve one request at a time, 10 ms of work on average (random, exponential).
Backend 0 is three times slower. Requests arrive at random, each through one of B balancers.
Every rule sees the same arrivals and the same work per request. Rules:

  round robin       each balancer cycles through the backends on its own
  least (stale)     everyone reads one shared table of in-flight counts, refreshed every 500 ms,
                    and picks the smallest
  P2C (stale)       the same stale table, but compare two random backends
  P2C (own)         each balancer compares two random backends by its own in-flight requests
  peak EWMA (own)   each balancer compares two by (its latency estimate) x (its in-flight + 1)

Run: python fleet.py
"""
import heapq
import math

N, SERVICE_MS, SLOW = 8, 10.0, 3.0
CAPACITY = (N - 1) / SERVICE_MS + 1 / (SERVICE_MS * SLOW)  # requests per ms the pool can finish


class Rng:
    """mulberry32, the same generator as the JavaScript version, so both print the same numbers."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    def exp(self, mean: float) -> float:
        return -math.log(1 - self.next()) * mean

    def below(self, n: int) -> int:
        return int(self.next() * n)


def two(rng: Rng) -> tuple[int, int]:
    a = rng.below(N)
    b = rng.below(N - 1)
    return a, (b + 1 if b >= a else b)


class PeakEwma:
    """Latency estimate: jumps up to a slower sample at once, eases down on faster ones,
    and fades towards zero while no samples arrive, so a backend that was slow gets retried."""

    TAU_MS, ALPHA = 1000.0, 0.3

    def __init__(self) -> None:
        self.value, self.at = SERVICE_MS, 0.0

    def read(self, now: float) -> float:  # fades towards zero between samples
        return self.value * math.exp(-(now - self.at) / self.TAU_MS)

    def observe(self, sample: float, now: float) -> None:
        current = self.read(now)  # up at once, down slowly
        self.value = sample if sample > current else current + self.ALPHA * (sample - current)
        self.at = now


def pick_peak_ewma(ewma: list[PeakEwma], own: list[int], now: float, rng: Rng) -> int:
    a, b = two(rng)  # two different random backends
    cost = lambda i: ewma[i].read(now) * (own[i] + 1)
    return a if cost(a) <= cost(b) else b


def run(rule: str, balancers: int, load: float, refresh_ms: float = 500.0, seconds: int = 60) -> tuple[float, float, float]:
    """Returns (p50 ms, p99 ms, % of requests sent to the slow backend). refresh_ms 0 = a live table."""
    arrivals, work = Rng(7), Rng(11)
    rng = Rng(42)
    free_at = [0.0] * N
    inflight = [0] * N                                   # true counts
    own = [[0] * N for _ in range(balancers)]            # each balancer's own counts
    ewma = [[PeakEwma() for _ in range(N)] for _ in range(balancers)]
    table, next_refresh = [0] * N, 0.0                   # the shared, stale view
    rr = [b % N for b in range(balancers)]
    done: list[tuple[float, int, int, float]] = []       # (finish time, backend, balancer, latency)
    latencies, sent = [], [0] * N
    t = 0.0
    while t < seconds * 1000:
        t += arrivals.exp(1 / (load * CAPACITY))
        lb, base = arrivals.below(balancers), work.exp(SERVICE_MS)

        def finish_until(when: float) -> None:
            while done and done[0][0] <= when:
                at, k, b, lat = heapq.heappop(done)
                inflight[k] -= 1
                own[b][k] -= 1
                ewma[b][k].observe(lat, at)

        while refresh_ms and next_refresh <= t:
            finish_until(next_refresh)
            table, next_refresh = inflight[:], next_refresh + refresh_ms
        finish_until(t)
        if not refresh_ms:
            table = inflight  # a live view: every balancer reads the true counts

        if rule == "round robin":
            k = rr[lb]
            rr[lb] = (k + 1) % N
        elif rule == "least (stale)":
            low = min(table)
            ties = [i for i in range(N) if table[i] == low]
            k = ties[rng.below(len(ties))]
        elif rule == "P2C (stale)":
            a, b = two(rng)
            k = a if table[a] <= table[b] else b
        elif rule == "P2C (own)":
            a, b = two(rng)
            k = a if own[lb][a] <= own[lb][b] else b
        else:  # peak EWMA (own)
            k = pick_peak_ewma(ewma[lb], own[lb], t, rng)

        service = base * (SLOW if k == 0 else 1)
        start = max(t, free_at[k])
        free_at[k] = start + service
        inflight[k] += 1
        own[lb][k] += 1
        sent[k] += 1
        heapq.heappush(done, (free_at[k], k, lb, free_at[k] - t))
        if t > 5000:  # skip the first 5 s while queues settle
            latencies.append(free_at[k] - t)

    latencies.sort()
    return latencies[len(latencies) // 2], latencies[int(len(latencies) * 0.99)], 100 * sent[0] / sum(sent)


def main() -> None:
    rules = ["round robin", "least (stale)", "P2C (stale)", "P2C (own)", "peak EWMA (own)"]
    print("8 backends, 10 ms of work each; backend 0 is 3x slower (its fair share is 4.5%)")
    for balancers in (1, 50):
        print(f"\n{balancers} balancer{'s' if balancers > 1 else ''}, 70% of pool capacity, shared table 500 ms old:")
        for rule in rules:
            p50, p99, slow = run(rule, balancers, 0.7)
            print(f"  {rule:<16} p50 {p50:>7.1f} ms   p99 {p99:>8.1f} ms   slow backend got {slow:>4.1f}%")
    print("\nOne balancer, 70% load: p99 as the shared table gets older")
    for refresh in (0, 20, 100, 500):
        least, p2c = run("least (stale)", 1, 0.7, refresh)[1], run("P2C (stale)", 1, 0.7, refresh)[1]
        print(f"  {'live' if not refresh else f'{refresh} ms old':>10}   least {least:>7.1f} ms   P2C {p2c:>6.1f} ms")


if __name__ == "__main__":
    main()
