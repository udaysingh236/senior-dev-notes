# Research: Tokens, tokenization and context windows

Researched 2026-11-12. Page: `src/content/docs/ai-engineering/tokens-and-context-windows.mdx`.

## Key facts (with sources)

- A token can be a character, part of a word, a whole word or punctuation; English averages about
  4 characters per token, about three quarters of a word. Counts differ by model, encoding and
  language; message structure and tools add tokens. (OpenAI Help, "What are tokens and how to
  count them", updated 2025–26: https://help.openai.com/en/articles/4936856)
- tiktoken README: BPE is reversible and lossless, works on any text including text unseen in
  training, compresses to about 4 bytes per token on average, and lets the model see common
  sub-words ("encod" + "ing"). (https://github.com/openai/tiktoken, read Nov 2026)
- Gemini docs: a token is about 4 characters; 100 tokens are about 60–80 English words; a
  count-tokens call estimates before sending. (https://ai.google.dev/gemini-api/docs/tokens, 2025–26,
  read via search snippet; host blocked from the container)
- Anthropic context windows doc (read Nov 2026): the window holds the conversation history plus the
  new output; system prompt, messages, tool results, images, documents and tool definitions all
  count; thinking counts as output. 1M tokens is the default window for current Claude models
  (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2…); older ones 200K. Max output 128K on current models.
  Input alone over the window → HTTP 400 "prompt is too long". On Claude 4.5+, input +
  `max_tokens` may exceed the window; if generation hits it, `stop_reason:
  "model_context_window_exceeded"`. The doc names "context rot": accuracy and recall degrade as
  token count grows. Server-side compaction is the recommended strategy for long chats.
  (https://platform.claude.com/docs/en/build-with-claude/context-windows)
- Anthropic token counting: `POST /v1/messages/count_tokens`, free, separate rate limits, count is
  an estimate. Claude Opus 4.7 and later use a newer tokenizer: the same text gives roughly 30% more
  tokens than earlier models. (https://platform.claude.com/docs/en/build-with-claude/token-counting)
- Anthropic models overview: on the current tokenizer, 1M tokens ≈ 555k words or 2.5M Unicode
  characters; earlier models fit about 750k words in 1M tokens.
  (https://platform.claude.com/docs/en/about-claude/models/overview)
- Anthropic, "Effective context engineering for AI agents" (29 Sep 2025): context is a finite
  resource with diminishing returns, an "attention budget"; transformers create n² pairwise
  relationships for n tokens; compaction summarises a conversation near the limit and restarts with
  the summary. (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- OpenAI reasoning guide: reasoning tokens are hidden but occupy the context window and are billed
  as output; reserve at least 25,000 tokens for reasoning and output when starting.
  (https://developers.openai.com/api/docs/guides/reasoning, 2025–26, via search snippet)
- OpenAI "Hello GPT-4o" (May 2024): the new tokenizer (o200k_base) cut Hindi tokens 2.9× on their
  sample (90 → 31), Gujarati 4.4×, Tamil 3.3×. (https://openai.com/index/hello-gpt-4o/)
- Petrov et al., "Language Model Tokenizers Introduce Unfairness Between Languages", NeurIPS 2023:
  the same text translated can differ up to 15× in token count; even byte-level models show 4×+
  gaps; affects cost, latency and how much fits in context. (https://arxiv.org/abs/2305.15425)
- Tamang & Bora, "Evaluating Tokenizer Performance of LLMs Across Official Indian Languages"
  (arXiv 2411.12240, Nov 2024): compares tokenizers on the 22 Indian languages.
- Llama 3 (Meta, April 2024; "The Llama 3 Herd of Models", July 2024): 128K-token vocabulary
  (128,256: 100K from tiktoken plus 28K for non-English), roughly 15% fewer tokens than Llama 2,
  English compression up from about 3.2 to 4 characters per token; first release had an 8,192-token
  window; Llama 3 8B has 32 layers, 8 key/value heads of size 128. (https://arxiv.org/abs/2407.21783)
- Liu et al., "Lost in the Middle", TACL 2024: U-shaped accuracy — best when the relevant fact is
  at the start or end of the input, worse in the middle; worse as inputs get longer.
  (https://aclanthology.org/2024.tacl-1.9/)
- Hong, Troynikov, Huber, "Context Rot" (Chroma, 14 Jul 2025): 18 models; performance grows
  less reliable as input length grows, even on simple tasks, and non-uniformly.
  (https://research.trychroma.com/context-rot)
- Glitch tokens: "SolidGoldMagikarp" (Rumbelow & Watkins, LessWrong, Feb 2023) — tokens in the
  vocabulary that were almost never seen in model training (Reddit usernames) make GPT-3 behave
  strangely. Land & Bartolo, "Fishing for Magikarp" (EMNLP 2024, Cohere) detect under-trained
  tokens automatically across many open models. (https://www.lesswrong.com/posts/aPeJE8bSo6rAFoLqg,
  https://aclanthology.org/2024.emnlp-main.649)
- BPE for subwords: Sennrich, Haddow, Birch 2016 (kept as history, pre-2020). Hugging Face LLM
  course chapter 6.5 teaches BPE training on a toy corpus (2021+,
  https://huggingface.co/learn/llm-course/chapter6/5). Karpathy, "Let's build the GPT Tokenizer"
  (Feb 2024) and minbpe (https://github.com/karpathy/minbpe).

## Measured numbers (tiktoken 0.14.0, run 2026-11-12 in this session)

| Text | Bytes | cl100k_base (GPT-4, GPT-3.5) | o200k_base (GPT-4o and later) |
|---|---|---|---|
| `I love reading books.` | 21 | 5 | 5 |
| `मुझे किताबें पढ़ना पसंद है।` | 73 | 29 | 9 |
| English 2-sentence version (74 chars) | 74 | 17 | 17 |
| Hindi 2-sentence version (94 chars) | 244 | 93 | 26 |
| `Tokenization` | 12 | `Token`+`ization` | `Token`+`ization` |
| `strawberry` / ` strawberry` | | 3 / 1 | 3 / 1 |
| `12345678` | | `123`,`456`,`78` | same |
| `😀` | 4 | 2 | 1 |

Vocabulary sizes: cl100k_base 100,277; o200k_base 200,019 (from `n_vocab`).
o200k pieces of the Hindi sentence: म | ुझे | ␣किताब | ें | ␣पढ़ | ना | ␣पसंद | ␣है | ।
Each Devanagari character is 3 bytes in UTF-8; ASCII is 1 byte.

Derived: Llama 3 8B memory per token for the model's notes (keys and values): 32 layers × 8 heads
× 128 numbers × 2 (key and value) × 2 bytes = 131,072 bytes = 128 KB. At 8,192 tokens: 1 GB. At
128K tokens: 16 GB.

## Misconceptions and confusing points

- "A token is a word." No: pieces of words, spaces glued to the front of words, punctuation.
- "The context window is the model's memory." The model remembers nothing between calls; the app
  re-sends the conversation; the window is how much one call can look at.
- "Context window = how much I can send." It includes the answer (and hidden reasoning).
- "Token counts are the same across models." Each model family has its own tokenizer;
  Claude's newer tokenizer gives ~30% more tokens for the same text.
- "If it fits, the model uses it all equally well." Lost in the middle, context rot.
- "Characters ÷ 4" works for English only; non-Latin scripts cost more.
- "Can't count letters in strawberry because it's dumb": it sees `str`+`aw`+`berry`, not letters.

## How explainers structure it (and what they leave out)

- OpenAI help article: rules of thumb, tokenizer tool, pricing. Leaves out why (BPE) and the window.
- Hugging Face course 6.5: BPE training algorithm on a toy corpus, code. Leaves out the context
  window, cost, languages, production trimming.
- Karpathy's video: deep, two hours, builds GPT-4 tokenizer; aimed at ML people, not app engineers.
- Our angle: one running example (English vs Hindi sentence) from "what is a token" through BPE,
  bytes, language cost, the window as a budget, what apps do at the edge, and why long windows
  still degrade — for an app engineer, with runnable code and two sims.

## Full source list (Further reading)

1. OpenAI Help — What are tokens and how to count them (2025–26)
2. openai/tiktoken README (2023–26)
3. Anthropic — Context windows (docs, read Nov 2026)
4. Anthropic — Token counting (docs, read Nov 2026)
5. Anthropic — Models overview (docs, read Nov 2026)
6. Anthropic — Effective context engineering for AI agents (Sep 2025)
7. Google — Gemini API: Understand and count tokens (2025–26)
8. OpenAI — Reasoning models guide (2025–26)
9. OpenAI — Hello GPT-4o (May 2024)
10. Petrov et al. — Tokenizers introduce unfairness between languages (NeurIPS 2023)
11. Tamang & Bora — Tokenizers across official Indian languages (2024)
12. Meta — The Llama 3 Herd of Models (2024)
13. Liu et al. — Lost in the Middle (TACL 2024)
14. Chroma — Context Rot (2025)
15. Rumbelow & Watkins — SolidGoldMagikarp (2023)
16. Land & Bartolo — Fishing for Magikarp (EMNLP 2024)
17. Hugging Face LLM course — Byte-Pair Encoding tokenization (2021+)
18. Karpathy — Let's build the GPT Tokenizer, and minbpe (2024)

## Fresher read

(Filled in Phase 8; must be empty before publishing.)
