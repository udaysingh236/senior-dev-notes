# Research: Load balancing

Slug: `traffic/load-balancing` · single topic · researched 2026-10-26.
Page fetches were unavailable; facts checked through search results quoting the sources. Every
source is 2020 or later, or living documentation checked in October 2026. The herd effect and the
power-of-two-choices sampling probability are demonstrated with our own simulation and arithmetic
(examples/load-balancing) instead of citing the original 1990s–2000s papers. The smooth weighted
round robin rule is described from nginx's current behaviour and reproduced in our own code.

## Angle

The comparison page (`traffic/proxy-lb-gateway`) already covers L4 vs L7, a summary of round
robin / least outstanding / P2C / hashing, slow start, active and passive health checks, draining,
Maglev, ECMP, anycast. This page goes into the decision itself and the thing explainers skip: each
balancer instance decides with a partial or stale view. Stale shared tables herd; own in-flight
counts go to zero behind many sidecars (Little's law); latency memory (peak EWMA) and probing
(Prequal) recover the information. Then the filters around the choice: subsetting, zones, outlier
ejection, panic mode, each of which concentrates load.

## Key facts

- Envoy load balancers: weighted round robin and least request use earliest-deadline scheduling
  for weights; least request with equal weights samples `choice_count` (default 2) hosts and picks
  the fewest active requests; with unequal weights, effective weight =
  weight / (active + 1)^active_request_bias, bias default 1.0.
  https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers
- Envoy outlier detection defaults: consecutive_5xx 5, interval 10 s, base_ejection_time 30 s
  (multiplied by number of ejections), max_ejection_percent 10% (at least one host).
  https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/outlier_detection.proto
- Envoy panic threshold default 50%: below it, ignore health and use all hosts.
  https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/panic_threshold
- Envoy zone-aware routing: `min_cluster_size` default 6.
  https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/load_balancing_policies/common/v3/common.proto
- Linkerd balances with EWMA over P2C; counts 429 / RESOURCE_EXHAUSTED as success by default, so
  fast rate-limited endpoints attract more traffic; rate-limit-aware "load biaser" substitutes a
  penalty latency (Retry-After / grpc-retry-pushback-ms refine it). Linkerd 2.20, June 2026.
  https://linkerd.io/docs/reference/load-balancing/
  https://linkerd.io/docs/tasks/rate-limit-aware-load-balancing/
  https://linkerd.io/2026/06/23/announcing-linkerd-2.20/
- Prequal (Wydrowski, Kleinberg, Rumble, Archer; NSDI 2024): balances on requests-in-flight and
  latency, not CPU; asynchronous reusable probes; power of d choices; hot-cold lexicographic rule
  (cold = RIF below a quantile threshold; lowest latency among cold, else lowest RIF). Ran on
  YouTube for over two years; reduced tail latency, errors, resource use.
  https://www.usenix.org/conference/nsdi24/presentation/wydrowski
- Google subsetting (Ward, Wankadia, Guliani; ACM Queue Dec 2022, CACM 2023): deterministic
  subsetting was the default for over a decade; balances connections per backend but causes high
  connection churn on backend changes; Rocksteady replaces it, using a ring and "lots".
  https://queue.acm.org/detail.cfm?id=3570937
- Dropbox Robinhood (Oct 2024): one PID controller per node targets average utilisation; output
  adjusts endpoint weights, normalised across the service.
  https://dropbox.tech/infrastructure/robinhood-in-house-load-balancing-service
- AWS: NLB cross-zone load balancing off by default; ALB always on (can be turned off per target
  group since late 2022); inter-AZ data transfer billed per GB each direction.
  https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html
  https://aws.amazon.com/blogs/networking-and-content-delivery/optimizing-data-transfer-costs-when-using-aws-network-load-balancer
- Kubernetes KEP-4444 (2024): Service `trafficDistribution: PreferClose`; warns endpoints in the
  preferred zone can be overloaded. https://www.kubernetes.dev/resources/keps/4444/
- grpc-go keepalive: server MaxConnectionAge, default infinite, ±10% jitter, GOAWAY; plus
  MaxConnectionAgeGrace. https://pkg.go.dev/google.golang.org/grpc/keepalive

## Numbers (from our own code, examples/load-balancing)

- 8 backends, one 3× slower, 70% load (513 req/s). One balancer, p99: least on live table 78 ms,
  P2C live 121 ms; table 20 ms old: 173 vs 150; 100 ms: 552 vs 233; 500 ms: 3.3 s vs 665 ms.
- Own-count P2C p99: 121 ms with 1 balancer, 986 ms with 50. Peak EWMA: 98 ms and 390 ms;
  slow backend share 3.7% / 5.3% (fair share 4.5%).
- P2C with 8 backends: a given backend is in the sampled pair with probability 25%.
- Subsets, 300 × 300, k = 10: deterministic 10–10 clients per backend, 2,821 of 3,000 connections
  move when one backend is removed; rendezvous 2–20, 14 move.
- Full mesh 300 × 300 with checks every 5 s: 18,000 checks/s, 60 per backend; k = 10: 2 per backend.

## Misconceptions

- "Least loaded is always best": only with live data; on a stale shared table it herds.
- "Least request works the same everywhere": it depends on how much traffic each balancer sees.
- "Ejecting bad hosts is always safe": it moves their load to the rest; without a cap it cascades.
- "Prefer the local zone": only in proportion to local capacity.
- "Scale out fixes hot backends": not for clients holding long-lived connections.

## How explainers usually structure it

Most list algorithms (round robin, weighted, least connections, IP hash) with one-line pros and
cons and stop. They rarely mention that real deployments have many balancer instances, the herd
effect on stale data, subsetting, or that ejection and locality concentrate load. That is our angle.

## Sources (year)

Prequal NSDI 2024; Google subsetting ACM Queue 2022; Dropbox 2024; Linkerd docs (living) and 2.20
announcement 2026; Envoy docs (living); AWS ELB docs (living); AWS networking blog (living); KEP-4444
(2024); grpc-go docs (living).
