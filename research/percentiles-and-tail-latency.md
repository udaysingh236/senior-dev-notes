# Percentiles, P99 and tail latency — research notes

Researched 2026-11-23. Notes in our own words; quotes under 15 words.

## Key facts, with sources

- Percentiles cannot be averaged or added: a finished p99 has thrown away the distribution.
  Prometheus says summary quantiles "cannot" be aggregated and calls averaging them
  "statistically nonsensical"; histograms can, by summing bucket counts per `le` and then
  running `histogram_quantile`. — Prometheus, Histograms and summaries (living docs, read Nov 2026)
  https://prometheus.io/docs/practices/histograms/
- `histogram_quantile` finds the bucket holding the quantile and interpolates linearly inside it.
  Prometheus example: true p95 about 220 ms, classic bucket 200–300 ms, estimate 295 ms; with a
  native (exponential) histogram, bucket about 210–229 ms, estimate 228 ms. Shift by +100 ms:
  classic bucket 300–450 ms gives 443 ms. — same page.
- Prometheus now recommends native histograms over classic histograms and summaries (as of Nov 2026). — same page.
- OpenTelemetry exponential histogram: bucket edges are powers of `base = 2^(2^-scale)`; default
  MaxSize 160 buckets, MaxScale 20; 160 buckets cover 1 ms–100 s with under 5% relative error
  (scale 3, base 1.0905, about 4.3%). Explicit-bucket default boundaries:
  [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000].
  — https://opentelemetry.io/docs/specs/otel/metrics/sdk/ and /data-model/ (living spec, read Nov 2026)
- Datadog distributions send raw values to the server and compute "globally accurate" percentiles
  across hosts with DDSketch. — https://docs.datadoghq.com/metrics/distributions/ (living docs)
- HdrHistogram: fixed memory set by range and significant digits; 3 significant digits = at most
  0.1% error; has `recordValueWithExpectedInterval` to correct coordinated omission.
  — https://github.com/HdrHistogram/HdrHistogram (living README)
- Coordinated omission (term from Gil Tene): the tester waits for the system, so it skips
  measuring exactly when the system is slow; most benchmark tools do not correct it by default.
  — ScyllaDB, On Coordinated Omission, 2021-04-22 https://www.scylladb.com/2021/04/22/on-coordinated-omission/
- Brooker (2021): tail matters more with fan-out and serial chains; bimodal model 99% at ~10 ms,
  1% at ~100 ms: 1% of single calls hit the slow mode, ~10% at N=10. No single summary statistic
  is enough. — https://brooker.co.za/blog/2021/04/19/latency.html
- Brooker (2023): hedging sends a second request after p95-ish delay, about 5% extra requests;
  correlated slowness can double traffic, so cap hedges with a token bucket.
  — https://brooker.co.za/blog/2023/01/06/erasure/
- Brooker (2026): Little's law as a cost model for the tail (already cited on latency page).
  https://brooker.co.za/blog/2026/07/29/lorenz-and-little.html
- Discord (2020): Read States service in Go showed latency and CPU spikes about every 2 minutes,
  caused by Go forcing a garbage collection at least every 2 minutes; the Rust rewrite had no spikes.
  — https://discord.com/blog/why-discord-is-switching-from-go-to-rust
- Dean and Barroso, The Tail at Scale (2013, kept as history): fan-out to 100 servers with 1-in-100
  slow makes 63% of requests slow; hedged requests after p95 delay; tied requests.
  https://research.google/pubs/the-tail-at-scale/

## Real numbers (from our own runs, examples/percentiles-and-tail-latency)

- Ten requests [40, 42, 45, 45, 48, 50, 52, 55, 60, 2000]: average 243.7 ms; p50 48; p90 60; max 2,000.
- Fan-out (99% 20–50 ms, 1% 500–1,500 ms), 100,000 pages:
  N=1 p50 35, p99 503, 1.0% slow; N=10 p50 48, p99 1,401, 9.7% (predicted 9.6%);
  N=100 p50 813, p99 1,490, 63.6% (predicted 63.4%).
  N=10 hedged after 50 ms: p50 48, p99 97, 0.1% slow, 1.0% extra calls.
- Two servers: A 9,000 fast; B 1,000 with 150 slow (600–900 ms). Per-server p99 about 50 and 967;
  average of p99s 508 (wrong); merged histogram 667; exact 697.
- Load test with a 1 s freeze, 50 req/s for 10 s: closed loop 451 requests, p99 10 ms, 1 slow;
  open loop 500 requests, p99 960 ms, 91 slow.

## Misconceptions and confusing points

- "Average latency 50 ms means users wait about 50 ms." The average is pulled by a few huge values
  and describes nobody.
- "p99 means 1% of users have a bad time." Each user makes many requests and pages fan out, so far
  more than 1% of users meet the p99.
- Averaging p99s across servers or across minutes.
- "Max is useless." Max is the one number that can't be hidden; use it alongside p99.
- Load tests that wait for each response (closed loop) under-report the tail.
- Percentile definitions differ (nearest rank vs interpolation); small samples make p99 meaningless
  (p99 of 50 requests is the single slowest one).

## How explainers structure it, and what they leave out

- Typical blog posts: "averages lie" → define p50/p95/p99 → "use p99 in your SLO". Most stop there.
- The Tail at Scale write-ups: fan-out math → hedged/tied requests. Usually skip how percentiles
  are stored and merged, and the measurement trap.
- Monitoring docs (Prometheus, OTel): histogram mechanics but no intuition for why the tail matters.
- Our angle: one running example from ten requests to fan-out, the arithmetic shown, then the
  production side most explainers skip: histograms and merging, coordinated omission, where the
  tail comes from, and what reduces it.

## Further reading list

See the page's Further reading section (all sources above, with years).

## Fresher read

Done 2026-11-23 by a fresh reader with no research context, after the author's own publishing read.
It found 33 items. All were fixed: undefined terms (dashboard, fleet, load test, labels, Prometheus,
OpenTelemetry, Datadog, significant digits, Go runtime), missing working (14×, 1.09 to the 27th
power, the 447th rank, the 91 slow requests and 0.8 s backlog, 5% of calls past their p95), the
per-server p99s that are histogram estimates, the 244 vs 243.7 rounding, the unlabelled hedging
row, a hard jump in interview question 2, the 2^(2^−scale) formula (dropped), repeated material
(Discord story, hedging during an outage, timeout bump, averaging p99s, "describes nobody"), and
three uses of "obvious".

Open items: none.
