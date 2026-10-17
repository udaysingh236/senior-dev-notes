"""A small page-load probe: time every step, put a timeout on every step, and when something
fails, say which step failed and what a browser would have shown.

Standard library only. Run:  python probe.py [url ...]

With no arguments it probes a healthy site and five broken ones, one per step that can fail.
This is the shape of the checks that uptime monitors and synthetic tests run in production.
"""

from __future__ import annotations

import concurrent.futures
import socket
import ssl
import sys
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

TIMEOUTS = {"dns": 3.0, "connect": 3.0, "tls": 5.0, "response": 10.0}  # seconds, per step
_dns_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)


class StepFailed(Exception):
    def __init__(self, step: str, reason: str, browser_says: str) -> None:
        super().__init__(reason)
        self.step, self.reason, self.browser_says = step, reason, browser_says


@dataclass
class Result:
    url: str
    timings: dict[str, float] = field(default_factory=dict)  # step -> milliseconds
    status: str = ""
    failure: StepFailed | None = None


def resolve(host: str, port: int) -> list[tuple]:
    # getaddrinfo has no timeout of its own, so run it in a thread and stop waiting after a while.
    future = _dns_pool.submit(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    try:
        return future.result(timeout=TIMEOUTS["dns"])
    except concurrent.futures.TimeoutError:
        raise StepFailed("dns", "resolver did not answer", "DNS_PROBE_FINISHED_NO_INTERNET")
    except socket.gaierror:
        raise StepFailed("dns", "no such name", "DNS_PROBE_FINISHED_NXDOMAIN")


def connect(infos: list[tuple]) -> socket.socket:
    # Try each address in turn (browsers race IPv6 and IPv4 instead: "Happy Eyeballs").
    last = StepFailed("connect", "no addresses", "ERR_NAME_NOT_RESOLVED")
    for family, _, _, _, sockaddr in infos:
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(TIMEOUTS["connect"])
        try:
            sock.connect(sockaddr)
            return sock
        except TimeoutError:
            last = StepFailed("connect", f"no answer from {sockaddr[0]}", "ERR_CONNECTION_TIMED_OUT")
        except ConnectionRefusedError:
            last = StepFailed("connect", f"{sockaddr[0]} refused", "ERR_CONNECTION_REFUSED")
        sock.close()
    raise last


def handshake(sock: socket.socket, host: str) -> ssl.SSLSocket:
    sock.settimeout(TIMEOUTS["tls"])
    try:
        return ssl.create_default_context().wrap_socket(sock, server_hostname=host)
    except ssl.SSLCertVerificationError as err:
        browser = {10: "NET::ERR_CERT_DATE_INVALID", 62: "NET::ERR_CERT_COMMON_NAME_INVALID"}
        raise StepFailed("tls", err.verify_message, browser.get(err.verify_code, "NET::ERR_CERT_INVALID"))
    except TimeoutError:
        raise StepFailed("tls", "handshake timed out", "ERR_TIMED_OUT")


def probe(url: str) -> Result:
    result = Result(url)
    parts = urlsplit(url)
    host, port = parts.hostname or "", parts.port or 443

    def timed(step: str, fn, *args):
        t = time.perf_counter()
        try:
            return fn(*args)
        finally:
            result.timings[step] = (time.perf_counter() - t) * 1000

    try:
        infos = timed("dns", resolve, host, port)
        sock = timed("connect", connect, infos)
        tls = timed("tls", handshake, sock, host)
        with tls:
            tls.settimeout(TIMEOUTS["response"])
            request = f"GET {parts.path or '/'} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
            first = timed("first byte", lambda: (tls.sendall(request.encode()), tls.recv(1024))[1])
        result.status = first.split(b"\r\n", 1)[0].decode()
    except StepFailed as failure:
        result.failure = failure
    return result


def report(result: Result) -> None:
    total = sum(result.timings.values())
    steps = "  ".join(f"{k} {v:.0f}" for k, v in result.timings.items())
    print(f"{result.url}\n  {steps}  (total {total:.0f} ms)")
    if result.failure:
        f = result.failure
        print(f"  FAILED at {f.step}: {f.reason}  -> a browser shows {f.browser_says}\n")
    else:
        print(f"  OK: {result.status}\n")


DEFAULT_TARGETS = [
    "https://example.com/",
    "https://no-such-host.invalid/",   # .invalid is reserved: it never resolves (RFC 6761)
    "https://10.255.255.1/",           # a private address nothing answers on
    "https://127.0.0.1:9/",            # our own machine, a port nothing listens on
    "https://expired.badssl.com/",     # public test site with an expired certificate
    "https://wrong.host.badssl.com/",  # certificate for a different name
]

if __name__ == "__main__":
    for target in sys.argv[1:] or DEFAULT_TARGETS:
        report(probe(target))
