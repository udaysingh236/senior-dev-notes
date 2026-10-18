"""DNS messages in wire format (RFC 1035), standard library only.

Enough to build questions, parse answers from real servers, and build answers for the toy server.
Every other file in this folder imports it.
"""

from __future__ import annotations

import ipaddress
import random
import socket
import struct
from dataclasses import dataclass, field

TYPES = {"A": 1, "NS": 2, "CNAME": 5, "SOA": 6, "PTR": 12, "MX": 15, "TXT": 16, "AAAA": 28,
         "SRV": 33, "OPT": 41, "CAA": 257, "HTTPS": 65}
TYPE_NAMES = {v: k for k, v in TYPES.items()}
RCODES = {0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED"}
CLASS_IN = 1


@dataclass
class Record:
    name: str        # owner name, always ending in "."
    type: str        # "A", "CNAME", ...
    ttl: int         # seconds this record may be cached
    value: str       # human-readable form of the data
    data: object = None  # parsed form where useful (SOA fields, etc.)


@dataclass
class Message:
    id: int
    qr: bool         # True for a response
    aa: bool         # authoritative answer
    tc: bool         # truncated: the full answer did not fit, retry over TCP
    rd: bool         # recursion desired
    ra: bool         # recursion available
    rcode: str
    question: list[tuple[str, str]] = field(default_factory=list)
    answer: list[Record] = field(default_factory=list)
    authority: list[Record] = field(default_factory=list)
    additional: list[Record] = field(default_factory=list)
    size: int = 0    # bytes on the wire


# ---------- building ----------

def encode_name(name: str) -> bytes:
    out = b""
    for label in name.rstrip(".").split("."):
        if label:
            raw = label.encode("idna")
            if len(raw) > 63:
                raise ValueError(f"label too long: {label!r}")  # RFC 1035: labels are at most 63 bytes
            out += bytes([len(raw)]) + raw
    return out + b"\x00"


def opt_record(udp_size: int) -> bytes:
    """EDNS(0) pseudo-record: 'I can receive UDP answers up to udp_size bytes' (RFC 6891)."""
    return b"\x00" + struct.pack(">HHIH", TYPES["OPT"], udp_size, 0, 0)


def build_query(name: str, qtype: str = "A", *, msg_id: int | None = None,
                recursion: bool = True, edns: int | None = 1232) -> tuple[int, bytes]:
    msg_id = random.randint(0, 0xFFFF) if msg_id is None else msg_id
    flags = 0x0100 if recursion else 0  # RD bit
    header = struct.pack(">HHHHHH", msg_id, flags, 1, 0, 0, 1 if edns else 0)
    question = encode_name(name) + struct.pack(">HH", TYPES[qtype], CLASS_IN)
    return msg_id, header + question + (opt_record(edns) if edns else b"")


def rr(name: str, rtype: str, ttl: int, rdata: bytes) -> bytes:
    return encode_name(name) + struct.pack(">HHIH", TYPES[rtype], CLASS_IN, ttl, len(rdata)) + rdata


def rdata_a(ip: str) -> bytes:
    return ipaddress.ip_address(ip).packed


def rdata_txt(text: str) -> bytes:
    raw = text.encode()
    chunks = [raw[i:i + 255] for i in range(0, len(raw), 255)] or [b""]  # strings are at most 255 bytes
    return b"".join(bytes([len(c)]) + c for c in chunks)


def rdata_soa(mname: str, rname: str, serial: int, refresh: int, retry: int, expire: int, minimum: int) -> bytes:
    return encode_name(mname) + encode_name(rname) + struct.pack(">IIIII", serial, refresh, retry, expire, minimum)


def build_response(query: bytes, *, answer: list[bytes] = (), authority: list[bytes] = (),
                   rcode: int = 0, aa: bool = True, max_size: int = 512) -> bytes:
    """Answer `query`. If the answer is bigger than max_size, send only the header and question
    with the TC bit set, which tells the client to ask again over TCP."""
    msg_id, flags = struct.unpack(">HH", query[:4])
    qend = 12 + _skip_name(query, 12) + 4
    question = query[12:qend]
    rd = flags & 0x0100
    base = 0x8000 | rd | (0x0400 if aa else 0) | rcode
    body = b"".join(answer) + b"".join(authority)
    full = struct.pack(">HHHHHH", msg_id, base, 1, len(answer), len(authority), 0) + question + body
    if len(full) <= max_size:
        return full
    return struct.pack(">HHHHHH", msg_id, base | 0x0200, 1, 0, 0, 0) + question  # 0x0200 = TC


# ---------- parsing ----------

def _skip_name(data: bytes, offset: int) -> int:
    start = offset
    while True:
        length = data[offset]
        if length == 0:
            return offset + 1 - start
        if length & 0xC0 == 0xC0:  # compression pointer: two bytes, and the name ends here
            return offset + 2 - start
        offset += 1 + length


def decode_name(data: bytes, offset: int) -> tuple[str, int]:
    """Returns (name, offset after the name). Follows compression pointers (RFC 1035 4.1.4)."""
    labels, jumped, end, hops = [], False, offset, 0
    while True:
        length = data[offset]
        if length & 0xC0 == 0xC0:
            hops += 1
            if hops > 50:
                raise ValueError("compression loop")
            if not jumped:
                end = offset + 2
            offset = ((length & 0x3F) << 8) | data[offset + 1]
            jumped = True
            continue
        if length == 0:
            if not jumped:
                end = offset + 1
            return ".".join(labels) + ".", end
        labels.append(data[offset + 1:offset + 1 + length].decode("ascii", "replace"))
        offset += 1 + length


def _svc_params(rdata: bytes) -> str:
    keys = {1: "alpn", 3: "port", 4: "ipv4hint", 5: "ech", 6: "ipv6hint"}
    parts, i = [], 0
    while i + 4 <= len(rdata):
        key, length = struct.unpack(">HH", rdata[i:i + 4])
        value = rdata[i + 4:i + 4 + length]
        i += 4 + length
        name = keys.get(key, f"key{key}")
        if key == 1:
            ids, j = [], 0
            while j < len(value):
                ids.append(value[j + 1:j + 1 + value[j]].decode())
                j += 1 + value[j]
            parts.append(f"alpn={','.join(ids)}")
        elif key == 3:
            parts.append(f"port={struct.unpack('>H', value)[0]}")
        elif key in (4, 6):
            size = 4 if key == 4 else 16
            ips = [str(ipaddress.ip_address(value[j:j + size])) for j in range(0, len(value), size)]
            parts.append(f"{name}={','.join(ips)}")
        else:
            parts.append(f"{name}=<{length} bytes>")
    return " ".join(parts)


def _value(data: bytes, rtype: int, start: int, length: int) -> tuple[str, object]:
    rdata = data[start:start + length]
    name = TYPE_NAMES.get(rtype, str(rtype))
    if name in ("A", "AAAA"):
        return str(ipaddress.ip_address(rdata)), None
    if name in ("NS", "CNAME", "PTR"):
        return decode_name(data, start)[0], None
    if name == "MX":
        pref = struct.unpack(">H", rdata[:2])[0]
        return f"{pref} {decode_name(data, start + 2)[0]}", None
    if name == "TXT":
        texts, i = [], 0
        while i < len(rdata):
            texts.append(rdata[i + 1:i + 1 + rdata[i]].decode("utf-8", "replace"))
            i += 1 + rdata[i]
        return "".join(texts), texts
    if name == "SOA":
        mname, off = decode_name(data, start)
        rname, off = decode_name(data, off)
        serial, refresh, retry, expire, minimum = struct.unpack(">IIIII", data[off:off + 20])
        soa = dict(mname=mname, rname=rname, serial=serial, refresh=refresh, retry=retry, expire=expire, minimum=minimum)
        return f"{mname} {rname} serial={serial} minimum={minimum}", soa
    if name == "CAA":
        tag_len = rdata[1]
        return f'{rdata[0]} {rdata[2:2 + tag_len].decode()} "{rdata[2 + tag_len:].decode()}"', None
    if name == "HTTPS":
        priority = struct.unpack(">H", rdata[:2])[0]
        target, off = decode_name(data, start + 2)
        return f"{priority} {target} {_svc_params(data[off:start + length])}".strip(), None
    return rdata.hex(), None


def parse_message(data: bytes) -> Message:
    msg_id, flags, qd, an, ns, ar = struct.unpack(">HHHHHH", data[:12])
    msg = Message(id=msg_id, qr=bool(flags & 0x8000), aa=bool(flags & 0x0400), tc=bool(flags & 0x0200),
                  rd=bool(flags & 0x0100), ra=bool(flags & 0x0080), rcode=RCODES.get(flags & 0xF, str(flags & 0xF)),
                  size=len(data))
    offset = 12
    for _ in range(qd):
        name, offset = decode_name(data, offset)
        qtype = struct.unpack(">H", data[offset:offset + 2])[0]
        msg.question.append((name, TYPE_NAMES.get(qtype, str(qtype))))
        offset += 4
    for section, count in ((msg.answer, an), (msg.authority, ns), (msg.additional, ar)):
        for _ in range(count):
            name, offset = decode_name(data, offset)
            rtype, _cls, ttl, length = struct.unpack(">HHIH", data[offset:offset + 10])
            offset += 10
            if rtype != TYPES["OPT"]:
                value, parsed = _value(data, rtype, offset, length)
                section.append(Record(name, TYPE_NAMES.get(rtype, str(rtype)), ttl, value, parsed))
            offset += length
    return msg


def query_name(query: bytes) -> tuple[str, str, int]:
    """For servers: (name, type, udp size the client can receive) from an incoming query."""
    name, offset = decode_name(query, 12)
    qtype = TYPE_NAMES.get(struct.unpack(">H", query[offset:offset + 2])[0], "?")
    udp_size = 512  # no EDNS: the 1987 limit
    if struct.unpack(">H", query[10:12])[0]:  # an additional record, hopefully OPT
        opt = offset + 4
        if query[opt] == 0 and struct.unpack(">H", query[opt + 1:opt + 3])[0] == TYPES["OPT"]:
            udp_size = max(512, struct.unpack(">H", query[opt + 3:opt + 5])[0])
    return name.lower(), qtype, udp_size


# ---------- sending ----------

def ask_udp(server: str, port: int, query: bytes, timeout: float = 2.0) -> bytes:
    """One question, one UDP packet, one answer. Checks the ID so a stray packet is not believed."""
    family = socket.AF_INET6 if ":" in server else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(query, (server, port))
        while True:
            data, _ = sock.recvfrom(65535)
            if data[:2] == query[:2]:
                return data


def ask_tcp(server: str, port: int, query: bytes, timeout: float = 2.0) -> bytes:
    """Over TCP every message is preceded by its length in two bytes (RFC 1035 4.2.2)."""
    with socket.create_connection((server, port), timeout=timeout) as sock:
        sock.sendall(struct.pack(">H", len(query)) + query)
        length = struct.unpack(">H", _read_exactly(sock, 2))[0]
        return _read_exactly(sock, length)


def _read_exactly(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("connection closed mid-message")
        buf += chunk
    return buf
