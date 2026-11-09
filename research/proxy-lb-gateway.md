# Research: Reverse proxy vs load balancer vs API gateway

Slug: `traffic/proxy-lb-gateway` · comparison page · researched 2026-10-22.
Deep pages for each concept: `reverse-proxies`, `load-balancing`, `api-gateways` (all planned).

Note: direct page fetching was unavailable in this session; facts were checked through search
results that quote the official pages. Items marked (verify) deserve a second look.

## Key facts

- HTTP defines three kinds of intermediary: proxy, gateway and tunnel. A "gateway" in HTTP
  terms is what we call a reverse proxy: it acts as the origin server for outbound connections
  and forwards to inbound servers. RFC 9110 §3.7. https://www.rfc-editor.org/rfc/rfc9110#section-3.7
  - So the word "gateway" already meant "reverse proxy" in the HTTP spec, long before "API
    gateway" products. One root of the confusion.
- Forward proxy acts for the client (chosen by the client); reverse proxy acts for the server
  (chosen by the operator; client doesn't know). RFC 9110 §3.7.
- `Via` header records intermediaries (RFC 9110 §7.6.3). `Forwarded` header standardised in
  RFC 7239 (2014) with `for`, `by`, `host`, `proto`. `X-Forwarded-For` is the de facto older one.
  https://www.rfc-editor.org/rfc/rfc7239 · https://developer.mozilla.org/docs/Web/HTTP/Headers/X-Forwarded-For
  - Client can send its own XFF; only entries added by your own proxies can be trusted. MDN:
    walk from the right, skipping trusted proxy addresses; first untrusted one is the client.
- nginx upstream: default weighted round robin; `least_conn`, `ip_hash`, `hash`; passive health
  checks via `max_fails` (default 1) and `fail_timeout` (default 10 s); single-server group is
  never marked down; active `health_check` is NGINX Plus only.
  https://nginx.org/en/docs/http/ngx_http_upstream_module.html
- Envoy: L3/L4 filter chain at the base, HTTP L7 filter layer on top; designed for service to
  service, used at the edge too. https://www.envoyproxy.io/docs/envoy/latest/intro/what_is_envoy
- AWS NLB: layer 4 (TCP/UDP/TLS), "millions of requests per second", static IP per AZ, preserves
  client IP. https://aws.amazon.com/elasticloadbalancing/network-load-balancer/
- AWS ALB: layer 7, host/path/header rules, idle timeout default 60 s (1–4000 s).
  https://docs.aws.amazon.com/elasticloadbalancing/latest/application/
- AWS API Gateway (REST): default account throttle 10,000 req/s steady with 5,000 burst per region
  (verify pairing), integration timeout 50 ms–29 s; since June 2024 Regional/private REST APIs can
  request more than 29 s (may lower throttle quota). 504 on timeout.
  https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html ·
  https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/
- Google Maglev (NSDI 2016): software L4 LB on commodity Linux, consistent hashing + connection
  tracking, one machine saturates 10 Gbps with small packets, serving Google since 2008.
  https://research.google/pubs/maglev-a-fast-and-reliable-software-network-load-balancer/
- Cloudflare Unimog (2020): XDP/eBPF L4 LB in every edge data centre, spreads connections across
  all servers; L4 is cheap because it doesn't look inside payloads.
  https://blog.cloudflare.com/unimog-cloudflares-edge-load-balancer/
- Cloudflare Pingora (Sept 2022): Rust proxy replacing nginx, >1 trillion req/day, about a third of
  the CPU and memory; nginx's per-worker connection pools hurt reuse.
  https://blog.cloudflare.com/how-we-built-pingora-the-proxy-that-connects-cloudflare-to-the-internet/
- Netflix Zuul 2: edge gateway moved from blocking Servlet (thread per connection) to Netty event
  loop; retries and slow backends drive up connection and thread counts.
  https://netflixtechblog.com/zuul-2-the-netflix-journey-to-asynchronous-non-blocking-systems-45947377fb5c
- Kong: API gateway built on nginx/OpenResty; features as plugins (key-auth, rate-limiting, …).
  https://developer.konghq.com/gateway/
- Kubernetes: community ingress-nginx retired, best-effort maintenance ended March 2026; Gateway
  API (GatewayClass, Gateway, HTTPRoute) is the recommended path.
  https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/ · https://gateway-api.sigs.k8s.io/
- ThoughtWorks Radar, "Overambitious API gateways" (Hold, 2015–2018): keep gateways to generic
  cross-cutting work (auth, rate limits); domain logic belongs in services.
  https://www.thoughtworks.com/radar/platforms/overambitious-api-gateways
- API gateway pattern and Backends for Frontends: microservices.io (Chris Richardson);
  Sam Newman's BFF article. https://microservices.io/patterns/apigateway.html ·
  https://samnewman.io/patterns/architectural/bff/
- Reverse proxy buffering protects app servers from slow clients (slowloris, slow POST): proxy
  reads the full request first (`proxy_request_buffering on` in nginx is the default).
  https://nginx.org/en/docs/http/ngx_http_proxy_module.html

## Real numbers

- nginx `max_fails=1 fail_timeout=10s` defaults.
- ALB idle timeout 60 s default.
- AWS API Gateway 29 s integration timeout default, 10 MB payload limit (REST).
- Maglev: 10 Gbps per machine, small packets.
- Pingora: >1 trillion req/day, ~1/3 CPU and memory.

## Sourced incident

- Cloudflare, 2 July 2019: a WAF rule (running inside the edge proxy) with a backtracking regex
  hit 100% CPU on every HTTP/HTTPS machine; 502s worldwide, about 27 minutes.
  https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/
  Lesson for this page: the box in front of everything is a single shared fate; every feature
  you put in it runs on every request.

## Misconceptions

- "A load balancer is a different box from a reverse proxy." L7 load balancing is a feature of a
  reverse proxy; L4 balancers are not HTTP proxies at all.
- "An API gateway replaces the load balancer." Usually sits behind an L4/L7 LB, and itself
  balances across service instances.
- "You need all three from day one." One nginx/Caddy box often plays all three roles.
- "The gateway is where business logic goes." Radar Hold; it becomes a shared bottleneck.
- "X-Forwarded-For is the client IP." Only the part your own proxies added.
- "Sticky sessions are a feature to want." They are a workaround for server-side state.

## How explainers structure it (and what they leave out)

- Typical blog/video: three definitions, a table, "gateway ⊃ proxy ⊃ LB" Venn diagram.
- Usually missing: L4 vs L7 as the real dividing line; the HTTP spec's own use of "gateway";
  what each box can *see*; trust of forwarded headers; cost of the extra hop; "roles not
  products" with a runnable demo where one process plays each role in turn.
- Our angle: roles, not boxes. Show one ~50-line process switching roles on.

## Further reading (source list)

See the page's Further reading section; every URL above is listed there.

## Added in the 2026-10-22 rewrite

- L4 balancing with long-lived HTTP/2 / gRPC connections is uneven; Kubernetes Services balance
  connections. https://kubernetes.io/blog/2018/11/07/grpc-load-balancing-on-kubernetes-without-tears/
- Envoy least-request uses power of two choices; slow start mode exists for round robin and least
  request. https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers
- Retries at several layers multiply; deadlines and retry budgets. Google SRE book, "Addressing
  cascading failures". https://sre.google/sre-book/addressing-cascading-failures/
- ECMP and anycast in front of L4 balancers; Maglev uses consistent hashing plus connection tracking.
- Sim results (our model, seed 42): 4 connections / 6 backends: L4 leaves 2 idle; 8 connections: L4
  p95 ~1.9 s vs ~32 ms at L7; backend 1 3× slower: round robin p95 ~1.5 s vs ~45 ms least
  outstanding. Timeouts 1.2 s service / 1 s gateway / 1.5 s client with 2 retries per hop: ~6 service
  calls per click, >90% of service work wasted, ~half of clicks fail.

## Sources changed in the November 2026 rewrite

- Removed (pre-2020, not famous history): Kubernetes blog "gRPC load balancing without tears" (2018),
  Netflix Zuul 2 (2016), Google SRE book chapter (2016), ThoughtWorks Radar "overambitious API
  gateways" (2015–2018), Sam Newman BFF article (2015), microservices.io API gateway page (undated).
- Replaced with: Kubernetes docs "Virtual IPs and service proxies" (current) for per-connection
  Service balancing; gRPC repository load-balancing doc (updated 2021) and gRPC retry guide (current);
  Marc Brooker, "Fixing retries with token buckets and circuit breakers" (28 Feb 2022, confirmed by
  search) for retry storms and retry budgets; Azure Architecture Center "Gateway Offloading" (current;
  says business logic should never be offloaded to the gateway, confirmed by search) and "Backends for
  Frontends" (current). learn.microsoft.com and brooker.co.za could not be fetched from this session
  (network policy); both were checked through search results only.
- Kept as dated history: Maglev (NSDI 2016), the Cloudflare outage of 2 July 2019.

## Fresher read (2026-11-09, rewrite under the November standard)

Min read 33 → 49 (comparison page; usual 35–50, max 60).

Fixed:
- The page opened with an L4/gRPC puzzle a fresher could not parse. It now opens with "what is the
  box in front of the servers, and is it three machines?", answered on the first screen. The gRPC
  puzzle moved to "Going deeper".
- New Part 1: one running example (Asha's `GET /orders/42`, an orders service good for 100 req/s,
  180 req/s at peak, 3 copies, one crash), a new mental-model diagram, and five building blocks in
  four steps: proxy (forward vs reverse), backends and a pool, connection vs request (with keep-alive
  and round trips), layer 4 vs layer 7, API keys and rate limits.
- Terms that arrived unexplained now get a plain sentence first: terminating, TLS records, timeout,
  sync worker, CDN, HTTP/2 streams (four steps), gRPC, Kubernetes pod and Service, in flight, queue,
  utilisation, hash function, p95 (four steps), median, tail, cache, slow start, single point of
  failure, router, BGP, ECMP, consistent hashing and `hash mod N`, anycast, aggregation, retry,
  retry storm, deadline, idempotency key, retry budget, file descriptor, PROXY protocol, signed token,
  service mesh, north-south and east-west.
- Every derived number shows its working: buffering (4 × 0.5 = 2 vs 4 × 50 = 200 req/s), 216,000
  requests (60 × 3,600), queue growth past 100%, power of two choices (3/10 × 2/9 = 6/90 ≈ 7%), the
  p95 average (13,880 ÷ 100), 1 − 0.95²⁰ in words, the slow backend (40 − 33 = 7/s), health-check
  window (5 × 3 = 15 s, 15 × 100 = 1,500), three quarters moving under `hash mod N` (values 0–11),
  aggregation (450 vs 153 ms), retries (3 × 3 = 9, 27), check-yourself 3 (4 × 3 = 12), the nginx
  `18r/m` limit (18 ÷ 6 = 3 per 10 s), the retry budget (1,000 × 0.10 = 100/s).
- The keep-alive race is now four numbered steps. A "read it like this" paragraph follows the code.
- Tagline was a claim needing the page to decode; now one plain sentence.
- Part 2 rate-limit example made consistent with Part 1 (100 calls a minute on the free plan).

Three-sentence explanation a student could give after Part 1 alone: "The box in front of a
company's servers receives every request; as a reverse proxy it passes requests on and handles
chores like HTTPS, as a load balancer it spreads them over several identical copies and skips dead
ones, and as an API gateway it checks who is calling before choosing the right service. These are
three jobs, not three machines, so one nginx can do all of them. What really separates them is how
much of the request a box reads: a layer 4 box sees only connections, a layer 7 box reads each
request."
