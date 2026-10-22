"""Production-shaped rate limiting: a token bucket shared by every app server, kept in Redis.

- Atomic: the read, the decision and the write happen inside one Lua script, so two servers
  can never both spend the last token.
- One clock: the script reads Redis's own TIME, so app servers with drifting clocks agree.
- Decides what happens when Redis is slow or down: fail open, fail closed, or fall back to a
  local bucket holding this node's share of the limit.
- Counts cost, not requests: a call can take many tokens, and give back what it did not use.
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
from redis.backoff import NoBackoff
from redis.retry import Retry

from limiters import TokenBucket

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
  tokens = math.min(capacity, math.max(0, tokens - cost))   -- a negative cost is a refund
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
    def __init__(self, client: redis.Redis, capacity: int, rate: float, when_down: str = "open", nodes: int = 1) -> None:
        self.capacity, self.rate = capacity, rate
        self.script = client.register_script(TOKEN_BUCKET_LUA)  # sent once, then run by hash
        self.when_down, self.nodes = when_down, nodes  # "open", "closed" or "local"
        self.local: dict[str, TokenBucket] = {}  # fallback buckets, used only while Redis is down
        self.down = False

    def try_acquire(self, key: str, cost: int = 1) -> Result:
        try:
            allowed, tokens, retry = self.script(keys=[f"rl:{key}"], args=[self.capacity, self.rate, cost])
            self.down = False
            return Result(bool(allowed), float(tokens), float(retry))
        except redis.RedisError as err:
            if not self.down:  # log the transition once, not once per request
                log.warning("rate limiter store unavailable, failing %s: %s", self.when_down, err)
                self.down = True
        if self.when_down == "closed":
            return Result(False, 0.0, 1.0)
        if self.when_down == "local":
            # This node's share of the limit. Assumes the load balancer spreads clients evenly.
            bucket = self.local.setdefault(key, TokenBucket(self.capacity // self.nodes, self.rate / self.nodes))
            d = bucket.try_acquire(cost)
            return Result(d.allowed, float(d.remaining), d.retry_after)
        return Result(True, float(self.capacity), 0.0)  # open: the API stays up, unprotected

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


# YOUR load balancers and CDN, nothing else. Real CDNs publish address ranges; check ranges then.
TRUSTED_PROXIES = {"127.0.0.1", "10.0.0.5", "198.51.100.2"}


def client_key(peer: str, api_key: str | None, forwarded_for: str | None) -> str:
    """Who to count. An API key beats an IP. X-Forwarded-For is only believed when the
    connection came from our own proxy, and only the entries our proxies appended."""
    if api_key:
        return f"key:{api_key}"
    if peer not in TRUSTED_PROXIES or not forwarded_for:
        return f"ip:{peer}"  # a direct connection: the socket address is the only truth
    hops = [hop.strip() for hop in forwarded_for.split(",")]
    for hop in reversed(hops):  # right to left: the newest entries were added by our proxies
        if hop not in TRUSTED_PROXIES:
            return f"ip:{hop}"  # the first address that is not one of ours
    return f"ip:{hops[0]}"


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


def demo_keys() -> None:
    chain = "6.6.6.6, 203.0.113.7, 198.51.100.2"  # forged, real client, our CDN
    print(f"key via LB:         {client_key('10.0.0.5', None, chain)}")
    print(f"key, direct caller: {client_key('203.0.113.9', None, '6.6.6.6')}")


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


def demo_cost(client: redis.Redis) -> None:
    """Count cost, not requests: reserve the worst case up front, refund what was not used."""
    client.delete("rl:tpm:demo-key")
    tpm = RedisTokenBucket(client, capacity=10_000, rate=10_000 / 60)  # 10,000 tokens a minute
    first = tpm.try_acquire("tpm:demo-key", cost=4_000)  # 1,000 prompt + max_tokens of 3,000
    print(f"cost: reserve 4,000 of 10,000  -> {first.tokens:,.0f} left")
    big = tpm.try_acquire("tpm:demo-key", cost=7_000)
    print(f"cost: a 7,000 call now         -> {'allowed' if big.allowed else '429'}, retry in {big.retry_after:.1f} s")
    refund = tpm.try_acquire("tpm:demo-key", cost=-2_400)  # the reply used 600 of the 3,000
    big = tpm.try_acquire("tpm:demo-key", cost=7_000)
    print(f"cost: refund the unused 2,400  -> {refund.tokens:,.0f} left, the 7,000 call is {'allowed' if big.allowed else 'rejected'}")


def fast_fail_client(**kwargs: object) -> redis.Redis:
    """Short timeouts and no retries: the limiter must never add more than a few ms to a request.
    redis-py's default client retries a failed connection with backoff, which can take seconds."""
    return redis.Redis(socket_connect_timeout=0.05, socket_timeout=0.05, retry=Retry(NoBackoff(), 0), **kwargs)


def demo_store_down() -> None:
    logging.disable(logging.WARNING)  # the timing demo would print the same warning twice
    for label, dead in (("default client:", redis.Redis(port=6390, socket_connect_timeout=0.05, socket_timeout=0.05)),
                        ("retries off:", fast_fail_client(port=6390))):  # nothing listens on 6390
        start = time.monotonic()
        result = RedisTokenBucket(dead, capacity=10, rate=2).try_acquire("key:demo-key")
        print(f"Redis down, {label:<15} allowed={result.allowed} after {time.monotonic() - start:.2f} s")
    logging.disable(logging.NOTSET)
    print("Redis down, 12 quick requests from one key:")
    for mode in ("open", "closed", "local"):
        limiter = RedisTokenBucket(fast_fail_client(port=6390), capacity=10, rate=2, when_down=mode, nodes=2)
        allowed = sum(limiter.try_acquire("key:demo-key").allowed for _ in range(12))
        print(f"  when_down={mode:<7} {allowed:>2} allowed")


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stdout, format="%(levelname)s %(name)s: %(message)s")
    client = fast_fail_client(host="localhost", port=6379)
    print(f"connected to Redis {client.info('server')['redis_version']}")
    demo_race(client)
    demo_keys()
    demo_http(client)
    demo_cost(client)
    demo_store_down()
