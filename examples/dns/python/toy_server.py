"""A tiny authoritative DNS server for the zone shop.example.test, on 127.0.0.1:8053.

It answers over UDP and TCP, sends NXDOMAIN and NODATA with the zone's SOA (so resolvers can cache
"no"), sets the TC bit when an answer does not fit in UDP, and lets the demos change records or
"go down" while it runs. .test is reserved for testing (RFC 6761), so this can never clash with a
real name.

Run it on its own and query it:
    python toy_server.py
    nslookup -port=8053 api.shop.example.test 127.0.0.1
"""

from __future__ import annotations

import socketserver
import struct
import threading
import time

import dnswire as w

ZONE = "shop.example.test."
SOA_MINIMUM = 5  # seconds: how long others may cache "no such name" (RFC 2308). Real zones: 300-3600.


class Zone:
    def __init__(self, api_ttl: int = 2):
        self.lock = threading.Lock()
        self.down = False  # True: drop every query, as if the server were unreachable
        self.queries = 0
        # name -> type -> (ttl, [values])
        self.records: dict[str, dict[str, tuple[int, list[str]]]] = {
            ZONE: {"NS": (86400, ["ns1.shop.example.test."])},
            "ns1." + ZONE: {"A": (86400, ["127.0.0.1"])},
            "api." + ZONE: {"A": (api_ttl, ["203.0.113.10"])},
            "www." + ZONE: {"CNAME": (3600, ["api." + ZONE])},
            # 12 long strings, about 2.4 KB: too big for one UDP answer, so it forces TCP.
            "big." + ZONE: {"TXT": (60, [f"chunk {i:02d} " + "x" * 190 for i in range(12)])},
        }

    def set(self, name: str, rtype: str, values: list[str], ttl: int) -> None:
        with self.lock:
            self.records.setdefault(name, {})[rtype] = (ttl, values)

    def soa(self) -> bytes:
        rdata = w.rdata_soa("ns1." + ZONE, "hostmaster." + ZONE, int(time.time()), 3600, 600, 86400, SOA_MINIMUM)
        return w.rr(ZONE, "SOA", SOA_MINIMUM, rdata)

    def answer(self, query: bytes, max_size: int) -> bytes:
        name, qtype, udp_size = w.query_name(query)
        self.queries += 1
        with self.lock:
            node = self.records.get(name)
            if not name.endswith(ZONE):
                return w.build_response(query, rcode=5, aa=False, max_size=max_size)  # REFUSED: not our zone
            if node is None:
                return w.build_response(query, authority=[self.soa()], rcode=3, max_size=max_size)  # NXDOMAIN
            answers = []
            if "CNAME" in node and qtype != "CNAME":  # an alias: answer with the alias and its target
                ttl, (target,) = node["CNAME"]
                answers.append(w.rr(name, "CNAME", ttl, w.encode_name(target)))
                name, node = target, self.records.get(target, {})
            if qtype in node:
                ttl, values = node[qtype]
                for v in values:
                    data = w.rdata_a(v) if qtype in ("A", "AAAA") else w.rdata_txt(v) if qtype == "TXT" else w.encode_name(v)
                    answers.append(w.rr(name, qtype, ttl, data))
            if not answers:
                return w.build_response(query, authority=[self.soa()], max_size=max_size)  # NODATA
            return w.build_response(query, answer=answers, max_size=max_size)


class ToyServer:
    def __init__(self, zone: Zone, port: int = 8053, host: str = "127.0.0.1"):
        self.zone = zone
        outer = self

        class Udp(socketserver.BaseRequestHandler):
            def handle(self):
                data, sock = self.request
                if outer.zone.down:
                    return
                udp_size = w.query_name(data)[2]
                sock.sendto(outer.zone.answer(data, max_size=udp_size), self.client_address)

        class Tcp(socketserver.BaseRequestHandler):
            def handle(self):
                if outer.zone.down:
                    return
                length = struct.unpack(">H", w._read_exactly(self.request, 2))[0]
                reply = outer.zone.answer(w._read_exactly(self.request, length), max_size=65535)
                self.request.sendall(struct.pack(">H", len(reply)) + reply)

        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self.udp = socketserver.ThreadingUDPServer((host, port), Udp)
        self.tcp = socketserver.ThreadingTCPServer((host, port), Tcp)
        for srv in (self.udp, self.tcp):
            srv.daemon_threads = True
            threading.Thread(target=srv.serve_forever, daemon=True).start()

    def close(self) -> None:
        for srv in (self.udp, self.tcp):
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    ToyServer(Zone(api_ttl=60))
    print(f"authoritative for {ZONE} on 127.0.0.1:8053 (UDP and TCP). Ctrl+C to stop.")
    print("try: nslookup -port=8053 api.shop.example.test 127.0.0.1")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
