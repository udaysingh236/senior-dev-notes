"""The rate limiter most of us write first, and four ways it lets the wrong traffic through.

Standard library only. Nothing here touches the network: the demos call the limiter
directly, so the run is instant and gives the same numbers every time.

Run:  python naive_limiter.py
"""

from __future__ import annotations

import threading
import time
from http.server import BaseHTTPRequestHandler

LIMIT, WINDOW = 10, 10  # 10 requests per 10 seconds


class NaiveLimiter:
    """A dict of counters in this process's memory, keyed by (client, window number)."""

    def __init__(self) -> None:
        self.counts: dict[tuple[str, int], int] = {}  # never cleaned up: it grows forever

    def allow(self, client: str, now: float) -> bool:
        key = (client, int(now // WINDOW))
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key] <= LIMIT


limiter = NaiveLimiter()


class Handler(BaseHTTPRequestHandler):
    """How it usually gets wired in: keyed on the address of whoever opened the connection."""

    def do_GET(self) -> None:
        if not limiter.allow(self.client_address[0], time.time()):
            self.send_response(429)
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok\n")


def demo_boundary() -> None:
    lim = NaiveLimiter()
    passed = sum(lim.allow("203.0.113.7", 9.9) for _ in range(10))
    passed += sum(lim.allow("203.0.113.7", 10.0) for _ in range(10))
    print(f"1. window boundary: {passed} of 20 accepted within 0.1 s (limit is {LIMIT} per {WINDOW} s)")


def demo_four_servers() -> None:
    servers = [NaiveLimiter() for _ in range(4)]  # four copies of the app behind a load balancer
    passed = sum(servers[i % 4].allow("203.0.113.7", 1.0) for i in range(40))  # round robin
    print(f"2. four servers:    {passed} of 40 accepted in one window (each server counted alone)")


def demo_behind_proxy() -> None:
    lim = NaiveLimiter()
    load_balancer_ip = "10.0.0.5"  # what client_address shows when a proxy opened the connection
    results = {user: sum(lim.allow(load_balancer_ip, 1.0) for _ in range(5)) for user in ("asha", "ben", "chen")}
    shown = ", ".join(f"{user} {n}/5" for user, n in results.items())
    print(f"3. behind a proxy:  accepted {shown} - three users share one counter")


class SlowStore:
    """A shared counter store with a network round trip on every call, like Redis over a LAN."""

    def __init__(self, round_trip: float = 0.005) -> None:
        self.data: dict[str, int] = {}
        self.round_trip = round_trip

    def get(self, key: str) -> int:
        time.sleep(self.round_trip)
        return self.data.get(key, 0)

    def set(self, key: str, value: int) -> None:
        time.sleep(self.round_trip)
        self.data[key] = value


def demo_race() -> None:
    store, accepted = SlowStore(), []
    start = threading.Barrier(20)

    def handle_request() -> None:
        start.wait()  # twenty requests arrive at the same moment, on different threads
        count = store.get("203.0.113.7:0")  # check...
        if count < LIMIT:
            store.set("203.0.113.7:0", count + 1)  # ...then act: someone else read the same count
            accepted.append(True)

    threads = [threading.Thread(target=handle_request) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print(f"4. shared store:    {len(accepted)} of 20 accepted, and the stored count says {store.data['203.0.113.7:0']}")


if __name__ == "__main__":
    demo_boundary()
    demo_four_servers()
    demo_behind_proxy()
    demo_race()
