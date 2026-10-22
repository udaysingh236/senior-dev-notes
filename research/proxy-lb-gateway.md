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
