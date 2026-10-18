"""Ask real resolvers real questions, like a tiny `dig`. Needs an internet connection.

    python lookup.py                     # a tour of record types, then the same question over DoH
    python lookup.py github.com MX       # one question
"""

from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request

import dnswire as w

RESOLVER = "1.1.1.1"  # Cloudflare's public resolver; 8.8.8.8 (Google) or 9.9.9.9 (Quad9) work too
DOH = ["https://cloudflare-dns.com/dns-query", "https://dns.google/dns-query"]

TOUR = [
    ("example.com", "A"), ("example.com", "AAAA"), ("www.github.com", "A"), ("gmail.com", "MX"),
    ("google.com", "CAA"), ("cloudflare.com", "HTTPS"), ("example.com", "NS"), ("example.com", "SOA"),
    ("no-such-name.example.com", "A"), ("example.com", "MX"),
]


def show(reply: w.Message, name: str, rtype: str, ms: float, via: str) -> None:
    flags = " ".join(f for f, on in (("aa", reply.aa), ("tc", reply.tc), ("rd", reply.rd), ("ra", reply.ra)) if on)
    print(f"{name} {rtype} via {via}: {reply.rcode} [{flags}] {reply.size} bytes in {ms:.0f} ms")
    for r in reply.answer:
        print(f"    {r.name:<26} {r.ttl:>6}  {r.type:<6} {r.value[:90]}")
    if not reply.answer:
        for r in reply.authority:
            if r.type == "SOA":
                print(f"    (no answer; the SOA says: cache this 'no' for {min(r.ttl, r.data['minimum'])} s)")


def ask(name: str, rtype: str) -> None:
    _, query = w.build_query(name, rtype)
    t = time.perf_counter()
    reply = w.parse_message(w.ask_udp(RESOLVER, 53, query))
    show(reply, name, rtype, (time.perf_counter() - t) * 1000, f"UDP {RESOLVER}")


def ask_doh(url: str, name: str, rtype: str) -> None:
    """DNS over HTTPS (RFC 8484): the same binary message, POSTed over HTTPS. ID 0 for cacheability."""
    _, query = w.build_query(name, rtype, msg_id=0)
    request = urllib.request.Request(url, data=query, method="POST", headers={
        "Content-Type": "application/dns-message", "Accept": "application/dns-message"})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = response.read()
    except urllib.error.URLError as err:
        # Seen on Windows: Python uses the system trust store, which may not hold every root yet.
        print(f"{name} {rtype} via DoH {url.split('/')[2]}: could not connect: {err.reason}")
        return
    show(w.parse_message(body), name, rtype, (time.perf_counter() - t) * 1000, f"DoH {url.split('/')[2]}")


def main() -> None:
    if len(sys.argv) == 3:
        ask(sys.argv[1], sys.argv[2].upper())
        return
    for name, rtype in TOUR:
        ask(name, rtype)
        print()
    print("The same question three ways (each DoH request here opens a new HTTPS connection):")
    ask("example.com", "A")
    for url in DOH:
        ask_doh(url, "example.com", "A")


if __name__ == "__main__":
    main()
