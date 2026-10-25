# Research: Latency vs throughput

Slug: `foundations/latency-vs-throughput` · single topic · researched 2026-10-25.
Page fetches were unavailable; facts checked through search results quoting the sources. Every
source is 2020 or later, or living documentation checked in October 2026. Formulas (Little's law,
M/M/1, M/G/1 Pollaczek–Khinchine, Kingman) are mathematics; the page derives or demonstrates them
with its own simulation instead of citing the original 1950s–60s papers.

## Angle

Most explainers define latency and throughput with a pipe or highway analogy and stop. They miss
the relationship that matters in production: queueing. Latency is service time plus waiting, and
waiting grows as 1 / (1 − utilisation), so latency explodes well before a server is "full".
Little's law ties concurrency, throughput and latency together and sizes pools. Batching trades
latency for throughput, and under load buys both. Load tests that wait for each response
(closed model) hide the explosion.

## Key facts

- Little's law: average number in the system = arrival rate × average time in the system. Used as
  a capacity measure because concurrency is what consumes threads, connections, memory. Brooker,
  "Lorenz and Little: How Much Does Your Tail Cost?" (2026): requests above p99 can account for
  about half of mean latency and therefore of concurrency.
  https://brooker.co.za/blog/2026/07/29/lorenz-and-little.html
- Queueing intuition for software systems, the utilisation "hockey stick", the Universal
  Scalability Law: SREcon24 Americas, Jeff Poole, "System Performance and Queuing Theory" (2024),
  https://www.usenix.org/conference/srecon24americas/presentation/poole ; SREcon25 EMEA,
  Aravindh Sampathkumar, "The SRE's Crystal Ball" (2025),
  https://www.usenix.org/conference/srecon25emea/presentation/sampathkumar
- Open vs closed load models: in a closed model a slow system lowers the arrival rate of new
  iterations; k6 docs call this coordinated omission; arrival-rate executors give an open model.
  https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/ (living, Oct 2026)
- Kafka producer: KIP-1030 changed the default `linger.ms` from 0 to 5 ms in Kafka 4.0 (2025);
  `batch.size` default 16 KB. KIP-1224 (target 4.2) reports the fixed 5 ms linger caused latency
  regressions for low-throughput coordinator writes after upgrading to 4.0.
  https://cwiki.apache.org/confluence/display/KAFKA/KIP-1030%3A+Change+constraints+and+default+values+for+various+configurations
  https://cwiki.apache.org/confluence/display/KAFKA/KIP-1224 (as found via Conduktor's KIP index)
- PostgreSQL group commit: `commit_delay` (µs, default 0) and `commit_siblings` (default 5); a
  nonzero delay lets several transactions share one WAL flush and adds up to `commit_delay` of
  latency per flush. https://www.postgresql.org/docs/current/runtime-config-wal.html (living)

## Numbers (from our own model and code, seed 42)

- M/M/1 mean latency = S / (1 − ρ): ρ 0.5 → 2S, 0.8 → 5S, 0.9 → 10S, 0.95 → 20S.
- Deterministic service halves the waiting part (M/D/1).
- Recorded after running examples: see page and examples/latency-vs-throughput/README.md.

## Misconceptions

- "Latency and throughput trade off": sometimes (batching at low load), often not (caching
  improves both; overload worsens both).
- "We are fine until 100% CPU": latency is 5× service time at 80% with random arrivals.
- "Average latency is what users see": averages hide the tail; see the percentiles page.
- "More threads = more throughput": only up to the bottleneck; past it, they add waiting.
- "Our load test shows flat latency": closed-model tests slow down with the system.

## Sources (year)

Brooker 2026; Poole SREcon24 (2024); Sampathkumar SREcon25 EMEA (2025); k6 docs (living, 2026);
KIP-1030 (2024–25, Kafka 4.0 2025); KIP-1224 (2025); PostgreSQL WAL docs (living, v18).
