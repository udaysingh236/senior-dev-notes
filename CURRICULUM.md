# Curriculum

The master list of topics, in reading order within each track. This file is the source of truth for
what exists, what is planned, and where each page lives. `/add-topic` reads and updates it.

- **Path on disk:** `src/content/docs/<track>/<slug>.mdx`
- **Post #:** the item number(s) from the original "Who's gonna tell vibe coders about…" list this page covers. `reel` = from the AI-engineer roadmap and project reels (November 2026). `new` = added to fill a gap.
- **Status:** `planned` → `outline (YYYY-MM-DD)` → `pilot` → `published (YYYY-MM-DD)`. An outline page is live but shows only the article's planned headings (`outline: true` in its frontmatter); writing it replaces the outline. Use `merged → <slug>` if a topic was folded into another page.
- **Sub-groups:** a track may split its table under sub-headings such as `### Agents — ` followed by the folder name in backticks. The sidebar shows one collapsible sub-group per heading; pages still live directly in the track folder.

Some items from the original list are merged into one page where they are two halves of one idea
(for example optimistic + pessimistic locking). Every one of the 111 original items is covered.

---

## Suggested starter path (read these 20 first)

how-the-web-works → dns → tcp-vs-udp → tls → rest-api-design → latency-vs-throughput →
load-balancing → caching-strategies → database-indexing → connection-pooling → n-plus-one-queries →
timeouts → retries-and-backoff → idempotency-keys → rate-limiting → circuit-breakers →
message-queues → replication → logging → slis-slos-error-budgets

## AI starter path (read these 10 first for AI engineering)

tokens-and-context-windows → how-llms-generate-text → embeddings → prompt-basics →
structured-outputs → llm-apis-and-streaming → rag-architecture → hybrid-search →
function-calling-and-tools → eval-driven-development

---

## 1. Foundations — `foundations`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | What happens when you type a URL | how-the-web-works | new | published (2026-10-18) |
| 2 | Back-of-the-envelope estimation | back-of-the-envelope-estimation | new | planned |
| 3 | Latency vs throughput | latency-vs-throughput | 89, 90 | published (2026-10-25) |
| 4 | Percentiles, P99 and tail latency | percentiles-and-tail-latency | 91, 92 | planned |
| 5 | Monolith vs microservices | monolith-vs-microservices | new | planned |

## 2. Networking & APIs — `networking`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | DNS | dns | 60 | published (2026-10-18) |
| 2 | TCP vs UDP | tcp-vs-udp | 59 | published (2026-10-18) |
| 3 | TLS and encryption in transit | tls | 49, 51 | published (2026-10-18) |
| 4 | HTTP/1.1 → HTTP/2 → HTTP/3 | http-evolution | 58 | planned |
| 5 | REST API design | rest-api-design | new | published (2026-10-23) |
| 6 | API versioning | api-versioning | 77 | planned |
| 7 | Pagination | pagination | new | planned |
| 8 | gRPC | grpc | 57 | planned |
| 9 | Long polling | long-polling | 56 | planned |
| 10 | Server-Sent Events | server-sent-events | 55 | planned |
| 11 | WebSockets | websockets | 54 | planned |
| 12 | Webhooks | webhooks | 17 | planned |
| 13 | CORS | cors | 18 | planned |

## 3. Traffic & edge — `traffic`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Reverse proxies | reverse-proxies | 3 | planned |
| 2 | Load balancing | load-balancing | 8 | published (2026-10-26) |
| 3 | API gateways | api-gateways | 9 | planned |
| 4 | Reverse proxy vs load balancer vs API gateway | proxy-lb-gateway | new | published (2026-10-22) |
| 5 | CDNs and edge caching | cdn-and-edge-caching | 84, 85 | planned |
| 6 | Service discovery | service-discovery | 64 | planned |
| 7 | Consistent hashing | consistent-hashing | new | planned |

