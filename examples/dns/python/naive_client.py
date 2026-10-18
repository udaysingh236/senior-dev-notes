"""Two naive ways to use DNS, and how each one breaks.

1. Resolve once at startup and keep the address for ever.
2. Resolve before every single request, with no cache.

Run: python naive_client.py   (about 5 seconds; starts its own toy DNS server)
"""

from __future__ import annotations

import dnswire as w
from demo import API, DNS, migrate, retire_old, start


def resolve(name: str) -> tuple[str, int]:
    """Ask the DNS server directly; return the first address and its TTL."""
    _, query = w.build_query(name, "A")
    reply = w.parse_message(w.ask_udp(*DNS, query))
    record = next(r for r in reply.answer if r.type == "A")
    return record.value, record.ttl


class ResolveOnceClient:
    """Naive 1: look the name up when the process starts, then never again."""

    def __init__(self) -> None:
        self.address, ttl = resolve(API)  # the TTL is right here, and we throw it away
        print(f"t=0.0s  [ once] startup: {API} -> {self.address} (TTL {ttl} s, ignored)")

    def address_for_request(self) -> str:
        return self.address


class ResolveEveryTimeClient:
    """Naive 2: ask DNS before every request. Always fresh, and a lookup on every request."""

    def __init__(self) -> None:
        self.lookups = 0

    def address_for_request(self) -> str:
        self.lookups += 1
        return resolve(API)[0]


def main() -> None:
    ttl = 2
    zone, server, fleet, clock = start(api_ttl=ttl)
    once, every = ResolveOnceClient(), ResolveEveryTimeClient()

    for i in range(10):  # one request from each client every 0.45 s
        clock.sleep_until(i * 0.45)
        if i == 2:
            migrate(zone, fleet, clock, ttl)
        if i == 8:  # 2.7 s after the change: every cache that respects the 2 s TTL has moved
            retire_old(fleet, clock)
        for label, client in (("once", once), ("every", every)):
            address = client.address_for_request()
            print(f"{clock.stamp()}  [{label:>5}] request {i + 1:2} -> {address:<14} {fleet.call(address)}")

    print(f"\nresolve-every-time made {every.lookups} DNS lookups for 10 requests;"
          f" the server answered {zone.queries} queries in total.")
    print("At 2,000 requests per second, that is 2,000 DNS queries per second, all from one client.")
    server.close()


if __name__ == "__main__":
    main()
