"""Shared scaffolding for the demos: a toy DNS server, pretend API servers, and a clock.

The DNS traffic in every demo is real (UDP and TCP packets to the toy server on localhost). The
API servers are pretend: a set of addresses that are "up", so we can switch the old one off.
"""

from __future__ import annotations

import time

from toy_server import ToyServer, Zone

OLD, NEW = "203.0.113.10", "198.51.100.20"  # documentation addresses (RFC 5737), never real hosts
API = "api.shop.example.test."
DNS = ("127.0.0.1", 8053)


class Fleet:
    """Which API server addresses are switched on."""

    def __init__(self) -> None:
        self.up = {OLD}

    def call(self, address: str) -> str:
        return "200 OK" if address in self.up else "FAILED: connection refused (nothing runs there now)"


class Clock:
    def __init__(self) -> None:
        self.start = time.monotonic()

    def now(self) -> float:
        return time.monotonic() - self.start

    def stamp(self) -> str:
        return f"t={self.now():3.1f}s"

    def sleep_until(self, t: float) -> None:
        time.sleep(max(0.0, t - self.now()))


def start(api_ttl: int = 2) -> tuple[Zone, ToyServer, Fleet, Clock]:
    zone = Zone(api_ttl=api_ttl)
    return zone, ToyServer(zone, port=DNS[1]), Fleet(), Clock()


def migrate(zone: Zone, fleet: Fleet, clock: Clock, ttl: int) -> None:
    """The operator's side of a move: start the new server, point DNS at it."""
    fleet.up.add(NEW)
    zone.set(API, "A", [NEW], ttl)
    print(f"{clock.stamp()}  operator: new server is up, api now points to {NEW}")


def retire_old(fleet: Fleet, clock: Clock) -> None:
    fleet.up.discard(OLD)
    print(f"{clock.stamp()}  operator: waited longer than the TTL, switching off the old server {OLD}")
