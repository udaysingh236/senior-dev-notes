# Timeouts — research notes

Track: resilience · slug: `timeouts` · researched 2026-11-06. Docs read from their sources on GitHub
or the vendor's site; versions as of November 2026.

## Already covered elsewhere (link, don't repeat)

- Timeouts shrinking inward across hops, retries multiplying (3 × 3 = 9), retry budgets, idle
  keep-alive race (ALB 60 s vs Node 5 s): `traffic/proxy-lb-gateway` ("What every extra hop costs").
- A timeout on POST is ambiguous; idempotency keys; 202 + polling for long work: `networking/rest-api-design`.
- A connect with no timeout waits for the OS (Linux `tcp_syn_retries` 6, measured 21–135 s): `foundations/how-the-web-works`.
- Pool acquire timeout shorter than the request deadline; `idle_in_transaction_session_timeout`: `databases/connection-pooling`.

## Key facts, with sources

- **requests**: no timeout by default ("requests do not time out unless a timeout value is set
  explicitly"); `timeout=5` sets connect and read; read = seconds *between bytes* from the server;
  "neither the connect nor read timeouts are wall clock"; connect timeout applies per IP address,
  so IPv4 + IPv6 can double it. Source: psf/requests `docs/user/advanced.rst`, `quickstart.rst`.
- **Python socket**: `settimeout(value)` bounds each blocking socket operation. CPython `Doc/library/socket.rst`.
- **httpx**: timeouts on by default, 5 s of network inactivity (connect, read, write, pool). `docs/advanced/timeouts.md`.
- **Node http client**: `timeout` option = socket timeout; `'timeout'` event "only notifies that the
  socket has been idle. The request must be destroyed manually." `doc/api/http.md`.
- **Node http server**: `headersTimeout` default min(requestTimeout, 60 s) (since 18.14/19.4);
  `requestTimeout` 300 s (since 18.0, was none); `server.timeout` 0; `keepAliveTimeout` 5 s on
  released lines, changing to 65 s in v27 (main branch, PR 62782).
- **fetch in Node (undici)**: `headersTimeout` 300 s, `bodyTimeout` 300 s between body chunks.
  `AbortSignal.timeout(ms)` (Node 17.3/16.14) and `AbortSignal.any` (20.3/18.17). undici `docs/docs/api/Client.md`, Node `globals.md`.
- **Go**: `http.Client.Timeout` includes connection, redirects and reading the body; zero = none;
  `DefaultClient` has none. `Server.ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout` zero = none. `src/net/http/client.go`, `server.go`.
- **nginx**: `proxy_read_timeout` 60 s "between two successive read operations, not for the
  transmission of the whole response"; `proxy_connect_timeout` 60 s; `client_header_timeout`,
  `client_body_timeout`, `send_timeout` 60 s. nginx.org XML docs.
- **Envoy**: route timeout default 15 s, starts only after the whole request is received;
  `per_try_timeout`; stream idle timeout 5 min; connection idle 1 h. Envoy sets
  `x-envoy-expected-rq-timeout-ms` on upstream requests so the upstream can exit early.
  `docs/root/faq/configuration/timeouts.rst`, router filter docs.
- **gRPC**: no deadline by default (clients can wait "effectively forever"); server cancels the call
  when the deadline passes but the application must stop its own work; propagation automatic in
  Java and Go, explicit in C++; deadline converted to a timeout minus elapsed time to avoid clock
  skew. grpc.io `docs/guides/deadlines.md`.
- **PostgreSQL**: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`,
  `idle_session_timeout` (14), `transaction_timeout` (17); all 0 = off by default.
  `client_connection_check_interval` (14) default 0: a query runs on after its client disconnects.
  `doc/src/sgml/config.sgml`.
- **AWS SDKs smart defaults** (as of Nov 2026): connect and TLS timeouts 3,100 ms standard,
  1,100 ms in-region, 3,100 ms cross-region, 30,000 ms mobile. docs.aws.amazon.com sdkref.
- **Cloudflare**: 524 after the default 125 s Proxy Read Timeout; 30 s Proxy Write Timeout;
  Enterprise up to 6,000 s. developers.cloudflare.com error 524.

## Our measurements (examples/timeouts)

- Server sends 20 bytes one per second. Python `urlopen(timeout=3)`: 20 bytes after 20.0 s, no
  error. Node `http.get({timeout: 3000})`: same, no `'timeout'` event. `fetch()` with no options: 20.0 s.
  Total deadline (Python socket timeout set to remaining time before each read; JS
  `AbortSignal.timeout`): failed at 3.0 s.
- Server silent 6 s, Node `http.get({timeout: 3000})` with a logging-only handler: event at 3.0 s,
  answer at 6.0 s.
- Handler needing 2 s, client deadline 0.5 s: ignoring handler finished at 2.0 s for nobody;
  deadline-aware handler stopped after 2 of 10 steps at 0.4 s with 504.
- PostgreSQL 16.15: client killed 1 s into `pg_sleep(8)`: query still active at 2 s, ran to the
  end. With `client_connection_check_interval = 500ms`: gone by 2 s. Cancel request: gone at once.
  `statement_timeout = 1s`: error at 1.0 s. `lock_timeout = 500ms`: error at 0.5 s.

## Incident

- **Canva, 12 Nov 2024** (report Dec 2024): one JS asset fetch took 20 minutes through Cloudflare
  (packet loss up to ~66% on an IPv6 path); 270,000+ requests waited on the same cache stream;
  canary saw no errors "because requests didn't complete"; when the fetch finished, 1.5M req/s
  hit the API gateway (3× peak); gateway tasks OOM-killed; canva.com down 9:08–~10:00 UTC. Action
  items include asset-fetch timeouts and page-load completion as a canary signal.

## Misconceptions

- "timeout=5 means the call takes at most 5 s": read timeouts bound silence between bytes.
- "The client timed out, so the server stopped": the server keeps working unless told.
- "Longer timeouts are safer": they turn a slow dependency into a full worker pool.
- "Set every timeout to the same 30 s": the inner one must be shorter, and the number should come
  from the dependency's latency and the caller's budget.
- A hang produces no error: error-rate alerts and canaries miss it.

## Explainers (what they leave out)

Most posts list "set connect and read timeouts" and stop. Rarely: that read timeouts are per-gap,
the capacity arithmetic of hung calls, deadline propagation with remaining time, and that a
timeout does not cancel server or database work. That is our angle, with measurements.

## Sources (with year)

requests docs (living), CPython socket docs (living), httpx docs (living), Node.js http and globals
docs (living), undici docs (living), Go net/http source docs (living), nginx docs (living), Envoy
timeouts FAQ and router docs (living), gRPC deadlines guide (living), PostgreSQL config docs
(living), AWS SDK smart configuration defaults (living), Cloudflare error 524 docs (living), Canva
incident report (2024).
