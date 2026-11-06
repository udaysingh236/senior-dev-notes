# Senior Dev Notes

**System design and production engineering, explained the way a senior engineer mentors a junior.**

Read it at **[seniordevnotes.in](https://seniordevnotes.in)**.

Each page takes one topic, such as rate limiting, connection pooling or N+1 queries. It starts
from the real problem and shows what people try first and why it breaks. Then it goes deep into
the mechanism, with numbers, diagrams and code you can run.

## Who it is for

Final-year students, new graduates and engineers in their first few years of work. It also suits
experienced engineers who want the "why" behind tools they already use. Pages assume you can read
Python or JavaScript and know what an HTTP request and a SQL query are. Everything beyond that is
explained.

## What a page looks like

- **Opens with a question, not a story.** For example: put a layer 4 load balancer in front of six
  gRPC servers with four clients, and two servers sit idle. Add six more servers and nothing
  changes. Why?
- **Mechanisms, not feature lists.** What the database locks, how two requests are kept apart,
  where the time goes, and how each approach fails under load.
- **Real numbers.** Many pages measure their claims, for example PostgreSQL connection costs or
  N+1 latency at different network round trips. The scripts behind those numbers are in this
  repo.
- **Hand-drawn diagrams and interactive simulations.** You change an input, such as the traffic,
  the pool size or the network delay, and watch the outcome change. Simulations are
  deterministic, so Reset replays exactly the same run.
- **Code in Python and JavaScript,** from the naive version to a production-shaped one. Every
  snippet has a runnable twin in [`examples/`](examples).
- **Current sources.** Every fact, number and source is from 2020 or later, or from a standard
  still in force. Each page ends with Further reading.
- **Interview corner, a short quiz and a recap,** so a page also works for revision.

A page usually takes 30–45 minutes to read.

## What it covers

The [roadmap](https://seniordevnotes.in/roadmap/) lists every planned topic and shows which are
already published. Topics are grouped into 14 tracks:

| Track | Examples |
|---|---|
| Foundations | what happens when you type a URL, latency vs throughput, percentiles and tail latency |
| Networking & APIs | DNS, TCP vs UDP, TLS, REST API design, gRPC, WebSockets |
| Traffic & edge | load balancing, reverse proxies, API gateways, CDNs, consistent hashing |
| Databases | indexing, connection pooling, N+1 queries, replication, sharding, locking |
| Caching | caching strategies, invalidation, cache stampedes, hot keys |
| Distributed systems | CAP, consistency models, clocks, consensus with Raft, sagas |
| Messaging & async | queues, pub/sub, Kafka, delivery semantics, idempotency, outbox |
| Resilience | timeouts, retries and backoff, circuit breakers, rate limiting, load shedding |
| Security | authentication, OAuth and OpenID Connect, JWTs, DPoP, injection, SSRF |
| Performance & runtime | scaling, autoscaling, concurrency, event loops, garbage collection |
| Delivery & infrastructure | containers, Kubernetes, CI/CD, feature flags, deployment strategies |
| Observability & operations | logging, metrics, tracing, alerting, SLOs, incident response |
| AI-era systems | Model Context Protocol, RAG, vector databases, LLM rate limits |
| Case studies | URL shortener, chat, news feed, payments, IRCTC Tatkal booking |

If you are new, start with the [suggested starter path](https://seniordevnotes.in/) on the home
page: 20 topics in reading order.

## Running the examples

Each published topic has a folder in [`examples/`](examples) with Python and JavaScript versions
and a README with the exact commands. Most use only the standard library:

```bash
python3 examples/n-plus-one-queries/python/n_plus_one.py
node examples/n-plus-one-queries/js/n-plus-one.mjs
```

Some topics also include the benchmark scripts used for the numbers on the page, for example
`examples/connection-pooling/postgres/run.sh`, which starts a throwaway PostgreSQL and measures
it.

## Running the site locally

The site is built with [Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/).
It needs Node.js 22.22 or later.

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # static site in dist/
npm run preview   # serve the built site
```

## How the repo is organised

```
src/content/docs/<track>/<slug>.mdx   the topic pages
src/components/diagrams/<slug>/       SVG diagrams for each topic
src/components/sims/<slug>/           interactive simulations for each topic
src/components/sim/                   the shared simulation frame and helpers
examples/<slug>/                      runnable code and benchmarks behind each page
research/<slug>.md                    research notes and sources for each page
CURRICULUM.md                         the full topic list, in reading order, with status
```

## How pages are made

Pages are researched and drafted with AI assistance ([Claude Code](https://claude.com/claude-code)),
then reviewed and edited by Uday before they go live. Every page follows the same template and
style guide, which live in [`.claude/skills/add-topic/`](.claude/skills/add-topic). The
[About page](https://seniordevnotes.in/about/) describes the process in more detail.

## Feedback

- **Found a mistake or a confusing section?** [Open an issue](https://github.com/udaysingh236/senior-dev-notes/issues/new),
  or use the **Edit page** link at the bottom of any page. "I got lost at section X" is useful
  feedback.
- **Want a topic explained?** Check the [roadmap](https://seniordevnotes.in/roadmap/) first, then
  open an issue with the topic and the question you were trying to answer.

## License

[MIT](LICENSE) © 2026 Uday Singh
