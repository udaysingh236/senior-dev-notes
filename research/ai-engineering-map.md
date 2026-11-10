# AI engineering: where each concept is taught

Source: the "AI engineer roadmap" reel (92 concepts in 6 areas) and the two project reels
("Six RAG skills, six projects", "Six AI engineer skills, six projects"), shared November 2026.
Small concepts are taught inside a page, as a building block (Part 1) or a section (Part 2).
All slugs are in the `ai-engineering` track unless marked `build/`.

## The 92 roadmap concepts

**LLMs (16)**
neural network basics → neural-networks-basics · transformer architecture, self-attention →
transformers-and-attention · tokens and tokenization, context windows → tokens-and-context-windows
· embeddings → embeddings · pretraining, SFT, RLHF and preference tuning → how-llms-are-trained ·
LoRA and PEFT → lora-and-peft · quantization → quantization · temperature and top-p,
hallucinations → sampling-and-hallucinations · reasoning models, multimodal models, open-weight vs
closed → model-landscape

**Prompt engineering (15)**
system vs user prompts, role prompting, instructions and constraints, XML tags and delimiters →
prompt-basics · zero-shot, few-shot, chain-of-thought, self-consistency → prompting-techniques ·
structured outputs → structured-outputs · prompt chaining, context engineering →
prompt-chaining-and-context-engineering · prompt templates, prompt versioning and testing →
prompt-templates-and-versioning · prompt caching → prompt-caching · prompt-injection defence →
prompt-injection

**RAG (15)**
RAG architecture → rag-architecture · document parsing, chunking strategies →
document-parsing-and-chunking · embedding models → embedding-models · vector databases, cosine
similarity (also in embeddings), ANN indexes (HNSW), metadata filtering → vector-databases ·
hybrid search → hybrid-search · reranking → reranking · query rewriting → query-rewriting ·
citations and grounding → citations-and-grounding · agentic RAG, GraphRAG →
agentic-rag-vs-graphrag · RAG evaluation → rag-evaluation

**AI agents (15)**
the agent loop, ReAct → agent-loop-and-react · workflows vs agents → workflows-vs-agents ·
function calling, tool design and schemas → function-calling-and-tools · planning and
decomposition, multi-agent systems, orchestration and subagents → planning-and-multi-agent-systems
· agent memory → agent-memory · MCP → mcp-overview (and mcp-authorization) · human-in-the-loop,
guardrails and permissions → human-in-the-loop-and-permissions · computer-use agents →
computer-use-agents · error handling and retries, tracing and debugging →
agent-reliability-and-tracing

**AI evals (15)**
eval-driven development, golden datasets, error analysis → eval-driven-development ·
deterministic checks, LLM-as-a-judge, rubric design, human evaluation, pairwise comparisons →
eval-grading-methods · faithfulness and groundedness, retrieval metrics (Recall@K) →
rag-evaluation · agent trajectory evals → agent-evals · offline vs online evals, regression
testing, A/B testing in production → offline-online-evals-and-regression · red teaming →
red-teaming

**LLMOps (16)**
LLM APIs and SDKs, streaming → llm-apis-and-streaming · model selection, routing and fallbacks →
model-selection-and-routing · rate limits and retries → llm-rate-limits · token cost management
→ llm-cost-management · latency optimisation → llm-latency · prompt and semantic caching →
semantic-caching (and prompt-caching) · GPU fundamentals → gpu-fundamentals · model serving
(vLLM), KV cache and batching → model-serving-vllm · observability and tracing, user feedback
loops → llm-observability · guardrails in production, PII redaction and privacy →
production-guardrails · CI/CD for LLM apps → cicd-for-llm-apps

## Added to fill gaps (marked `new` in CURRICULUM.md)

- how-llms-generate-text: next-token prediction and decoding, which every later page relies on.
- A Fine-tuning sub-group: prompting-vs-rag-vs-fine-tuning (the first decision),
  fine-tuning-data, distillation-and-small-models.
- rag-ingestion-pipelines (keeping an index fresh, deletes, permissions) and long-context-vs-rag.
- code-execution-sandboxes (where agent-written code runs safely); agent-to-agent protocols and
  mixture of experts as building blocks.
- benchmarks-and-leaderboards (what public scores do and do not predict).
- self-hosting-vs-model-apis, owasp-llm-top-10, model-versions-and-migrations.
- mcp-authorization was already planned before the reels.

## The 12 reel projects → build pages (titled by concept)

PDF chunking comparison → build/chunking-lab · search filtered by department and date →
build/metadata-filtering-lab · hybrid keyword + semantic search, and hybrid search RAG over
internal docs (merged: the same build) → build/hybrid-search-lab · before vs after reranking →
build/reranking-lab · document assistant with citations → build/citations-lab · RAG evaluation
dashboard → build/rag-evaluation-lab · agent orchestration → build/agent-orchestration-lab ·
semantic caching layer → build/semantic-caching-lab · automated eval dataset generator →
build/golden-datasets-lab · LoRA fine-tuning pipeline → build/lora-fine-tuning-lab · Text-to-SQL
with guardrails → build/text-to-sql-guardrails-lab.

Added builds: build/structured-outputs-lab, build/function-calling-lab, build/mcp-server-lab,
build/llm-judge-lab. Paid services named in the reels (Pinecone, Cohere, W&B) get free local
swaps (FAISS or Qdrant, open cross-encoders, local logging); the paid service may be an optional
alternative.
