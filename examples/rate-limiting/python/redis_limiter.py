"""Production-shaped rate limiting: a token bucket shared by every app server, kept in Redis.

- Atomic: the read, the decision and the write happen inside one Lua script, so two servers
  can never both spend the last token.
- One clock: the script reads Redis's own TIME, so app servers with drifting clocks agree.
- Fails open: if Redis is slow or down, we log it and let the request through.
- Speaks HTTP: 429, Retry-After, and the IETF draft RateLimit / RateLimit-Policy fields.

Needs Redis on localhost:6379 and the client library:
    pip install -r requirements.txt
Run:  python redis_limiter.py
"""

from __future__ import annotations

import logging
import math
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError

import redis

log = logging.getLogger("ratelimit")

TOKEN_BUCKET_LUA = """
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])          -- tokens added per second
local cost     = tonumber(ARGV[3])
local t   = redis.call('TIME')              -- Redis's clock, not the app server's
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity   -- a new key starts with a full bucket
local ts     = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)

local allowed, retry_after = 0, 0
if tokens + 1e-9 >= cost then
  tokens = math.max(0, tokens - cost)
  allowed = 1
else
  retry_after = (cost - tokens) / rate
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Forget idle clients once their bucket would be full again anyway.
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 1000) + 1000)
return { allowed, tostring(tokens), tostring(retry_after) }   -- Lua numbers become integers
"""


@dataclass(frozen=True)
class Result:
    allowed: bool
    tokens: float  # left in the bucket after this request
    retry_after: float  # seconds; 0 when allowed


class RedisTokenBucket:
    def __init__(self, client: redis.Redis, capacity: int, rate: float) -> None:
        self.capacity, self.rate = capacity, rate
        self.script = client.register_script(TOKEN_BUCKET_LUA)  # sent once, then run by hash

    def try_acquire(self, key: str, cost: int = 1) -> Result:
        try:
            allowed, tokens, retry = self.script(keys=[f"rl:{key}"], args=[self.capacity, self.rate, cost])
        except redis.RedisError as err:
            # Fail open: a broken limiter should not become a broken API. Alert on this log.
            log.warning("rate limiter unavailable, allowing request: %s", err)
            return Result(True, self.capacity, 0.0)
        return Result(bool(allowed), float(tokens), float(retry))

    def headers(self, result: Result) -> dict[str, str]:
        window = math.ceil(self.capacity / self.rate)
        full_in = math.ceil((self.capacity - result.tokens) / self.rate)
        headers = {
            "RateLimit-Policy": f'"default";q={self.capacity};w={window}',
            "RateLimit": f'"default";r={math.floor(result.tokens)};t={full_in}',
        }
        if not result.allowed:
            headers["Retry-After"] = str(max(1, math.ceil(result.retry_after)))  # whole seconds
        return headers


TRUSTED_PROXIES = {"127.0.0.1"}  # the addresses of YOUR load balancers, nothing else


def client_key(peer: str, api_key: str | None, forwarded_for: str | None) -> str:
    """Who to count. An API key beats an IP. X-Forwarded-For is only believed when it was
    added by our own proxy; anyone else can type whatever they like into that header."""
    if api_key:
        return f"key:{api_key}"
    if forwarded_for and peer in TRUSTED_PROXIES:
        return "ip:" + forwarded_for.split(",")[-1].strip()  # the address our proxy saw
    return f"ip:{peer}"


def make_handler(limiter: RedisTokenBucket) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            key = client_key(self.client_address[0], self.headers.get("X-Api-Key"), self.headers.get("X-Forwarded-For"))
            result = limiter.try_acquire(key)
            self.send_response(200 if result.allowed else 429)
            for name, value in limiter.headers(result).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(b"ok\n" if result.allowed else b"slow down\n")

        def log_message(self, *args: object) -> None:  # keep the demo output readable
            pass

    return Handler


# ----------------------------------------------------------------------------- demos


def demo_race(client: redis.Redis) -> None:
    """Twenty requests at once, on twenty threads, against a limit of 10."""
    client.delete("naive:203.0.113.7", "rl:race")
    gate, naive_ok, lua_ok = threading.Barrier(20), [], []

    def naive() -> None:
        gate.wait()
        count = int(client.get("naive:203.0.113.7") or 0)  # check...
        time.sleep(0.002)  # the app does a little work in between
        if count < 10:
            client.set("naive:203.0.113.7", count + 1)  # ...then act
            naive_ok.append(1)

    limiter = RedisTokenBucket(client, capacity=10, rate=0.001)  # almost no refill during the test

    def atomic() -> None:
        gate.wait()
        if limiter.try_acquire("race").allowed:
            lua_ok.append(1)

    for target in (naive, atomic):
        threads = [threading.Thread(target=target) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        gate.reset()
    print(f"race, GET then SET: {len(naive_ok)} of 20 accepted (limit 10)")
    print(f"race, Lua script:   {len(lua_ok)} of 20 accepted (limit 10)")


def demo_http(client: redis.Redis) -> None:
    client.delete("rl:key:demo-key")
    limiter = RedisTokenBucket(client, capacity=10, rate=2)  # burst of 10, then 2 per second
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(limiter))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/products"

    statuses, last = [], None
    for _ in range(12):
        req = urllib.request.Request(url, headers={"X-Api-Key": "demo-key"})
        try:
            with urllib.request.urlopen(req) as resp:
                statuses.append(resp.status)
        except HTTPError as err:
            statuses.append(err.code)
            last = err.headers
    server.shutdown()
    print(f"12 quick requests:  {statuses}")
    print(f"the 429 said:       Retry-After: {last['Retry-After']}   RateLimit: {last['RateLimit']}")
    print(f"                    RateLimit-Policy: {last['RateLimit-Policy']}")


def demo_fail_open() -> None:
    dead = redis.Redis(port=6390, socket_connect_timeout=0.05, socket_timeout=0.05)  # nothing listens
    result = RedisTokenBucket(dead, capacity=10, rate=2).try_acquire("key:demo-key")
    print(f"Redis down:         allowed={result.allowed} (failed open, see the warning above)")


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stdout, format="%(levelname)s %(name)s: %(message)s")
    # Short timeouts: the limiter must never add more than a few milliseconds to a request.
    client = redis.Redis(host="localhost", port=6379, socket_connect_timeout=0.1, socket_timeout=0.1)
    print(f"connected to Redis {client.info('server')['redis_version']}")
    demo_race(client)
    demo_http(client)
    demo_fail_open()
