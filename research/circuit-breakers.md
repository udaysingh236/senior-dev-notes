# Research: Circuit breakers

Track: resilience · slug: `circuit-breakers` · researched 2026-11-18. Vendor doc sites
(resilience4j.readme.io, pollydocs.org, envoyproxy.io, learn.microsoft.com, aws.amazon.com,
brooker.co.za, shopify.engineering) are not reachable from the build container, so docs were read
from their sources on GitHub (main branches, November 2026) and blog posts through search excerpts.

## Key facts

### The idea
- A circuit breaker sits in the caller, in front of calls to one dependency. Closed: calls flow
  and outcomes are recorded. Open: calls fail at once without being made. Half-open: after a
  wait, a few trial calls go through; success closes, failure reopens.
- Naming is from electrical breakers: "closed" circuit = current (calls) flows. Confusing for
  learners, who read "open" as "open for business".
- The pattern was named by Michael Nygard in *Release It!* (2007, kept as history; 2nd ed. 2018).
  Netflix Hystrix popularised it; Hystrix is in maintenance mode, final release 1.5.18, and
  Netflix points new projects to resilience4j (github.com/Netflix/Hystrix README, checked Nov 2026).

### Resilience4j (Java) — CircuitBreakerConfig.java, CircuitBreakerStateMachine.java (v2.4.0, latest release, checked Nov 2026)
- failureRateThreshold 50%; slowCallRateThreshold 100%; slowCallDurationThreshold 60 s;
  permittedNumberOfCallsInHalfOpenState 10; slidingWindowType COUNT_BASED; slidingWindowSize 100;
  minimumNumberOfCalls 100; waitDurationInOpenState 60 s; automatic open→half-open off by
  default (the move happens on the next call after the wait); maxWaitDurationInHalfOpenState 0.
- Open: `tryAcquirePermission` false → `CallNotPermittedException`. Half-open: a counter of
  permitted calls; once 0, further calls rejected with the same exception. Close/reopen decided by
  the failure-rate and slow-call-rate thresholds over the half-open calls.
- Extra states exist for operations: DISABLED, FORCED_OPEN, METRICS_ONLY (seen in source).

### Polly v8 (.NET) — docs/strategies/circuit-breaker.md (8.9.1, Nov 2026)
- FailureRatio 0.1 (10%); MinimumThroughput 100; SamplingDuration 30 s; BreakDuration 5 s;
  BreakDurationGenerator optional (dynamic break time); ShouldHandle: any exception except
  OperationCanceledException.
- If MinimumThroughput is not reached within the sampling duration the ratio is ignored.
- Open: `BrokenCircuitException` (with RetryAfter). Manual isolation: `IsolatedCircuitException`.
- Half-open: a probe; passes → closed, fails → open.
- Anti-patterns: checking state before calling (the breaker never reaches half-open); one breaker
  per endpoint built by hand — use per-authority pipelines (scheme + host + port).

### Envoy — circuit_breaking.rst, outlier.rst, outlier_detection.proto, admission_control (main, Nov 2026)
- What Envoy calls "circuit breaking" is concurrency limits per upstream cluster and priority:
  max connections, pending requests, requests, active retries, connection pools. "Fully
  distributed (not coordinated)": each Envoy enforces its own. Defaults modest, e.g. 1,024
  connections; max retries 3.
- Outlier detection = the classic breaker idea per host: ejects a host from load balancing.
  consecutive_5xx 5; interval 10 s; base_ejection_time 30 s, multiplied by the number of times
  ejected in a row, capped by max_ejection_time 300 s; max_ejection_percent 10%;
  failure_percentage_threshold 85 (enforcing off by default); success_rate_request_volume 100.
  Ejected host returns automatically after the ejection time.
- Admission control filter: client-side throttling from the Google SRE book. Reject probability
  = max(0, (requests − successes ÷ sr_threshold) ÷ (requests + 1)) ^ (1 ÷ aggression).
  Defaults: sampling_window 30 s, sr_threshold 95%, aggression 1.0, max_rejection_probability
  80%, rps_threshold 0. Status < 500 counts as success by default.

### opossum (Node.js) — lib/circuit.js (v10.0.0, 2026-06-24)
- timeout 10,000 ms; resetTimeout 30,000 ms; errorThresholdPercentage 50; rollingCountTimeout
  10,000 ms in 10 buckets; volumeThreshold 0 (no minimum!); half-open allows one trial, other
  calls rejected with `EOPENBREAKER`; fallback() runs when open.

### gobreaker (Go) — README
- Default ReadyToTrip: more than 5 consecutive failures; Timeout (open time) 60 s; MaxRequests in
  half-open 1; Interval 0 means closed-state counts are never cleared. v2 with generics.

### pybreaker (Python) — README
- fail_max 5 consecutive failures; reset_timeout 60 s; one trial call after the timeout;
  `exclude=[...]` or callables to not count some errors (e.g. 4xx); optional Redis state storage
  shared across processes; success_threshold option.

