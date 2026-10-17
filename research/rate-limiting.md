# Research notes: Rate Limiting

Track: `resilience` · Slug: `rate-limiting` · Order: 5 · Post #: 2 · Researched: 2026-10-17

Notes for understanding, not for pasting. Quotes kept under 15 words.

## Key facts, with sources

### The HTTP contract

- **429 Too Many Requests** is defined in RFC 6585 §4: the user sent too many requests in a given
  time. The response should explain the condition, may include `Retry-After`, and **must not be
  cached**. The RFC deliberately does not say how to identify users or count requests (per resource,
  per server, across servers, by credentials or cookie are all allowed).
  https://www.rfc-editor.org/rfc/rfc6585#section-4
- **Retry-After** (RFC 9110 §10.2.3) takes either a number of seconds or an HTTP-date. Used with
  429 and 503. https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
- **IETF RateLimit headers**: `draft-ietf-httpapi-ratelimit-headers-11`, dated 23 May 2026, still an
  Internet-Draft (Standards Track intended, no RFC number yet). Defines two fields:
  - `RateLimit-Policy: "burst";q=100;w=60` — the policy: quota `q`, window `w` seconds, optional
    quota unit `qu` (requests, content-bytes, concurrent-requests), optional partition key `pk`.
  - `RateLimit: "default";r=50;t=30` — current state: remaining `r`, seconds until reset `t`.
  - Also defines problem types: quota-exceeded, temporary-reduced-capacity, abnormal-usage-detected.
  https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
- The `X-RateLimit-Limit / -Remaining / -Reset` trio is a de facto convention, not a standard
  (redis.io tutorial says so explicitly). GitHub and Discord both use variants of it.

### Algorithms (what each stores, how it behaves)

- **Token bucket**: capacity C, refill rate r. Each request takes a token; empty bucket = reject.
  In any interval T at most C + r·T requests pass. Used by Stripe, AWS API Gateway, Envoy local
  rate limit. Stores two numbers (tokens, last refill time) if refill is computed lazily.
