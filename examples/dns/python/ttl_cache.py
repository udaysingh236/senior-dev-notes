"""The correct version: a cache that keeps each answer exactly as long as its TTL allows,
including negative answers ("no such name"), whose lifetime comes from the zone's SOA (RFC 2308).

Run: python ttl_cache.py   (about 10 seconds; starts its own toy DNS server)
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import dnswire as w
from demo import API, DNS, NEW, OLD, migrate, retire_old, start


class NameNotFound(Exception):
    pass


@dataclass
class Entry:
    addresses: list[str]  # empty means a cached "no"
    rcode: str
    expires: float        # time.monotonic() when this entry stops being usable


class CachingResolver:
    def __init__(self, server: tuple[str, int]):
        self.server = server
        self.cache: dict[tuple[str, str], Entry] = {}
        self.hits = self.misses = 0

    def resolve(self, name: str, rtype: str = "A") -> list[str]:
        key = (name.lower(), rtype)
        entry = self.cache.get(key)
        if entry and time.monotonic() < entry.expires:
            self.hits += 1
        else:
            self.misses += 1
            entry = self._ask(name, rtype)
            self.cache[key] = entry
        if not entry.addresses:
            raise NameNotFound(f"{entry.rcode}, cached for {entry.expires - time.monotonic():.1f} s more")
        return entry.addresses

    def _ask(self, name: str, rtype: str) -> Entry:
        _, query = w.build_query(name, rtype)
        reply = w.parse_message(w.ask_udp(*self.server, query))
        now = time.monotonic()
        # Follow any CNAMEs in the answer; the chain is only as fresh as its shortest-lived link.
        records = [r for r in reply.answer if r.type in (rtype, "CNAME")]
        addresses = [r.value for r in records if r.type == rtype]
        if reply.rcode == "NOERROR" and addresses:
            return Entry(addresses, "NOERROR", now + min(r.ttl for r in records))
        # NXDOMAIN (no such name) or NODATA (name exists, no records of this type).
        # Negative TTL = the smaller of the SOA record's TTL and its MINIMUM field (RFC 2308).
        soa = next((r for r in reply.authority if r.type == "SOA"), None)
        negative_ttl = min(soa.ttl, soa.data["minimum"]) if soa else 0  # no SOA: do not cache
        return Entry([], reply.rcode if reply.rcode != "NOERROR" else "NODATA", now + negative_ttl)


def main() -> None:
    ttl = 2
    zone, server, fleet, clock = start(api_ttl=ttl)
    resolver = CachingResolver(DNS)

    print("Part 1: the same move as before, with a cache that respects the TTL\n")
    for i in range(10):
        clock.sleep_until(i * 0.45)
        if i == 2:
            migrate(zone, fleet, clock, ttl)
        if i == 8:
            retire_old(fleet, clock)
        address = resolver.resolve(API)[0]
        tag = "old" if address == OLD else "new" if address == NEW else "?"
        print(f"{clock.stamp()}  request {i + 1:2} -> {address:<14} ({tag}) {fleet.call(address)}")
    print(f"\n10 requests, {resolver.misses} DNS lookups, {resolver.hits} answered from the cache.\n")

    print("Part 2: asking for a name before it exists (negative caching)\n")
    beta = "beta.shop.example.test."
    try:
        resolver.resolve(beta)
    except NameNotFound as err:
        print(f"{clock.stamp()}  lookup {beta}: {err}")
    zone.set(beta, "A", ["198.51.100.30"], 60)
    print(f"{clock.stamp()}  operator: created {beta} -> 198.51.100.30")
    for _ in range(4):
        time.sleep(1.5)
        try:
            print(f"{clock.stamp()}  lookup {beta}: {resolver.resolve(beta)[0]}")
        except NameNotFound as err:
            print(f"{clock.stamp()}  lookup {beta}: still {err}")
    server.close()


if __name__ == "__main__":
    main()
