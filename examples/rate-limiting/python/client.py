"""The other side of the contract: a client that behaves well when it is rate limited.

Starts a tiny local API limited to a burst of 5 and 5 requests per second per API key, then
sends it 30 requests three ways:
  1. retry at once on 429 (what a buggy script does)
  2. wait for Retry-After plus random jitter, backing off further each time
  3. pace yourself with a client-side token bucket, a little under the limit

Standard library only.  Run:  python client.py
"""

from __future__ import annotations

import math
import random
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError

from limiters import TokenBucket

jitter = random.Random(1)  # seeded so the run is repeatable; use random.uniform in real code


def get(url: str) -> tuple[int, float | None]:
    """One request. Returns the status and the Retry-After value, if any."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"X-Api-Key": "k1"})) as resp:
            return resp.status, None
    except HTTPError as err:
        retry_after = err.headers.get("Retry-After")
        return err.code, float(retry_after) if retry_after else None


def get_with_retry(url: str, polite: bool, attempts: int = 6) -> tuple[bool, int]:
    """Returns (succeeded, number of requests sent)."""
    for attempt in range(1, attempts + 1):
        status, retry_after = get(url)
        if status != 429:
            return status == 200, attempt
        if polite:
            backoff = min(8.0, 0.25 * 2**attempt)  # grows each time: 0.5, 1, 2, 4, 8 s
            # Retry-After is the earliest the server wants us back; jitter spreads clients out
            # so they don't all return in the same millisecond.
            time.sleep((retry_after or 0) + jitter.uniform(0, backoff))
    return False, attempts


class Pacer:
    """A client-side token bucket that waits for a token instead of failing."""

    def __init__(self, rate: float, burst: int) -> None:
        self.bucket = TokenBucket(capacity=burst, rate=rate)

    def wait(self) -> None:
        while not (decision := self.bucket.try_acquire()).allowed:
            time.sleep(decision.retry_after)


def run(name: str, url: str, polite: bool = False, pacer: Pacer | None = None) -> None:
    started, ok, sent = time.monotonic(), 0, 0
    for _ in range(30):
        if pacer:
            pacer.wait()
        succeeded, attempts = get_with_retry(url, polite)
        ok += succeeded
        sent += attempts
    took = time.monotonic() - started
    print(f"{name:<28}{ok:>3}/30 ok  {sent - ok:>3} rejected  {sent:>3} requests sent  {took:4.1f} s")


def start_api() -> tuple[ThreadingHTTPServer, str]:
    buckets: dict[str, TokenBucket] = {}
    lock = threading.Lock()  # the server is threaded, and a bucket is not thread-safe on its own

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            with lock:
                bucket = buckets.setdefault(self.headers["X-Api-Key"], TokenBucket(capacity=5, rate=5))
                decision = bucket.try_acquire()
            if decision.allowed:
                self.send_response(200)
            else:
                self.send_response(429)
                self.send_header("Retry-After", str(math.ceil(decision.retry_after)))
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/orders"


if __name__ == "__main__":
    server, url = start_api()
    run("1. retry at once", url)
    time.sleep(1.5)  # let the server's bucket refill between strategies
    run("2. Retry-After + jitter", url, polite=True)
    time.sleep(1.5)
    run("3. client-side bucket 4.5/s", url, pacer=Pacer(rate=4.5, burst=5))
    server.shutdown()