- **Leaky bucket** has two meanings (redis.io tutorial makes this explicit, many explainers don't):
  - *as a meter (policing)*: a level that drains at a fixed rate; reject if full. Mathematically
    the mirror image of the token bucket (starts empty and fills vs starts full and drains).
  - *as a queue (shaping)*: requests wait in a FIFO and leave at a fixed rate; overflow dropped.
    Adds latency, smooths output perfectly.
  - nginx `limit_req` is a leaky bucket; `burst` = queue size, `nodelay` serves the burst
    immediately instead of spacing it out. https://nginx.org/en/docs/http/ngx_http_limit_req_module.html
- **GCRA (generic cell rate algorithm)**: a leaky-bucket variant from ATM networking. Stores one
  value, the theoretical arrival time (TAT). Allow if `TAT − burst_tolerance ≤ now`, then
  `TAT = max(TAT, now) + emission_interval`. No background drip. Brandur (2015) recommends using
  the data store's clock (Redis `TIME`) to avoid drift between app servers.
  https://brandur.org/rate-limiting · redis-cell module `CL.THROTTLE key max_burst count period [qty]`
  returns 5 ints (limited, limit, remaining, retry_after, reset_after); "best effort" maintenance.
  https://github.com/brandur/redis-cell
- **Fixed window counter**: one counter per (key, window number), `INCR` + `EXPIRE`. Cheapest.
  Boundary problem: up to 2× the limit inside one window-length span straddling a boundary
  (redis.io: 10 at second 9 and 10 at second 11 under "10 per 10 s"). Brandur: also causes
  synchronized bursts at every reset, and one buggy script can lock a user out for the rest of the
  window (he was locked out of GitHub for ~51 minutes).
- **Sliding window log**: store every timestamp (Redis sorted set: `ZREMRANGEBYSCORE`, `ZCARD`,
  `ZADD`). Exact, but memory is O(limit) per key. Figma estimated ~20 MB for 500 req/day × 10,000
  users. https://www.figma.com/blog/an-alternative-approach-to-rate-limiting
- **Sliding window counter**: two counters (previous and current window), estimate =
  `prev × (1 − elapsed_fraction) + curr`. Cloudflare's worked example: 42 prev, 18 curr, 15 s into
  a 60 s window, limit 50 → 42 × 0.75 + 18 = 49.5. Assumes previous window's traffic was even.
  Cloudflare measured on 400 M requests from 270 K sources: 0.003% wrongly allowed or limited,
  average 6% difference from true rate, 3 false negatives (all < 15% over), 0 false positives.
  https://blog.cloudflare.com/counting-things-a-lot-of-different-things/ (June 2017)
  - Figma's variant: split the window into 60 sub-window counters in a Redis hash; ~2.4 MB for
    the same scenario as above.
  - Note to verify in code (Phase 6): worst case is when the previous window's traffic is bunched
    at its end; true rolling count can approach 2× but never in a sharp burst like fixed window.

### Atomicity and distributed limiting

- Read-check-write as separate Redis commands is a TOCTOU race: two concurrent requests read the
  same counter and both pass. `MULTI/EXEC` can't branch on a value read inside it; `WATCH` retries
  badly under contention; **Lua via `EVAL` is the standard fix** (atomic, one round trip).
  `INCR` then a separate `EXPIRE` can leave a key with no TTL if the process dies in between,
  locking the client out forever. Redis Cluster: multi-key scripts need hash tags `{key}`.
  https://redis.io/tutorials/howtos/ratelimiting/ (Feb 2026, updated Mar 2026)
- Figma (2017) rejected a non-Lua token bucket because the read-then-write race made it
  "too lenient" under concurrency.
- AWS Builders' Library, "Fairness in multi-tenant systems" (David Yanacek, 2020), three ways to
  share a limit across a fleet:
  1. each server enforces limit / N locally (breaks with uneven load balancing, DNS caching,
     long-lived connections);
  2. consistent-hash each key to a tracker server (scales, but hot keys);
  3. servers share observed rates asynchronously (flexible, harder to get accurate).
  Also: chain two token buckets (low rate/high burst + high rate/low burst) to allow bursts but
  bound their intensity; give expensive APIs lower quotas; test rules in evaluation mode first;
  429 for "you sent too much", 503 for "we are out of capacity".
  https://builder.aws.com/content/3Eupj3d2bo4fEvlzYbICMZNhQ3B/fairness-in-multi-tenant-systems
- Cloudflare does not share counters between data centres: anycast sends one client to one PoP,
  counters live in memcache per PoP behind Twemproxy (consistent hashing), increments are async,
  and a "mitigate this client" flag is cached locally once a client crosses the threshold.
- Envoy: **local** rate limit = token bucket per Envoy process (shared across workers by default),
  returns 429 + `x-envoy-ratelimited`, optional `Retry-After`. **Global** = gRPC call to a rate
  limit service (reference impl in Go on Redis). Envoy recommends both: local first to absorb
  bursts and protect the global service, then global for precise limits. `failure_mode_deny`
  is false unless set, so unreachable service = traffic allowed (fail open). Shadow mode via
  `filter_enabled` vs `filter_enforced` percentages.
  https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/local_rate_limit_filter
  https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting

### How real systems do it (numbers that can change: "as of October 2026")

- **Stripe** (docs, Oct 2026): global 100 req/s live, 25 req/s sandbox; most endpoints 25 req/s;
  concurrency limit 50 in-flight requests in live mode; 429 with `Stripe-Rate-Limited-Reason`
  (`global-rate`, `endpoint-rate`, `global-concurrency`, `endpoint-concurrency`,
  `resource-specific`). Recommends backoff with jitter and a **client-side token bucket**.
  Note: 429 `lock_timeout` is not a rate limit. https://docs.stripe.com/rate-limits
- **Stripe engineering** (Paul Tarjan, March 2017): four limiters — request rate (token bucket,
  per user, Redis), concurrent requests (~12,000 triggers/month), fleet usage load shedder
  (reserve e.g. 20% for critical traffic, 503), worker utilization load shedder. Rollout advice:
  fail open, dark launch, kill switches, clear error messages, start with the request rate limiter.
  https://stripe.com/blog/rate-limiters
- **GitHub REST API** (docs, Oct 2026): 60/hour unauthenticated (per IP), 5,000/hour
  authenticated, 15,000 for Enterprise Cloud apps; secondary limits: 100 concurrent requests,
  900 points/min REST (reads 1 point, writes 5), 90 s CPU per 60 s real time. Headers
  `x-ratelimit-limit/remaining/used/reset/resource`. 403 or 429. Keep sending while limited and
  the integration can be banned.
  https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- **AWS API Gateway**: token bucket; rate = refill, burst = bucket size; applied per-client
  (usage plan) → per-method → account per Region → AWS Regional. Explicitly "best-effort",
  "targets rather than guaranteed request ceilings".
  https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html
- **Discord**: per-route buckets identified by `X-RateLimit-Bucket`, global 50 req/s per bot,
  429 body with `retry_after` (float seconds) and `global`; 10,000 invalid requests (401/403/429)
  in 10 minutes gets a temporary Cloudflare ban. "Don't hard-code limits", read the headers.
  https://docs.discord.com/developers/topics/rate-limits
- **nginx** `limit_req_zone $binary_remote_addr zone=one:10m rate=1r/s;` — 1 MB holds about
  8,000 states on 64-bit; default reject status is **503** (`limit_req_status` to change it to
  429); `limit_req_dry_run on` counts without rejecting; zone full → LRU eviction.

### Google SRE book, "Handling Overload"

- QPS is a poor measure of capacity because request cost varies; model limits in resources (CPU).
- Per-customer quotas can sum to more than capacity, on the bet that not everyone peaks together.
- **Client-side adaptive throttling**: track `requests` and `accepts` over 2 minutes; start
  dropping locally once requests reach K × accepts (K = 2 default). Rejecting is not free:
  for cheap requests, rejecting costs almost as much as serving.
- Criticality levels (CRITICAL_PLUS … SHEDDABLE). Retry budgets: max 3 attempts per request,
  retries only while retry ratio < 10% → worst-case load 1.1× instead of ~3×.
  https://sre.google/sre-book/handling-overload/

## Common misconceptions and confusing points

- "Leaky bucket" means two different things (meter vs queue). Many explainers mix them.
- Token bucket vs leaky bucket meter are the same limit seen from opposite ends; the real
  difference that matters is **reject vs delay**.
- Rate limiting ≠ load shedding: rate limiting is per client, for fairness; load shedding is
  system-wide, based on the server's own health (Stripe, AWS). A rate limiter does not save you if
  1 million well-behaved clients arrive at once.
- Rate limit ≠ quota (per day/month, a business allowance) ≠ concurrency limit (in-flight count,
  Stripe/GitHub) ≠ throttling (often means delay rather than reject) ≠ backpressure (downstream
  signals upstream to slow) ≠ circuit breaker (caller protecting itself from a failing dependency).
- Counting requests treats a 1 ms lookup and a 30 s report the same. Cost-based limits: GitHub
  points, CPU-time limits, LLM tokens per minute.
- IP is a weak key: NAT/CGNAT puts thousands of mobile users behind one IP, IPv6 gives an attacker
  billions of addresses, and behind a proxy every request appears to come from the proxy.
- A limiter's storage being down must not take the API down: decide fail open vs fail closed on
  purpose (Stripe and Envoy default to open).
- nginx returns 503 by default, which clients and dashboards read as "server broken".
- Limits per server (limit / N) silently change when the fleet autoscales.

## Sourced real incident

- **PostHog, 24 October 2025, 72 minutes**: an IP-based rate limit was added to the feature-flags
  `/flags` endpoint as a protective step after an earlier incident. The Rust middleware
  (tower-governor) ignored `X-Forwarded-For` by default, so it saw every request as coming from the
  load balancer's IP, and ~97% of evaluation requests worldwide got 429. Tested only
  direct-to-service, not behind the production load balancer. Detection took 62 minutes and came
  from customer reports (no alert on 429 rate). Fix: disable, then trust `X-Forwarded-For` from the
  load balancer.
  https://posthog.com/handbook/company/post-mortems/2025-10-21-feature-flags-recurring-outages

## How popular explainers structure it (and what they leave out)

1. **Alex Xu, System Design Interview vol. 1, ch. 4 / ByteByteGo**: requirements → where to put the
   limiter (client, server, middleware/gateway) → five algorithms → high-level design with Redis
   counters → rules config (Lyft-style YAML) → headers → race conditions and synchronization →
   monitoring. Interview-shaped; light on keying pitfalls, fail-open, client behaviour.
2. **smudge.ai "Rate limiting algorithms"**: motivation → fixed window → sliding window (with the
   approximation) → token bucket, each with interactive dots and real examples; short decision
   guide. Distributed limiting, headers, retries and keying only touched.
3. **redis.io tutorial (2026)**: five algorithms, each as a Lua script, a comparison table, a
   "which to choose" guide, then 429/Retry-After. Strong on atomicity; nothing on keying, fleet
   behaviour beyond Redis, client side, or rollout.

**Our angle** (what they leave out): what to key on and the proxy-IP trap (with a real incident);
the burst math (C + r·T, the 2× boundary, the sliding-counter worst case, measured in our own
code); fail open vs closed and dark launching; 429 vs 503; cost-based limits; layered limits;
the client's side of the contract (Retry-After, jitter, client-side buckets, adaptive
throttling); and where rate limiting stops and load shedding / backpressure begin.

