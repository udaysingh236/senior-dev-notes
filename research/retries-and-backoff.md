# Retries, exponential backoff and jitter — research notes

Track: resilience · slug: `retries-and-backoff` · researched 2026-11-06. Vendor sites
(docs.aws.amazon.com, envoyproxy.io, grpc.io, brooker.co.za) are not reachable from the build
container, so docs were read from their sources on GitHub, and blog posts through search excerpts.
Versions as of November 2026.

## Already covered elsewhere (link, don't repeat)

- Retries multiplying across hops (3 × 3 = 9, 27), "only one hop retries", retry budget defined in
  one sentence: `traffic/proxy-lb-gateway` ("What every extra hop costs").
- Which methods are safe/idempotent, the ambiguous POST timeout, idempotency keys, which status
  codes to retry (429/503 yes, 422/403 no, 502/504 only idempotent): `networking/rest-api-design`.
- 429 + Retry-After, clients synchronising on Retry-After, polite client code: `resilience/rate-limiting`.
- Deadline across attempts, per-try timeout inside the route timeout, the server keeps working
  after the client gives up: `resilience/timeouts`.
- Queueing delay explodes near saturation: `foundations/latency-vs-throughput`.

So this page owns: how much load retries add (the geometric sum), why the system can stay down
after the trigger ends (metastable failure), what backoff does and does not do, jitter variants,
retry budgets (token buckets, ratios), server pushback, hedging, and the real libraries' defaults.

## Key facts, with sources

### gRPC (gRFC A6, "Implemented", last updated 2024-08-23) — github.com/grpc/proposal A6-client-retries.md
- Retries are off unless the service config sets a policy.
- `retryPolicy`: `maxAttempts` (includes the first; values above 5 are treated as 5),
  `initialBackoff`, `maxBackoff`, `backoffMultiplier`, `retryableStatusCodes` (required).
- Backoff: n-th retry waits `min(initialBackoff × multiplier^(n-1), maxBackoff) × random(0.8, 1.2)`.
  ±20% jitter, not full jitter.
- Pushback: server metadata `grpc-retry-pushback-ms`; negative/unparseable = don't retry; valid =
  retry after exactly that delay; resets backoff.
- Throttling per server name: `maxTokens` (0, 1000], `tokenRatio`. Start at maxTokens; failure −1,
  success +tokenRatio; retries blocked when tokens ≤ maxTokens/2. Example: 10 and 0.1.
  Only retryable codes count as failures.
- Transparent retries (do not count toward maxAttempts): RPC never left the client (retried until
  deadline); reached the server library but not the application (REFUSED_STREAM, GOAWAY) retried once.
- Commit point: once response headers arrive, no more retries.
- Hedging: `maxAttempts`, `hedgingDelay`, `nonFatalStatusCodes`; first response wins, others
  cancelled; hedges throttled by the same tokens; a method has retryPolicy or hedgingPolicy, not both.
- The deadline covers all attempts and hedges.

### Envoy (docs on GitHub: docs/root/configuration/http/http_filters/router_filter.rst, api/.../circuit_breaker.proto)
- No retries unless a retry policy or `x-envoy-retry-on` is set; then 1 retry by default.
- Route timeout includes all retries ("to avoid an exponential retry/timeout explosion").
- Fully jittered exponential backoff, base 25 ms: retry N waits in [0, (2^N − 1) × 25 ms): 0–24,
  0–74, 0–174 ms…; cap 10 × base = 250 ms. `rate_limited_retry_back_off` reads Retry-After /
  X-RateLimit-Reset.
- Circuit breaker `max_retries` = 3 concurrent retries per cluster by default. `retry_budget`:
  `budget_percent` 20% of active + pending requests, `min_retry_concurrency` 3.

### Finagle (doc/src/sphinx/Clients.rst)
- Default RetryBudget ≈ 20% of total requests on top of 10 retries per second (for new or
  low-traffic clients). Configurable `ttl` (10 s in example), `minRetriesPerSec`, `percentCanRetry`.

### AWS SDKs (aws-sdk-go-v2 aws/retry/standard.go, jitter_backoff.go; botocore retries/quota.py, standard.py)
- Standard mode: 3 attempts, max backoff 20 s, retryable 500/502/503/504, throttling codes
  (ThrottlingException, TooManyRequestsException, SlowDown…), connection errors.
- Retry quota: 500 tokens; retry costs 5, timeout retry 10; first-try success adds 1; a successful
  retry returns its cost.
- Backoff (current default): full jitter, `random[0,1) × 2^attempt` seconds, base 1 s, cap 20 s.
- 2026 update (opt-in `AWS_NEW_RETRIES_2026=true`; AWS blog May 20, 2026 says default from
  November 2026): base 50 ms for transient errors, 1 s for throttling, cap applied before jitter:
  `b × min(x × 2^i, 20 s)`; retry costs 14 tokens, throttling retry 5. Some per-service overrides
  change (search excerpt: DynamoDB from 9 retries to 4; secondary, not used on the page).
  In aws-sdk-go-v2 main as of Nov 2026, still gated by the env var.
