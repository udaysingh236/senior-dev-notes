"""Load a web page one step at a time, the way a browser does, and time every step.

Standard library only. Run:  python by_hand.py [host]   (default: example.com)

Each step is done by hand instead of inside one library call, so you can see where the time
goes: DNS lookup, TCP connect, TLS handshake, sending the request, waiting for the first byte,
and reading the rest. Then it sends a second request on the same connection to show what
connection reuse saves.
"""

from __future__ import annotations

import socket
import ssl
import sys
import time


def ms(seconds: float) -> str:
    return f"{seconds * 1000:6.1f} ms"


class Reader:
    """Buffers bytes from the socket, so leftovers from one response are kept for the next."""

    def __init__(self, sock: ssl.SSLSocket) -> None:
        self.sock, self.buf, self.first_byte_at = sock, b"", 0.0

    def _fill(self) -> None:
        chunk = self.sock.recv(4096)
        if not chunk:
            raise ConnectionError("server closed the connection mid-response")
        if not self.first_byte_at:
            self.first_byte_at = time.perf_counter()
        self.buf += chunk

    def until(self, marker: bytes) -> bytes:
        while marker not in self.buf:
            self._fill()
        data, _, self.buf = self.buf.partition(marker)
        return data

    def exactly(self, n: int) -> bytes:
        while len(self.buf) < n:
            self._fill()
        data, self.buf = self.buf[:n], self.buf[n:]
        return data


def read_response(reader: Reader, started: float) -> tuple[str, dict[str, str], float, int]:
    """Read one HTTP/1.1 response. Returns status line, headers, time to first byte, body size."""
    reader.first_byte_at = 0.0
    status, *lines = reader.until(b"\r\n\r\n").decode("iso-8859-1").split("\r\n")
    headers = {k.strip().lower(): v.strip() for k, v in (line.split(":", 1) for line in lines)}
    if headers.get("transfer-encoding") == "chunked":
        # The body arrives in pieces, each prefixed by its size in hex; a 0-size piece ends it.
        size = 0
        while (n := int(reader.until(b"\r\n").split(b";")[0], 16)) > 0:
            size += len(reader.exactly(n))
            reader.until(b"\r\n")
        reader.until(b"\r\n")
    else:
        size = len(reader.exactly(int(headers.get("content-length", "0"))))
    return status, headers, reader.first_byte_at - started, size


def load(host: str, path: str = "/") -> None:
    print(f"Loading https://{host}{path}\n")

    # 1. DNS: turn the name into addresses. getaddrinfo asks the operating system, which asks
    #    its configured resolver (and may answer from its own cache).
    t = time.perf_counter()
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    dns = time.perf_counter() - t
    addresses = list(dict.fromkeys(info[4][0] for info in infos))  # unique, in order
    print(f"1. DNS lookup    {ms(dns)}   {host} -> {', '.join(addresses[:3])}")

    # 2. TCP: one round trip (SYN, SYN-ACK; our ACK rides along with the next packet).
    family, _, _, _, sockaddr = infos[0]
    t = time.perf_counter()
    raw = socket.socket(family, socket.SOCK_STREAM)
    raw.settimeout(5)  # never wait for ever on any one step
    raw.connect(sockaddr)
    tcp = time.perf_counter() - t
    print(f"2. TCP connect   {ms(tcp)}   to {sockaddr[0]} port 443 (about one round trip)")

    # 3. TLS: agree on keys, check the certificate, and pick HTTP/1.1 via ALPN.
    context = ssl.create_default_context()
    context.set_alpn_protocols(["http/1.1"])
    t = time.perf_counter()
    tls = context.wrap_socket(raw, server_hostname=host)  # server_hostname = SNI + cert check
    handshake = time.perf_counter() - t
    cert = tls.getpeercert()
    issuer = dict(x[0] for x in cert["issuer"]).get("organizationName", "?")
    print(f"3. TLS handshake {ms(handshake)}   {tls.version()}, {tls.cipher()[0]}, ALPN={tls.selected_alpn_protocol()}")
    print(f"                             certificate issued by {issuer}, valid until {cert['notAfter']}")

    # 4. HTTP: the request is plain text inside the encrypted tunnel.
    request = f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: by-hand/1.0\r\nConnection: keep-alive\r\n\r\n"
    reader = Reader(tls)
    t = time.perf_counter()
    tls.sendall(request.encode())
    status, headers, ttfb, size = read_response(reader, t)
    total = time.perf_counter() - t
    print(f"4. First byte    {ms(ttfb)}   after sending the request: {status}")
    print(f"5. Whole body    {ms(total)}   {size} bytes, Content-Type: {headers.get('content-type')}")
    for name in ("transfer-encoding", "cache-control", "age", "server", "cf-ray", "alt-svc"):
        if name in headers:
            print(f"                             {name}: {headers[name]}")

    first_visit = dns + tcp + handshake + total
    print(f"\nFirst request, everything included: {ms(first_visit)}")

    # 6. Reuse: a second request on the same connection skips DNS, TCP and TLS.
    t = time.perf_counter()
    tls.sendall(request.encode())
    status, _, _, _ = read_response(reader, t)
    reuse = time.perf_counter() - t
    print(f"Second request, same connection:    {ms(reuse)}   ({status})")
    tls.close()


if __name__ == "__main__":
    load(sys.argv[1] if len(sys.argv) > 1 else "example.com")