## Source list for Further reading

Specs & official docs
- RFC 6585 §4, 429 Too Many Requests — https://www.rfc-editor.org/rfc/rfc6585#section-4
- RFC 9110 §10.2.3, Retry-After — https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
- IETF draft-ietf-httpapi-ratelimit-headers-11 (May 2026) — https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
- nginx `ngx_http_limit_req_module` — https://nginx.org/en/docs/http/ngx_http_limit_req_module.html
- Envoy local rate limit filter — https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/local_rate_limit_filter
- Envoy global rate limiting overview — https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting
- AWS API Gateway throttling — https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html
- GitHub REST API rate limits — https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Stripe rate limits — https://docs.stripe.com/rate-limits
- Discord rate limits — https://docs.discord.com/developers/topics/rate-limits
- Redis, "Build 5 rate limiters with Redis" — https://redis.io/tutorials/howtos/ratelimiting/

Engineering blogs
- Stripe, "Scaling your API with rate limiters" (2017) — https://stripe.com/blog/rate-limiters
- Cloudflare, "How we built rate limiting capable of scaling to millions of domains" (2017) — https://blog.cloudflare.com/counting-things-a-lot-of-different-things/
- Figma, "An alternative approach to rate limiting" (2017) — https://www.figma.com/blog/an-alternative-approach-to-rate-limiting
- AWS Builders' Library, "Fairness in multi-tenant systems" (2020) — https://builder.aws.com/content/3Eupj3d2bo4fEvlzYbICMZNhQ3B/fairness-in-multi-tenant-systems
- Google SRE book, "Handling Overload" — https://sre.google/sre-book/handling-overload/
- PostHog postmortem (Oct 2025) — https://posthog.com/handbook/company/post-mortems/2025-10-21-feature-flags-recurring-outages

Explainers
- Brandur Leach, "Rate limiting, cells, and GCRA" (2015) — https://brandur.org/rate-limiting
- redis-cell (GCRA as a Redis module) — https://github.com/brandur/redis-cell
- smudge.ai, "Rate limiting algorithms" — https://smudge.ai/blog/ratelimit-algorithms
