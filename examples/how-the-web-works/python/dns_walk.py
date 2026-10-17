"""Resolve a name the way a recursive resolver does: start at a root server and follow referrals.

Standard library only. Run:  python dns_walk.py [name]   (default: example.com)

Your laptop never does this. It asks one recursive resolver (your ISP's, your office's, 1.1.1.1
or 8.8.8.8), and that resolver does the walk below, then caches every answer for its TTL.
This script builds raw DNS packets (RFC 1035) and sends them over UDP port 53, so you can see
each hop: root -> top-level domain -> the domain's own name servers.
"""

from __future__ import annotations

import random
import socket
import struct
import sys
import time

ROOT = ("a.root-servers.net", "198.41.0.4")  # one of the 13 root server identities, A to M
TYPES = {1: "A", 2: "NS", 5: "CNAME", 28: "AAAA"}


def build_query(name: str, qtype: int = 1) -> tuple[int, bytes]:
    query_id = random.randint(0, 0xFFFF)
    # Header: id, flags = 0 (a plain query; "recursion desired" off, because WE do the walk),
    # then one question and no answer, authority or additional records.
    header = struct.pack(">HHHHHH", query_id, 0, 1, 0, 0, 0)
    qname = b"".join(bytes([len(label)]) + label.encode() for label in name.rstrip(".").split(".")) + b"\0"
    return query_id, header + qname + struct.pack(">HH", qtype, 1)  # class 1 = IN (internet)


def read_name(msg: bytes, pos: int) -> tuple[str, int]:
    """Names are length-prefixed labels; a byte starting 0b11 points back to an earlier name."""
    labels, end = [], None
    while (length := msg[pos]) != 0:
        if length >= 0xC0:  # compression pointer
            end = end or pos + 2
            pos = struct.unpack(">H", msg[pos:pos + 2])[0] & 0x3FFF
            continue
        labels.append(msg[pos + 1:pos + 1 + length].decode())
        pos += 1 + length
    return ".".join(labels) + ".", end or pos + 1


def parse(msg: bytes) -> dict[str, list[tuple[str, str, int, str]]]:
    counts = struct.unpack(">HHHH", msg[4:12])
    pos = 12
    for _ in range(counts[0]):  # skip the question we sent
        _, pos = read_name(msg, pos)
        pos += 4
    sections: dict[str, list] = {"answer": [], "authority": [], "additional": []}
    for section, count in zip(sections, counts[1:]):
        for _ in range(count):
            name, pos = read_name(msg, pos)
            rtype, _, ttl, size = struct.unpack(">HHIH", msg[pos:pos + 10])
            pos += 10
            data = msg[pos:pos + size]
            if rtype == 1:
                value = socket.inet_ntop(socket.AF_INET, data)
            elif rtype == 28:
                value = socket.inet_ntop(socket.AF_INET6, data)
            elif rtype in (2, 5):
                value = read_name(msg, pos)[0]
            else:
                value = f"({size} bytes)"
            sections[section].append((name, TYPES.get(rtype, str(rtype)), ttl, value))
            pos += size
    return sections


def ask(server_ip: str, name: str) -> tuple[dict, float]:
    query_id, packet = build_query(name)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(3)
        started = time.perf_counter()
        sock.sendto(packet, (server_ip, 53))
        reply, _ = sock.recvfrom(4096)
    assert struct.unpack(">H", reply[:2])[0] == query_id, "reply does not match our question"
    return parse(reply), (time.perf_counter() - started) * 1000


def walk(name: str, depth: int = 0) -> str:
    server_name, server_ip = ROOT
    indent = "    " * depth
    for hop in range(1, 10):
        reply, rtt = ask(server_ip, name)
        print(f"{indent}{hop}. asked {server_name} ({server_ip}) about {name}: {rtt:.0f} ms")
        for owner, rtype, ttl, value in reply["answer"]:
            print(f"{indent}   answer: {owner} {rtype} {value}  (cache for {ttl} s)")
            if rtype == "A":
                return value
            if rtype == "CNAME":  # an alias: start again for the real name
                return walk(value, depth)
        referral = [r for r in reply["authority"] if r[1] == "NS"]
        if not referral:
            raise LookupError(f"{name}: no answer and no referral")
        zone, ttl = referral[0][0], referral[0][2]
        names = [r[3] for r in referral]
        print(f"{indent}   referral: ask the {zone} servers, e.g. {', '.join(names[:2])}  (cache for {ttl} s)")
        glue = {owner: value for owner, rtype, _, value in reply["additional"] if rtype == "A"}
        server_name = next((n for n in names if n in glue), names[0])
        # "Glue" is the address of a name server, sent along so we don't have to look it up.
        # Without it, we must resolve the name server's own name first.
        server_ip = glue.get(server_name) or walk(server_name, depth + 1)
    raise LookupError("too many hops")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "example.com"
    started = time.perf_counter()
    address = walk(target)
    print(f"\n{target} is at {address}, found in {(time.perf_counter() - started) * 1000:.0f} ms from a cold start")