### Semian (Ruby, Shopify) — README
- Parameters: error_threshold (errors within error_threshold_timeout), error_timeout (time open
  before trying again), success_threshold (successes in half-open to close),
  half_open_resource_timeout (a shorter timeout for the trial call). State is local to each
  worker process, not shared. Newer error-rate mode: error_rate_threshold, minimum_request_volume
  10, error_rate_window 10 s. Experimental adaptive breaker. Also bulkheads (tickets).

## Numbers used on the page
- Running example (illustrative): Product service, 20 workers, 200 pages/s, 10 ms own work,
  Reviews call ~40 ms average → 50 ms per page → 10 workers busy. Timeout 300 ms. Reviews hangs:
  310 ms per page → 62 workers wanted. Breaker window 20 calls, opens at 50%, open 5 s, 1 trial.
- Library defaults above.

## Misconceptions and confusing points
- "Open" means calls are blocked (electrical meaning), not "open for business".
- A breaker is not a retry policy, not a rate limiter (server protecting itself from callers),
  not load shedding, not a bulkhead (separate pools), not a health check (though outlier
  detection is a passive health check). Envoy uses "circuit breaker" for concurrency limits.
- A breaker in front of a sharded/multi-host dependency turns a partial failure into a total one
  (Brooker, Feb 2022): one shard of four failing → 25% errors → a 10% breaker opens and blocks the
  healthy 75%. Scope breakers per host/shard, or eject hosts (outlier detection).
- Counting 4xx (caller's own mistakes) as failures lets bad input open the breaker.
- Breakers decide from local samples; small clients see noisy rates (Brooker, Feb 2022).
- A breaker that opens on slow calls needs slow-call detection; Resilience4j's default (60 s) is
  effectively off.
- Low traffic: minimum-calls threshold not reached → never opens (Polly) or no minimum → opens on
  1 failure out of 1 (opossum volumeThreshold 0).
- Breaker state per process: N processes each need to learn, each probe separately.
- Fallbacks hide outages unless the open state is alerted on.
- "A slightly misconfigured circuit is as bad as no circuit at all" — Shopify Engineering, "Your
  Circuit Breaker is Misconfigured" (2020); works out the capacity cost of error_timeout and the
  half-open trial. We derive our own version of that sum on the page.

## Incidents
- No 2020+ public postmortem found whose root cause is a circuit breaker (searched Nov 2026; the
  hits were unverified blog write-ups). The page names no incident; gotchas are written as general
  patterns.

## How explainers structure it, and what they leave out
- Fowler-style and Azure Architecture Center: state machine + sample code + considerations list.
  Little on how to choose numbers, on scope (sharding), or on cost while open.
- Library docs (Resilience4j, Polly): parameters and defaults; little on why the defaults differ
  (Polly 10%/30 s vs Resilience4j 50%/100 calls vs pybreaker 5 consecutive).
- Brooker's posts: critique (partial failure, local sampling); no beginner model.
- Our angle: start from worker-pool cost of a dead dependency even with a good timeout; show the
  numbers that decide each knob; scope; breakers with retries; library defaults side by side.

## Sources (Further reading)
- Resilience4j CircuitBreakerConfig.java and CircuitBreakerStateMachine.java, GitHub (living, v2.4.0, checked Nov 2026)
- Polly docs: circuit breaker strategy, GitHub docs/strategies/circuit-breaker.md (living, 8.9.1, Nov 2026)
- Envoy docs: circuit breaking, outlier detection, outlier_detection.proto, admission control filter (living, checked Nov 2026)
- opossum lib/circuit.js (v10.0.0, 2026)
- sony/gobreaker README (living, checked Nov 2026)
- danielfm/pybreaker README (living, checked Nov 2026)
- Shopify/semian README (living, checked Nov 2026)
- Netflix/Hystrix README (maintenance notice; living, checked Nov 2026)
- Marc Brooker: Will circuit breakers solve my problems? (Feb 2022)
- Marc Brooker: Fixing retries with token buckets and circuit breakers (Feb 2022)
- Shopify Engineering: Your Circuit Breaker is Misconfigured (2020)
- Michael Nygard: Release It! (2007, 2nd ed. 2018) — origin of the name, kept as history

## Fresher read

Done 2026-11-18 by a fresh agent with no research context, plus the author's own publishing read.
Found and fixed: undefined terms (async server, running copies, seeded, Resilience4j/Polly/opossum
before introduction, Envoy ejection, Redis, load balancer, service mesh, upstream cluster, failover,
garbage collection, staging environment, ring); missing working (10 of 20 = the other 10 were
successes, 300 + 45 ms, 4,000 refused, 0.02⁵, 1 in 70 vs overlapping checks, 15.5 + 7.5 workers,
the "+ 1" in the throttling formula, why the slow-call breaker opens at 16 s, 2^n and the jitter
factor, 0.057 → 6%); contradictions (50 copies × 64 vs 50 copies sharing 200; 429 vs "never 4xx";
gobreaker 5 vs 6; 4 vs 3 trial calls in the outage; the example clock vs 10:00:00).
Part 1 test passed: the reader explained the idea in three sentences after Part 1 alone.

Open list: empty.
