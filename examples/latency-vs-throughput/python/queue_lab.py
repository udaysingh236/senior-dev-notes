"""How latency grows with utilisation: a queue simulated request by request.

One server, random (Poisson) arrivals, 10 ms of work per request on average. For each utilisation
it simulates 200,000 requests and prints the measured mean latency next to the formula, then
checks Little's law and compares four separate queues with one shared queue for four servers.

Run: python queue_lab.py
"""
import math

S = 10.0  # mean service time, ms
N = 200_000


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


def simulate(utilisation: float, servers: int = 1, fixed_service: bool = False, seed: int = 42) -> tuple[float, float]:
    """Returns (mean latency in ms, time-averaged number in the system) for one shared FIFO queue."""
    rng = Rng(seed)
    arrival_gap = S / (utilisation * servers)
    free_at = [0.0] * servers  # when each server becomes free
    t = 0.0
    total_latency = 0.0
    events = []  # (time, +1 for an arrival or -1 for a departure)
    for _ in range(N):
        t += rng.exp(arrival_gap)
        k = min(range(servers), key=free_at.__getitem__)  # the server that frees up first
        start = max(t, free_at[k])
        service = S if fixed_service else rng.exp(S)
        free_at[k] = start + service
        total_latency += free_at[k] - t
        events += [(t, 1), (free_at[k], -1)]
    # Count how many requests are in the system at every moment, and average it over time.
    events.sort()
    area, count, last = 0.0, 0, 0.0
    for when, change in events:
        area += count * (when - last)
        count, last = count + change, when
    return total_latency / N, area / last


def main() -> None:
    print("One server, 10 ms of work per request on average")
    print(f"{'utilisation':>11}  {'measured':>9}  {'formula S/(1-u)':>15}  {'fixed-time work':>15}")
    for u in (0.5, 0.7, 0.8, 0.9, 0.95):
        mean, _ = simulate(u)
        fixed, _ = simulate(u, fixed_service=True)
        print(f"{u:>11.0%}  {mean:>7.1f} ms  {S / (1 - u):>12.1f} ms  {fixed:>12.1f} ms")

    mean, in_system = simulate(0.8)
    print(f"\nLittle's law at 80%: 0.08 requests/ms x {mean:.1f} ms = {0.08 * mean:.2f} predicted"
          f" in the system; counted over time: {in_system:.2f}")

    print("\nFour servers at 80% each")
    separate, _ = simulate(0.8)  # each server with its own queue is one M/M/1
    shared, _ = simulate(0.8, servers=4)
    print(f"  four separate queues: {separate:.1f} ms")
    print(f"  one shared queue:     {shared:.1f} ms")


if __name__ == "__main__":
    main()