## 4. Databases — `databases`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | SQL vs NoSQL | sql-vs-nosql | new | planned |
| 2 | ACID and isolation levels | acid-and-isolation-levels | new | planned |
| 3 | Database indexing (scan vs seek) | database-indexing | 20 | published (2026-10-26) |
| 4 | Storage engines: B-trees vs LSM trees | b-trees-vs-lsm-trees | new | planned |
| 5 | Write-ahead log | write-ahead-log | new | planned |
| 6 | Query optimization | query-optimization | 21 | planned |
| 7 | N+1 queries | n-plus-one-queries | 5 | published (2026-10-29) |
| 8 | Connection pooling | connection-pooling | 4 | published (2026-10-26) |
| 9 | Replication | replication | 30 | planned |
| 10 | Read replicas | read-replicas | 22 | planned |
| 11 | Partitioning and sharding | partitioning-and-sharding | 28, 29 | planned |
| 12 | Schema migrations and versioning | schema-migrations | 23, 24 | planned |
| 13 | Optimistic vs pessimistic locking | optimistic-vs-pessimistic-locking | 25, 26 | planned |
| 14 | Race conditions | race-conditions | 14 | planned |
| 15 | Deadlocks | deadlocks | 15 | planned |

## 5. Caching — `caching`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Caching strategies | caching-strategies | 6 | published (2026-10-26) |
| 2 | Cache invalidation | cache-invalidation | 7 | planned |
| 3 | Cache stampede (thundering herd) | cache-stampede | new | planned |
| 4 | Hot keys | hot-keys | new | planned |
| 5 | Bloom filters | bloom-filters | new | planned |

## 6. Distributed systems — `distributed-systems`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | CAP and PACELC | cap-and-pacelc | 32 | planned |
| 2 | Consistency models | consistency-models | new | planned |
| 3 | Eventual consistency | eventual-consistency | 33 | planned |
| 4 | Network partitions | network-partitions | 93 | planned |
| 5 | Clock skew and time | clock-skew | 94 | planned |
| 6 | Logical clocks: Lamport and vector clocks | logical-clocks | new | planned |
| 7 | Unique ID generation (Snowflake and friends) | unique-id-generation | new | planned |
| 8 | Leader election | leader-election | 31 | planned |
| 9 | Consensus with Raft | consensus-raft | new | planned |
| 10 | Quorums | quorums | new | planned |
| 11 | Gossip protocols | gossip-protocols | new | planned |
| 12 | Distributed locks | distributed-locks | 27 | planned |
| 13 | Distributed transactions and 2PC | distributed-transactions | 34 | planned |
| 14 | Saga pattern | saga-pattern | 35 | planned |

## 7. Messaging & async — `messaging`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Message queues | message-queues | 36 | planned |
| 2 | Pub/Sub | pub-sub | 37 | planned |
| 3 | Event-driven architecture | event-driven-architecture | 38 | planned |
| 4 | Log-based messaging (Kafka) | log-based-messaging | new | planned |
| 5 | Delivery semantics: at-most, at-least, exactly once | delivery-semantics | new | planned |
| 6 | Idempotency keys | idempotency-keys | 1 | published (2026-11-06) |
| 7 | Transactional outbox | transactional-outbox | new | planned |
| 8 | CQRS and event sourcing | cqrs-and-event-sourcing | new | planned |
| 9 | Dead letter queues | dead-letter-queues | 39 | planned |
| 10 | Backpressure | backpressure | 40 | planned |
| 11 | Cron jobs and job scheduling | job-scheduling | 41 | planned |

## 8. Resilience — `resilience`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Timeouts | timeouts | 10 | published (2026-11-06) |
| 2 | Retries, exponential backoff and jitter | retries-and-backoff | 11, 12 | published (2026-11-06) |
| 3 | Circuit breakers | circuit-breakers | 13 | pilot |
| 4 | Bulkheads | bulkheads | new | planned |
| 5 | Rate limiting | rate-limiting | 2 | published (2026-10-17) |
| 6 | Load shedding | load-shedding | new | planned |
| 7 | Graceful degradation | graceful-degradation | new | planned |
| 8 | Health checks, liveness and readiness probes | health-checks-and-probes | 74, 75 | planned |
| 9 | Failover and high availability | failover | 96 | planned |
| 10 | Multi-region architecture | multi-region | 95 | planned |
| 11 | Backups and disaster recovery (RPO/RTO) | backups-and-disaster-recovery | 97, 98 | planned |
| 12 | Chaos engineering | chaos-engineering | 99 | planned |

