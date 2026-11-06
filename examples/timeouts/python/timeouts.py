"""Timeouts: what a read timeout really bounds, a total deadline, and deadlines passed between services.

Standard library only. Starts two small HTTP servers on localhost:
  - a "slow drip" server that answers at once, then sends its 20-byte body one byte a second
  - a "report" server whose handler does 2 s of work in 10 steps

    python3 timeouts.py
"""

import http.client
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

DRIP_BYTES, DRIP_GAP = 20, 1.0  # seconds between bytes: always under the client's read timeout
STEPS, STEP_SECONDS = 10, 0.2  # the report takes 2 s of work
log: list[str] = []
started = time.monotonic()


def say(msg: str) -> None:
    line = f"   [{time.monotonic() - started:5.1f}s] {msg}"
    log.append(line)
    print(line, flush=True)


class DeadlineExceeded(TimeoutError):
    pass


class Deadline:
    """A point in time, measured on the monotonic clock, after which nobody wants the answer."""

    def __init__(self, seconds: float) -> None:
        self.at = time.monotonic() + seconds

    def remaining(self) -> float:
        return self.at - time.monotonic()

    def check(self, needed: float = 0.0) -> None:
        if self.remaining() < needed:
            raise DeadlineExceeded(f"deadline: {max(self.remaining(), 0) * 1000:.0f} ms left, {needed * 1000:.0f} ms needed")


def fetch_with_deadline(url: str, deadline: Deadline, headers: dict[str, str] | None = None) -> bytes:
    """GET url, failing as soon as the deadline passes, however the server spreads out its bytes."""
    parts = urlsplit(url)
    deadline.check()
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=deadline.remaining())
    try:
        # Tell the server how long we will wait, so it can stop when we stop.
        sent = {"x-request-timeout-ms": str(int(deadline.remaining() * 1000)), **(headers or {})}
        conn.request("GET", parts.path or "/", headers=sent)
        sock = conn.sock
        sock.settimeout(max(deadline.remaining(), 0.001))
        resp = conn.getresponse()
        if resp.status == 504:
            raise DeadlineExceeded("the server stopped: it would not finish in time")
        body = b""
        while chunk := resp.read1(65536):  # each read waits at most for what is left of the deadline
            body += chunk
            deadline.check()
            sock.settimeout(max(deadline.remaining(), 0.001))
        return body
    except DeadlineExceeded:
        raise
    except OSError as err:  # includes the socket's own timeout
        raise DeadlineExceeded(f"gave up at the deadline ({err})") from None
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # keep the output readable
        pass

    def do_GET(self) -> None:
        if self.path == "/drip":
            self.send_response(200)
            self.send_header("Content-Length", str(DRIP_BYTES))
            self.end_headers()
            for _ in range(DRIP_BYTES):
                time.sleep(DRIP_GAP)
                try:
                    self.wfile.write(b".")
                    self.wfile.flush()
                except OSError:  # the client hung up
                    return
            return
        # /report ignores the caller; /report-deadline reads its deadline from the header.
        budget_ms = self.headers.get("x-request-timeout-ms")
        deadline = Deadline(int(budget_ms) / 1000) if budget_ms and self.path == "/report-deadline" else None
        for step in range(STEPS):
            if deadline and deadline.remaining() < STEP_SECONDS:
                say(f"server: {self.path} stopped after {step} of {STEPS} steps, the caller's deadline is near")
                self.send_error(504, "deadline exceeded")
                return
            time.sleep(STEP_SECONDS)  # one step of real work: a query, a render, a call
        say(f"server: {self.path} finished all {STEPS} steps")
        try:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"report")
        except OSError:
            say(f"server: {self.path} could not send the answer: the caller had gone")


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    global started

    print(f"1. A server that sends {DRIP_BYTES} bytes, one every {DRIP_GAP:g} s. Client timeout: 3 s")
    started = time.monotonic()
    body = urllib.request.urlopen(base + "/drip", timeout=3).read()
    say(f"urlopen(timeout=3): got {len(body)} bytes, no error")
    started = time.monotonic()
    try:
        fetch_with_deadline(base + "/drip", Deadline(3))
    except TimeoutError as err:
        say(f"fetch_with_deadline(3 s): {err}")

    print(f"2. A handler that needs {STEPS * STEP_SECONDS:g} s. Client deadline: 0.5 s")
    for path in ("/report", "/report-deadline"):
        started = time.monotonic()
        try:
            fetch_with_deadline(base + path, Deadline(0.5))
        except TimeoutError as err:
            say(f"client: {path}: {err}")
        time.sleep(STEPS * STEP_SECONDS + 0.3)  # let the server finish, or not, and report it

    server.shutdown()


if __name__ == "__main__":
    main()
