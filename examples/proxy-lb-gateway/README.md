# Reverse proxy vs load balancer vs API gateway: runnable examples

The code behind the snippets on the
[Reverse Proxy vs Load Balancer vs API Gateway](https://seniordevnotes.netlify.app/traffic/proxy-lb-gateway/)
page. Python 3.11+ and Node 20+, standard library only, nothing to install. Everything runs on
`127.0.0.1` and works offline.

| File | What it shows |
|---|---|
| `python/front_door.py` / `js/front-door.mjs` | One process that plays each role in turn: reverse proxy (forward, overwrite `X-Forwarded-For`), load balancer (round robin, mark a dead backend down for 10 s), API gateway (API key, per-key limit, routing by path) |
| `nginx/nginx.conf` + `nginx/test-nginx.sh` | The same three roles in one nginx config |

The demo uses ports 8081–8083 (front doors) and 9001–9003 (backends); nginx uses 8080.

## Run

```bash
python python/front_door.py
node js/front-door.mjs
bash nginx/test-nginx.sh                          # uses `nginx` from your PATH and python3
NGINX_BIN=/path/to/nginx bash nginx/test-nginx.sh # or point it at a binary
```

## What to expect

- **Reverse proxy.** Every request reaches `orders-1`. The client sent `X-Forwarded-For: 6.6.6.6`;
  the backend sees `127.0.0.1`, because the proxy overwrites the header instead of trusting it.
- **Load balancer.** Requests alternate `orders-1`, `orders-2`. After `orders-2` is stopped, the
  first request that lands on it fails over to `orders-1` inside the same request, and `orders-2`
  is skipped for the next 10 s.
- **API gateway.** No key gets 401. Asha's fourth request inside 10 s gets 429. `/users/...` goes
  to a different service, and `/admin` has no route (404). Backends see `x_user`, never the key.
- **nginx.** The same results, from `upstream`, `map`, `limit_req` and `proxy_set_header`.

Tested on 2026-10-22 with Python 3.13.16, Node 22.22.0 and nginx 1.24.0 on Ubuntu 24.04.
Python and Node print the same lines (Python prints dicts, Node prints JSON).