## 9. Security — `security`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Authentication vs authorization | authn-vs-authz | new | planned |
| 2 | Storing passwords safely | password-storage | new | planned |
| 3 | Sessions vs tokens | sessions-vs-tokens | new | planned |
| 4 | OAuth 2.0 and OpenID Connect | oauth-and-oidc | 46 | planned |
| 5 | JWTs and key rotation | jwt-and-key-rotation | 47 | planned |
| 6 | DPoP: sender-constrained tokens | dpop | new | published (2026-10-28) |
| 7 | Passkeys and WebAuthn | passkeys | new | planned |
| 8 | IAM and least privilege | iam-and-least-privilege | 48 | planned |
| 9 | Secrets management | secrets-management | 19 | planned |
| 10 | Encryption at rest and key management | encryption-at-rest | 50 | planned |
| 11 | SQL injection | sql-injection | 42 | planned |
| 12 | Cross-site scripting (XSS) | xss | 43 | planned |
| 13 | Cross-site request forgery (CSRF) | csrf | 44 | planned |
| 14 | Server-side request forgery (SSRF) | ssrf | 45 | planned |
| 15 | Web application firewalls | waf | 52 | planned |
| 16 | DDoS protection | ddos-protection | 53 | planned |

## 10. Performance & runtime — `performance`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Scaling up vs scaling out | scaling-up-vs-out | 82, 83 | planned |
| 2 | Autoscaling | autoscaling | 81 | planned |
| 3 | Concurrency and thread safety | thread-safety | 80 | planned |
| 4 | Async I/O and event loops | async-io-and-event-loops | new | planned |
| 5 | Memory leaks | memory-leaks | 16 | planned |
| 6 | Garbage collection | garbage-collection | 79 | planned |
| 7 | Serverless: cold starts and limits | serverless-cold-starts-and-limits | 87, 88 | planned |
| 8 | Cloud cost optimization | cost-optimization | 86 | planned |

## 11. Delivery & infrastructure — `delivery`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Docker and containers | docker | 61 | planned |
| 2 | Kubernetes | kubernetes | 62 | planned |
| 3 | Helm charts | helm | 63 | planned |
| 4 | CI/CD | ci-cd | 65 | planned |
| 5 | Build caching | build-caching | 66 | planned |
| 6 | Infrastructure as Code (with Terraform) | infrastructure-as-code | 67, 68 | planned |
| 7 | Feature flags | feature-flags | 69 | planned |
| 8 | Deployment strategies: rolling, blue-green, canary | deployment-strategies | 70, 71, 72 | planned |
| 9 | Rollbacks and roll-forward | rollbacks | 73 | planned |
| 10 | Semantic versioning and dependency hell | semver-and-dependency-hell | 76, 78 | planned |

## 12. Observability & operations — `observability`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Observability: the big picture | observability-overview | 105 | planned |
| 2 | Logging | logging | 100 | planned |
| 3 | Metrics and monitoring | metrics-and-monitoring | 101, 103 | planned |
| 4 | Distributed tracing | distributed-tracing | 102 | planned |
| 5 | Alerting | alerting | 104 | planned |
| 6 | SLIs, SLOs and error budgets | slis-slos-error-budgets | 106, 107, 108 | planned |
| 7 | Incident response and on-call | incident-response-and-on-call | 109, 110 | planned |
| 8 | Postmortems | postmortems | 111 | planned |

## 13. AI engineering — `ai-engineering`

Every concept an AI engineer works with, from how a model reads text to running it in production.
Small concepts are taught inside the page they belong to, as building blocks or sections.

### LLM foundations — `llms`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Neural networks for engineers | neural-networks-basics | reel | outline (2026-11-10) |
| 2 | Tokens, tokenization and context windows | tokens-and-context-windows | reel | published (2026-11-12) |
| 3 | How an LLM writes: one token at a time | how-llms-generate-text | new | outline (2026-11-10) |
| 4 | Embeddings: meaning as numbers | embeddings | reel | outline (2026-11-10) |
| 5 | Transformers and self-attention | transformers-and-attention | reel | outline (2026-11-10) |
| 6 | How a model is trained: pretraining, SFT and RLHF | how-llms-are-trained | reel | outline (2026-11-10) |
| 7 | Temperature, top-p and hallucinations | sampling-and-hallucinations | reel | outline (2026-11-10) |
| 8 | The model landscape: reasoning, multimodal, open and closed | model-landscape | reel | outline (2026-11-10) |