- Adaptive mode: client-side rate limiter that can delay first attempts; AWS calls it experimental.

### Python and Node clients
- requests: `DEFAULT_RETRIES = 0`; `HTTPAdapter` uses `Retry(0, read=False)` unless `max_retries` given.
- urllib3 used directly: `Retry.DEFAULT = Retry(3)`. Backoff off by default (factor 0); sleep =
  `factor × 2^(retries−1)`, first retry immediate, cap `DEFAULT_BACKOFF_MAX = 120` s; jitter is an
  additive `uniform(0, backoff_jitter)`. Default allowed methods: HEAD, GET, PUT, DELETE, OPTIONS,
  TRACE. Honours Retry-After on 413, 429, 503.
- Node `fetch` / `http`: no retries.

### Backoff in open systems — Marc Brooker, "What is backoff for?" (Aug 11, 2022)
- Backoff helps short spikes; with an unbounded population of clients it barely reduces total
  work or retry amplification, because new clients keep arriving and don't know others backed off.
  Backoff works when clients are few and serial (closed system).

### Token buckets vs circuit breakers — Marc Brooker, "Fixing retries with token buckets and circuit breakers" (Feb 28, 2022)
- Simulated N retries, no retries, circuit breaker, token bucket. Circuit breaker gives no extra
  load at high failure rates but trips early, approaching "no retries" at low failure rates.
  Token bucket starting full behaves like N retries for short-lived clients (bucket not drained).

### Metastable failures
- Bronson, Aghayev, Charapko, Zhu, HotOS 2021: stable / vulnerable / metastable states; a trigger
  pushes a vulnerable system into a bad state that a sustaining effect (often retries) keeps it in
  after the trigger is gone; example of a web app retrying DB queries after 1 s.
- Huang et al., OSDI 2022, "Metastable Failures in the Wild": 22 incidents across 11 organisations;
  retry policy is the sustaining effect in more than half; at least 4 of 15 major AWS outages in a
  decade were metastable. Recovery: shed load, add capacity, or reduce amplification.

### Incident
- AWS us-east-1, Dec 7, 2021 (summary Dec 10, 2021, aws.amazon.com/message/12721): automated
  scaling triggered a surge of connections from internal clients; delays caused "even more
  connection attempts and retries", persistent congestion; a latent issue kept the clients from
  backing off adequately.

## Numbers worked out for the page
- Attempts per request with failure probability p, up to N retries: 1 + p + … + p^N.
  p = 0.1, N = 3: 1.111. p = 0.5: 1.875. p = 1: 4.
- Ratio budget r = 0.1 (every request +0.1 token, every retry −1): retries ≤ 10% of requests → ≤ 1.1×.
- gRPC throttle 10 / 0.1: break-even failure rate f where 0.1(1 − f) = f → f ≈ 9.1%.
- AWS quota: 500 / 5 = 100 retries in a burst before the bucket is empty (35 with 14-token cost);
  steady state ~1 retry per 5 successes (old), ~1 per 14 (new).

## Common misconceptions
- "Backoff protects the server." Only from short spikes; amplification is set by the number of
  attempts, not the gaps.
- "Retries are free for reads." They are free for correctness, not for load.
- "Jitter is about fairness." It is about desynchronising clients that failed together.
- "The outage ends when the trigger ends." Metastable: retries keep it down.
- "My code retries 3 times" — plus the SDK's 3, plus the proxy's 1.

## How explainers usually teach it, and what they leave out
- Most posts: retry loop → exponential → add jitter → done, with code. Some cover idempotency.
- Missing: open vs closed systems (why backoff doesn't cut load), the arithmetic of amplification,
  metastability and why the system stays down, budgets as the real brake, library defaults
  stacking, gRPC pushback and the commit point. That is our angle.

## Sources (year)
- gRFC A6: gRPC retry design (living spec, last updated 2024) — github.com/grpc/proposal/blob/master/A6-client-retries.md
- Envoy router filter docs and circuit breaker API (living docs, checked Nov 2026)
- Finagle clients guide, retries (living docs, checked Nov 2026)
- AWS SDKs and tools reference guide: retry behavior (living docs, checked Nov 2026)
- AWS Developer Tools Blog: Announcing updated retry behavior for AWS SDKs and tools (2026)
- aws-sdk-go-v2 `aws/retry` source (checked Nov 2026)
- urllib3 `util/retry.py` and requests `adapters.py` (checked Nov 2026)
- Marc Brooker: What is backoff for? (2022)
- Marc Brooker: Fixing retries with token buckets and circuit breakers (2022)
- Bronson et al.: Metastable failures in distributed systems, HotOS (2021)
- Huang et al.: Metastable failures in the wild, OSDI (2022)
- AWS: Summary of the AWS service event in us-east-1, December 2021 (2021)
- RFC 9110 (2022): idempotent methods, Retry-After
