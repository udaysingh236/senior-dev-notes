# Style guide

How every page should sound, read and teach.

## Who we write for

- Final-year CS students, bootcamp grads, and engineers in their first 0–2 years of work.
  Smart and curious, but short on production experience.
- Many read on phones. Many speak English as a second language.
- Assume they know: basic Python or JavaScript, roughly what an HTTP request is, what a database
  table is. Anything beyond that, explain it or link to the page that does.

## The voice: a senior engineer mentoring a junior

Picture an engineer with 25+ years behind them. They built systems through the early web, the move
to cloud, mobile scale and now AI. They have been paged at 3 AM, caused outages and fixed them.
They are patient, they enjoy teaching, and they never make you feel stupid.

- Talk to "you". Use "we" when walking through a design together.
- Explain why before how. Every mechanism exists because something hurt.
- Share judgment, not only facts: "In practice I'd start with X, because…",
  "This is the part people get wrong."
- Be honest about trade-offs and uncertainty. There are no silver bullets.
- Warm, with an occasional dry line of humour. Never a joke at the reader's expense.
  No memes, no emoji in body text.
- Experience-flavoured wisdom is written as general truth ("Teams usually discover…",
  "A classic outage pattern is…"). Never invent first-person anecdotes or fake incidents at real
  companies. Opening stories are clearly illustrative ("Imagine…"). Real incidents only when
  sourced, with a link to the public postmortem.

## The shape of every explanation: left, right, then centre

Before landing on the answer, walk around it:

- **Left — the world before.** What problem exists, who feels it, what it costs.
- **Right — the neighbours.** What people try first and why it breaks. Which nearby concepts it gets
  confused with, and how they differ.
- **Centre — the core.** The key idea in plain words, then real depth.
- **Forward — what's next.** What this unlocks and which topic to read after it.

Inside each mechanism, repeat in miniature:
intuition → how it works step by step → worked example with real numbers → where it breaks → when to pick it.

## Clarity rules

- Short paragraphs of 2–4 sentences. A heading, visual or code block at least every ~400 words.
- Plain words over clever ones. Avoid idioms and slang that don't translate ("ballpark",
  "out of the park", "low-hanging fruit").
- Define every term the first time it appears: **bold** the term, one plain sentence, link to its
  own page if one exists.
- Use concrete numbers: "a bucket of 10 tokens refilling at 5 per second", not "some tokens".
- One strong everyday analogy per core idea, then say where the analogy stops working.
  Examples should be familiar worldwide. Indian everyday examples (UPI payments, Tatkal ticket
  rush, festival sale traffic, toll plazas, dabbawalas) are welcome where they fit naturally.
- Never write "simply", "just", "obviously", "trivially" or "easy". They make a struggling reader
  feel bad.
- Prose for reasoning. Lists for steps, options and checklists. Tables for comparing 3+ options.
- Every visual gets a sentence before it (what to look at) and after it (what you just saw).
- Page titles in Title Case. Headings in sentence case. Code identifiers in backticks.
  Units: ms, s, MB, req/s.

## Asides (Starlight syntax)

- `:::tip[Title]` practical advice
- `:::caution[Title]` common mistakes
- `:::danger[Title]` things that cause outages, data loss or security holes
- `:::note[From the trenches]` experience-flavoured judgment

About one aside per 500 words. More than that and they stop being noticed.

## Code

- Python 3.11+ and modern JavaScript (Node 20+, ES modules). Standard library first. If a
  dependency is needed, name it and say why.
- Progression: naive → correct → production-shaped. Show the naive version actually failing
  (a test, a printed result, a race reproduced).
- Real contexts, not foo/bar: a FastAPI or Flask endpoint, an Express middleware, a worker loop,
  a Redis Lua script, an nginx config.
- Readable over clever: descriptive names, comments that explain why, type hints in Python,
  JSDoc where it helps.
- On the page, keep each snippet under ~60 lines. The full version lives in `examples/<slug>/` and
  is linked from the page.
- Every snippet was run. Show expected output in a comment or an output block.
- Python and JavaScript always appear side by side in synced tabs:
  `<Tabs syncKey="lang">` with `<TabItem label="Python">` and `<TabItem label="JavaScript">`.
  Config files (nginx, YAML, SQL) can appear on their own.
- Never include real secrets, keys, tokens or internal URLs.

## Accuracy

- Anything that can change (spec versions, product limits, defaults, prices) carries
  "as of <Month YYYY>" and a source link.
- Prefer primary sources: RFCs, specs, official docs, original papers.
- If sources disagree, say so and explain why.
- No invented statistics. If a number is only illustrative, say so.

## Originality

- Research widely, then write in your own words and your own structure.
- No copied sentences, diagrams or code. Quote only when exact wording matters: under 15 words,
  attributed.
- Every source used appears in Further reading, with one line on what it's good for.

## Length

Readers should finish a page in one sitting. The "min read" in the page header is the budget
(it counts about 220 words a minute plus about 20 lines of code a minute):

| Page shape | Reading time | Prose | Code shown on the page |
|---|---|---|---|
| Single topic (`template.mdx`) | 35–45 min | about 6,000–7,500 words | at most ~150 lines |
| Comparison (`template-compare.mdx`) | 20–30 min | about 4,000–5,500 words | at most ~100 lines |

- Everything on the page counts, including `<details>` answers and asides.
- When a page runs long, cut in this order: repeated explanations, a fourth or fifth real-world
  example, extra gotchas, code that the `examples/` folder already holds. Keep the story, the
  core idea and the worked examples with numbers.
- A topic that truly cannot fit is two topics. Split it into an overview page and child pages
  rather than going over budget.
- Short is not the goal; clear is. Every section must teach something the reader didn't know.