### Prompt engineering — `prompting`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 9 | Prompt basics: system prompts, roles and instructions | prompt-basics | reel | outline (2026-11-10) |
| 10 | Zero-shot vs few-shot vs chain-of-thought | prompting-techniques | reel | outline (2026-11-10) |
| 11 | Structured outputs: JSON your code can trust | structured-outputs | reel | outline (2026-11-10) |
| 12 | Prompt chaining and context engineering | prompt-chaining-and-context-engineering | reel | outline (2026-11-10) |
| 13 | Prompt templates, versioning and testing | prompt-templates-and-versioning | reel | outline (2026-11-10) |
| 14 | Prompt caching | prompt-caching | reel | outline (2026-11-10) |
| 15 | Prompt injection | prompt-injection | reel | outline (2026-11-10) |

### Retrieval (RAG) — `rag`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 16 | Retrieval-augmented generation (RAG) | rag-architecture | reel | outline (2026-11-10) |
| 17 | Document parsing and chunking | document-parsing-and-chunking | reel | outline (2026-11-10) |
| 18 | Choosing an embedding model | embedding-models | reel | outline (2026-11-10) |
| 19 | Vector databases, HNSW and metadata filters | vector-databases | reel | outline (2026-11-10) |
| 20 | Hybrid search: keywords plus vectors | hybrid-search | reel | outline (2026-11-10) |
| 21 | Reranking | reranking | reel | outline (2026-11-10) |
| 22 | Query rewriting | query-rewriting | reel | outline (2026-11-10) |
| 23 | Citations and grounding | citations-and-grounding | reel | outline (2026-11-10) |
| 24 | Ingestion pipelines: keeping a RAG index fresh | rag-ingestion-pipelines | new | outline (2026-11-10) |
| 25 | Long context vs RAG | long-context-vs-rag | new | outline (2026-11-10) |
| 26 | Agentic RAG vs GraphRAG | agentic-rag-vs-graphrag | reel | outline (2026-11-10) |
| 27 | RAG evaluation | rag-evaluation | reel | outline (2026-11-10) |

### Agents — `agents`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 28 | The agent loop and ReAct | agent-loop-and-react | reel | outline (2026-11-10) |
| 29 | Workflows vs agents | workflows-vs-agents | reel | outline (2026-11-10) |
| 30 | Function calling and tool design | function-calling-and-tools | reel | outline (2026-11-10) |
| 31 | Planning, multi-agent systems and subagents | planning-and-multi-agent-systems | reel | outline (2026-11-10) |
| 32 | Agent memory | agent-memory | reel | outline (2026-11-10) |
| 33 | Model Context Protocol (MCP): the big picture | mcp-overview | reel | outline (2026-11-10) |
| 34 | MCP authorization: OAuth 2.1, DCR and CIMD | mcp-authorization | new | outline (2026-11-10) |
| 35 | Code execution and sandboxes | code-execution-sandboxes | new | outline (2026-11-10) |
| 36 | Computer-use agents | computer-use-agents | reel | outline (2026-11-10) |
| 37 | Human-in-the-loop, guardrails and permissions | human-in-the-loop-and-permissions | reel | outline (2026-11-10) |
| 38 | Agent errors, retries and tracing | agent-reliability-and-tracing | reel | outline (2026-11-10) |

### Evals — `evals`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 39 | Eval-driven development and golden datasets | eval-driven-development | reel | outline (2026-11-10) |
| 40 | Code checks vs LLM-as-judge vs human review | eval-grading-methods | reel | outline (2026-11-10) |
| 41 | Evaluating agents | agent-evals | reel | outline (2026-11-10) |
| 42 | Offline evals, online evals and regression tests | offline-online-evals-and-regression | reel | outline (2026-11-10) |
| 43 | Benchmarks and leaderboards | benchmarks-and-leaderboards | new | outline (2026-11-10) |
| 44 | Red teaming AI systems | red-teaming | reel | outline (2026-11-10) |

### Fine-tuning — `fine-tuning`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 45 | Prompting vs RAG vs fine-tuning | prompting-vs-rag-vs-fine-tuning | new | outline (2026-11-10) |
| 46 | Preparing fine-tuning data | fine-tuning-data | new | outline (2026-11-10) |
| 47 | LoRA, QLoRA and parameter-efficient fine-tuning | lora-and-peft | reel | outline (2026-11-10) |
| 48 | Quantization | quantization | reel | outline (2026-11-10) |
| 49 | Distillation and small models | distillation-and-small-models | new | outline (2026-11-10) |

