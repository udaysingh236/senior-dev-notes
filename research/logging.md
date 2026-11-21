# Logging — research notes

Track: observability (new folder), order 2, slug `logging`. Single-topic page (`template.mdx`).
Researched November 2026. Metrics, tracing, alerting and the observability overview have their own
planned pages; this page covers logs only and links to them.

## Key facts (with sources)

- OpenTelemetry Logs Data Model is Stable: a log record has Timestamp, ObservedTimestamp,
  TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber (1–24, in six ranges TRACE, DEBUG,
  INFO, WARN, ERROR, FATAL), Body, Resource, Attributes. — opentelemetry.io/docs/specs/otel/logs/data-model/ (living spec, 2023–2026).
- W3C Trace Context: `traceparent` header carries a 16-byte trace ID across services. — W3C
  Recommendation (2021, in force).
- Grafana Loki indexes only labels, not the log text; keep labels few and bounded; never use
  request IDs or order IDs as labels; default limit 15 index labels; use structured metadata for
  high-cardinality fields. — grafana.com/docs/loki/latest/get-started/labels/bp-labels/ (living docs, v3.x, 2025–2026).
- CloudWatch Logs (us-east-1, as of 2026): Standard ingestion about $0.50 per GB, storage about
  $0.03 per GB-month (compressed), Infrequent Access ingestion $0.25 per GB; tiered prices for
  very large volumes. — aws.amazon.com/cloudwatch/pricing/ ; AWS Compute Blog (May 2025).
- OWASP Logging Cheat Sheet / ASVS V7: do not log passwords, session IDs, tokens, keys; log
  authentication decisions without secrets; encode data to prevent log injection (CWE-117);
  CWE-532 is sensitive information in log files. — cheatsheetseries.owasp.org (living); OWASP ASVS 4.0.3 (2021).
- Python `logging.handlers.QueueHandler` / `QueueListener` move slow I/O off the request thread
  (docs.python.org 3.13 Logging Cookbook, living). Node `AsyncLocalStorage` (node:async_hooks,
  stable since Node 16) carries per-request context.

## Incidents

- Log4Shell, CVE-2021-44228 (December 2021): Log4j 2.0-beta9 to 2.14.1 performed JNDI lookups on
  `${...}` strings inside logged data, so logging an attacker's User-Agent ran attacker code. CVSS
  10.0. Fixed fully in 2.16.0 (2.15.0 incomplete). — CISA Apache Log4j guidance (2021–2022).
- Meta fined €91 million by the Irish DPC on 27 September 2024 for storing some users' passwords
  unencrypted on internal systems (Meta's 2019 statement: "logged" in readable form). — DPC press
  release (2024). Page wording: "stored in plain text on internal systems", citing the DPC.
- Cloudflare, 14 November 2024: a Logpush configuration bug plus a fail-open safeguard sent logs
  for all customers into the buffering system; about 55% of customer logs over roughly 3.5 hours
  were lost. — blog.cloudflare.com/cloudflare-incident-on-november-14-2024-resulting-in-lost-logs (2024).

## Measured here (examples/logging/python/bench.py, Python 3.13, one laptop, November 2026)

- Text line to a file: 6.1 µs; JSON line: 7.1–7.4 µs. Sizes: 90 bytes text, 169 bytes JSON.
- DEBUG off but message built with an f-string: 55.6–56.1 µs per call; level checked first:
  0.04–0.05 µs.
- logging_demo.py: a destination taking 20 ms per line costs 80.5–80.6 ms per request with 4
  lines when blocking; 0.04–0.05 ms per request through a bounded queue of 50, with 30 of 80 lines
  dropped in a burst.

## Real numbers used on the page (worked)

- 500 requests/s × 10 lines = 5,000 lines/s; × 170 bytes = 850,000 bytes/s = 0.85 MB/s;
  × 86,400 s = 73,440 MB ≈ 73 GB/day; × $0.50/GB ≈ $36.7/day ≈ $1,100 for 30 days (ingestion only).

## Misconceptions

- "More logs = more observability": volume without structure or IDs is not searchable.
- "Logging is free": it costs CPU, I/O, network and, mostly, money per GB stored and searched.
- "Log levels are for severity only": they are also the volume dial; DEBUG in production is a cost.
- "A logger never blocks": the default Python and Java handlers write synchronously; a full disk or
  slow network sink blocks requests.
- Logs vs metrics vs traces: counts over time belong in metrics, request paths across services in
  traces; logs are the detailed record of events.

## How explainers structure it

- Typical blog posts (2022–2025): log levels, "use JSON", "add correlation IDs", list of tools.
  They leave out: what a line costs (measured), what happens when the destination is slow (block vs
  drop), the pipeline from stdout to search, indexing vs label cost, and the security incidents.
- Wide events / canonical log lines (Honeycomb, Boris Tane 2024–2025; Stripe's 2019 post is the
  origin, kept as history): one rich event per request per service. Our angle includes it as the
  production shape.

## Sources (Further reading)

1. OpenTelemetry Logs Data Model (living spec).
2. W3C Trace Context (2021, Recommendation).
3. OWASP Logging Cheat Sheet (living).
4. Python Logging Cookbook, QueueHandler (3.13 docs).
5. Node.js AsyncLocalStorage docs (v22).
6. Grafana Loki label best practices (v3.x).
7. Amazon CloudWatch pricing (checked November 2026).
8. CISA Apache Log4j vulnerability guidance (2021–2022).
9. Irish DPC press release on Meta (2024).
10. Cloudflare, incident of 14 November 2024 resulting in lost logs (2024).
11. Honeycomb / Charity Majors on structured events and wide events (2024).

## Fresher read

Done by the publishing session, top to bottom, on 2026-11-21. Items found and fixed:

- Example output showed invented timestamps and a line order that contradicted the story → the
  examples now write lines in true time order (timeout at 2,000 ms, then the charge at 2,400 ms),
  and the page shows real output with a note that times are the time of the run.
- Part 1 steps reordered so the timeout comes before the late charge; Fig. 1 changed to match.
- "OpenTelemetry", "container", "stream", "thread", "CVE", "User-Agent", "log group", "MiB" →
  explained in place.
- "hundreds of lines" (hidden number) → "about 30,000 lines: 500 a second × 60 seconds".
- "16-byte" (bytes not introduced) → "32-character".
- Unsupported claim "cost more than the database" → "one of the largest items on a cloud bill".
- MDX error from `{expensive()}` in a quiz question → reworded.
- Banned word "easy" ×2 → rewritten.

Open items: none. Part 1 alone explains the idea in three sentences: programs write one line per
important event with the details; every line carries the request's ID and all lines go to one
searchable store, so one search shows one request's story; logging costs time and money, so log
the right things in a searchable form.
