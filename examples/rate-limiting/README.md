# Rate limiting: runnable examples

The code behind every snippet on the [Rate Limiting](https://seniordevnotes.netlify.app/resilience/rate-limiting/)
page. Python 3.11+ and Node 20+. Every file prints its results, so you can check them against
the page.

| File (Python / JavaScript) | What it shows | Needs |
|---|---|---|
| `limiters.py` / `limiters.mjs` | Token bucket, leaky bucket (queue), GCRA, fixed window, sliding log and sliding window counter, with a fake clock. Running it prints small self-checks. | nothing |
| `compare.py` / `compare.mjs` | All six on the same traffic: how many got through, and the most in any 10 s and any 1 s | nothing |
| `naive_limiter.py` / `naive-limiter.mjs` | The in-memory limiter most people write first, and four ways it fails | nothing |
| `redis_limiter.py` / `redis-limiter.mjs` | Token bucket in a Redis Lua script: the GET-then-SET race it prevents, the client key from `X-Forwarded-For`, HTTP headers, reserve-and-refund by cost, and failing open, closed or to a local share when Redis is down (including how long the client library's default retries take) | Redis + client library |
| `client.py` / `client.mjs` | Retrying at once vs honouring Retry-After vs pacing with a client-side bucket | nothing |
| `nginx/nginx.conf` + `nginx/test-nginx.sh` | nginx `limit_req` at the edge: a burst of 20 gets 11 through and 9 × 429 | nginx, curl, bash |

## Run

```bash
# Python
cd python
python limiters.py
python compare.py
python naive_limiter.py
python client.py

# JavaScript
cd js
node limiters.mjs
node compare.mjs
node naive-limiter.mjs
node client.mjs
```

## The Redis examples

Start a Redis server on `localhost:6379`. Any of these works:

- Docker: `docker run --rm -p 6379:6379 redis:8`
- macOS: `brew install redis && redis-server`
- Ubuntu or WSL: `sudo apt install redis-server && redis-server`

Then:

```bash
# Python
cd python
python -m venv .venv
.venv/bin/pip install -r requirements.txt      # on Windows: .venv\Scripts\pip
.venv/bin/python redis_limiter.py              # on Windows: .venv\Scripts\python

# JavaScript
cd js
npm install
node redis-limiter.mjs
```

The "GET then SET" race line can change from run to run (it depends on thread timing); the Lua
line always says 10 of 20. The "Redis down" demos point at port 6390 on purpose, so the warnings
they print are expected. The "default client" line takes a few seconds in Python (redis-py retries
the connection with backoff) and gives up after 3 s in Node (node-redis queues the command while it
reconnects): that delay is the point of the demo.

## The nginx example

```bash
bash nginx/test-nginx.sh                          # uses `nginx` from your PATH
NGINX_BIN=/path/to/nginx bash nginx/test-nginx.sh # or point it at a binary
```

It starts nginx on `127.0.0.1:8088` with the config in this folder, fires 20 requests in
parallel, waits a second, sends 5 more, and stops nginx again.

Tested on 2026-10-22 with nginx 1.24.0, Python 3.13.16, Node 22.22.0, Redis 7.0.15, redis-py 8.1.0 and
node-redis 6.3.0.