### LLMOps — `llmops`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 50 | LLM APIs, SDKs and streaming | llm-apis-and-streaming | reel | outline (2026-11-10) |
| 51 | Model selection, routing and fallbacks | model-selection-and-routing | reel | outline (2026-11-10) |
| 52 | LLM rate limits, retries and token budgets | llm-rate-limits | reel | outline (2026-11-10) |
| 53 | Token cost management | llm-cost-management | reel | outline (2026-11-10) |
| 54 | Latency optimisation for LLM apps | llm-latency | reel | outline (2026-11-10) |
| 55 | Semantic caching | semantic-caching | reel | outline (2026-11-10) |
| 56 | GPU fundamentals for AI engineers | gpu-fundamentals | reel | outline (2026-11-10) |
| 57 | Serving models: vLLM, KV cache and batching | model-serving-vllm | reel | outline (2026-11-10) |
| 58 | Self-hosted models vs model APIs | self-hosting-vs-model-apis | new | outline (2026-11-10) |
| 59 | Observability for LLM apps | llm-observability | reel | outline (2026-11-10) |
| 60 | Guardrails in production and PII redaction | production-guardrails | reel | outline (2026-11-10) |
| 61 | The OWASP Top 10 for LLM applications | owasp-llm-top-10 | new | outline (2026-11-10) |
| 62 | Model versions and migrations | model-versions-and-migrations | new | outline (2026-11-10) |
| 63 | CI/CD for LLM apps | cicd-for-llm-apps | reel | outline (2026-11-10) |

## 14. Build it yourself — `build`

Hands-on projects. Each page is titled by the concept it teaches and builds one small, working
project with it, using free tools that run on a laptop. Read the concept page first.

### Prompting and tools — `prompting`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Structured outputs | structured-outputs-lab | new | outline (2026-11-10) |
| 2 | Function calling | function-calling-lab | new | outline (2026-11-10) |
| 3 | Model Context Protocol (MCP) | mcp-server-lab | new | outline (2026-11-10) |

### Retrieval (RAG) — `rag`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 4 | Chunking strategies | chunking-lab | reel | outline (2026-11-10) |
| 5 | Metadata filtering | metadata-filtering-lab | reel | outline (2026-11-10) |
| 6 | Hybrid search | hybrid-search-lab | reel | outline (2026-11-10) |
| 7 | Reranking | reranking-lab | reel | outline (2026-11-10) |
| 8 | Citations and grounding | citations-lab | reel | outline (2026-11-10) |
| 9 | RAG evaluation | rag-evaluation-lab | reel | outline (2026-11-10) |

### Agents — `agents`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 10 | Agent orchestration | agent-orchestration-lab | reel | outline (2026-11-10) |

### Evals — `evals`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 11 | Golden datasets | golden-datasets-lab | reel | outline (2026-11-10) |
| 12 | LLM-as-a-judge | llm-judge-lab | new | outline (2026-11-10) |

### Fine-tuning — `fine-tuning`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 13 | LoRA fine-tuning | lora-fine-tuning-lab | reel | outline (2026-11-10) |

### LLMOps — `llmops`

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 14 | Semantic caching | semantic-caching-lab | reel | outline (2026-11-10) |
| 15 | Guardrails | text-to-sql-guardrails-lab | reel | outline (2026-11-10) |

## 15. Case studies — `case-studies`

Each case study ties many concepts together and links back to their pages.

| # | Topic | Slug | Post # | Status |
|---|---|---|---|---|
| 1 | Design a URL shortener | url-shortener | new | planned |
| 2 | Design a rate limiter service | rate-limiter-service | new | planned |
| 3 | Design a notification system | notification-system | new | planned |
| 4 | Design a chat system | chat-system | new | planned |
| 5 | Design a news feed (fan-out) | news-feed | new | planned |
| 6 | Design a payment system | payment-system | new | planned |
| 7 | Design a distributed cache | distributed-cache | new | planned |
| 8 | Design a web crawler | web-crawler | new | planned |
| 9 | How IRCTC Tatkal booking works | irctc-tatkal-booking | new | published (2026-10-22) |
| 10 | How Google Authenticator works (TOTP) | google-authenticator | new | published (2026-11-06) |

## Inbox

Topic ideas saved with `/save-topic`, oldest first. `/add-topic` offers these first and moves each
one into its track's table when the page is written. Bullets, not a table: the site build reads
only the track tables above.


