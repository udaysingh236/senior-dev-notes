"""The production-shaped version: what a careful client library or sidecar cache does.

- several upstream resolvers, each with a short timeout, tried in turn
- answers checked against the question we asked (ID and name), so a stray packet is not believed
- TCP when the UDP answer comes back truncated (TC bit)
- TTLs clamped to a floor and a ceiling we choose
- serve-stale (RFC 8767): if every upstream fails, keep using the last good answer for a while

Run: python resilient_resolver.py   (about 5 seconds; starts its own toy DNS server)
"""

from __future__ import annotations

import socket
import time
from dataclasses import dataclass

import dnswire as w
from demo import API, start

TIMEOUT = 0.4       # per attempt; resolvers on a LAN answer in a few ms
MIN_TTL, MAX_TTL = 1, 300
MAX_STALE = 3600    # how long we are willing to use an expired answer if nobody answers (1-3 days in RFC 8767)
STALE_TTL = 30      # how long a stale answer is good for before we try the upstreams again


class LookupFailed(Exception):
    pass


@dataclass
class Entry:
    values: list[str]
    expires: float
    stale_until: float


class ResilientResolver:
    def __init__(self, upstreams: list[tuple[str, int]]):
        self.upstreams = upstreams
        self.cache: dict[tuple[str, str], Entry] = {}

    def resolve(self, name: str, rtype: str = "A") -> list[str]:
        key, now = (name.lower(), rtype), time.monotonic()
        entry = self.cache.get(key)
        if entry and now < entry.expires:
            return entry.values
        try:
            values, ttl = self._ask_upstreams(name, rtype)
        except LookupFailed as err:
            if entry and now < entry.stale_until:  # serve stale: an old answer beats no answer
                entry.expires = now + STALE_TTL
                print(f"    ! every upstream failed ({err}); serving the expired answer for {STALE_TTL} s")
                return entry.values
            raise
        ttl = max(MIN_TTL, min(MAX_TTL, ttl))
        self.cache[key] = Entry(values, now + ttl, now + ttl + MAX_STALE)
        return values

    def _ask_upstreams(self, name: str, rtype: str) -> tuple[list[str], int]:
        errors = []
        for host, port in self.upstreams:
            try:
                reply = self._exchange(host, port, name, rtype)
            except (TimeoutError, ConnectionError, OSError) as err:
                errors.append(f"{host}:{port} {type(err).__name__}")
                continue
            if reply.rcode == "SERVFAIL":  # this resolver could not get an answer; another might
                errors.append(f"{host}:{port} SERVFAIL")
                continue
            if reply.rcode != "NOERROR":
                raise LookupFailed(f"{name}: {reply.rcode}")  # a real "no" is not retried elsewhere
            records = [r for r in reply.answer if r.type in (rtype, "CNAME")]
            values = [r.value for r in records if r.type == rtype]
            if not values:
                raise LookupFailed(f"{name}: no {rtype} records")
            return values, min(r.ttl for r in records)
        raise LookupFailed("; ".join(errors))

    def _exchange(self, host: str, port: int, name: str, rtype: str) -> w.Message:
        msg_id, query = w.build_query(name, rtype)
        reply = w.parse_message(w.ask_udp(host, port, query, timeout=TIMEOUT))
        if reply.tc:  # too big for UDP: same question again over TCP
            print(f"    UDP answer from {host}:{port} was truncated ({reply.size} bytes, TC=1); retrying over TCP")
            reply = w.parse_message(w.ask_tcp(host, port, query, timeout=TIMEOUT))
            print(f"    TCP answer: {reply.size} bytes, {len(reply.answer)} records")
        if reply.id != msg_id or reply.question[:1] != [(name.lower(), rtype)]:
            raise ConnectionError("answer does not match the question")  # possible spoofing
        return reply


def main() -> None:
    zone, server, _, clock = start(api_ttl=2)
    dead = ("127.0.0.1", 5399)  # nothing listens here: the first upstream is "down"
    resolver = ResilientResolver([dead, ("127.0.0.1", 8053)])

    print(f"{clock.stamp()}  1. the first upstream is down; the second answers")
    t = time.perf_counter()
    print(f"         {API} -> {resolver.resolve(API)}  in {(time.perf_counter() - t) * 1000:.0f} ms")

    print(f"{clock.stamp()}  2. an answer too big for UDP")
    txt = resolver.resolve("big.shop.example.test.", "TXT")
    print(f"         got {len(txt)} TXT strings, {sum(len(s) for s in txt)} characters")

    print(f"{clock.stamp()}  3. the authoritative server goes down; the cached answer expires")
    zone.down = True
    time.sleep(2.2)
    addresses = resolver.resolve(API)
    print(f"{clock.stamp()}     {API} -> {addresses}")

    print(f"{clock.stamp()}  4. a name we never cached, while everything is down")
    try:
        resolver.resolve("new.shop.example.test.")
    except LookupFailed as err:
        print(f"         failed, nothing stale to fall back on: {err}")
    server.close()


if __name__ == "__main__":
    socket.setdefaulttimeout(TIMEOUT)
    main()
