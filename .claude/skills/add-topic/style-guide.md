# Style guide

How every page should sound, read and teach.

## Who we write for

- Anyone from a final-year CS student to an engineer with 6–8 years of experience. Write so the
  fresher can follow and the experienced engineer still learns something on every screen.
- The reader is technical. They are giving us 30–45 minutes; every paragraph has to be worth it.
- Many read on phones. Many speak English as a second language.
- Assume they know: Python or JavaScript, HTTP requests and status codes, SQL tables and
  transactions at a basic level, what a server and a database are, and how everyday products work
  from the user's side (booking a ticket, paying online, logging in). Never explain those.
  Anything beyond that, define it in one sentence or link to the page that does.

## The voice: a senior engineer mentoring a junior

Picture an engineer with 25+ years behind them. They built systems through the early web, the move
to cloud, mobile scale and now AI. They have been paged at 3 AM, caused outages and fixed them.
They are patient, they enjoy teaching, and they never make you feel stupid.

- Talk to "you". Use "we" when walking through a design together.
- Explain why before how. Every mechanism exists because something hurt.
- Share judgment, not only facts: "In practice I'd start with X, because…",
  "This is the part people get wrong."
- Technical depth over narrative. Mechanisms, data structures, failure cases and numbers carry
  the page; stories do not.
- Be honest about trade-offs and uncertainty. There are no silver bullets.
- Warm, with an occasional dry line of humour. Never a joke at the reader's expense.
  No memes, no emoji in body text.
- Experience-flavoured wisdom is written as general truth ("Teams usually discover…",
  "A classic outage pattern is…"). Never invent first-person anecdotes or fake incidents at real
  companies. Opening stories are clearly illustrative ("Imagine…"). Real incidents only when
  sourced, with a link to the public postmortem.

## The opening: a question they never asked themselves

The first 2–4 sentences decide whether a working engineer keeps reading. Open with a sharp
technical question or a surprising fact that the reader has not thought about, and that the page
then answers. No scene-setting, no characters, no "imagine you joined a team".

- Good: "Berth 23 is sold Delhi to Agra. Someone else wants it Agra to Bhopal, at the same
  second as two other people. What exactly does the database lock?"
- Good: "Put a layer 4 balancer in front of eight gRPC servers and three clients. Five servers
  will sit idle. Why?"
- Bad: a paragraph about a team, a deadline, a design review, or what a user sees on the screen.

At most ~120 words before the first real technical content. Short illustrative scenarios are fine
inside a section when they carry a number or a failure case; long narratives are not.

## No repetition, no padding

- Say each thing once, in the section that owns it. Do not re-explain a term, a mechanism or a
  number in a later section; link back or use it.
- No sections whose only job is to restate: recap is bullets, not prose.
- Do not explain what every engineer already knows (see "Who we write for"). Spend the words on
  the parts that are hard, surprising or commonly wrong.
- Never pad to reach a reading time. If the topic is done in 30 minutes, it is done.

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
- An everyday analogy only when it truly helps a hard idea, and then say where it stops working.
  Never for things the reader already understands.
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
- Case studies of real systems: most companies publish little about their internals. Source every
  claim about the real system, and label everything else as a design for a system like it
  ("one way to build this is…"). Never present a guess as the company's actual design.

## Originality

- Research widely, then write in your own words and your own structure.
- No copied sentences, diagrams or code. Quote only when exact wording matters: under 15 words,
  attributed.
- Every source used appears in Further reading, with one line on what it's good for.

## Length

Readers should finish a page in one sitting. The "min read" in the page header counts about 220
words a minute plus about 20 lines of code a minute. The length follows the topic, not a target:

| Page shape | Usual reading time | Code shown on the page |
|---|---|---|
| Single topic (`template.mdx`) | 30–45 min | at most ~150 lines |
| Comparison (`template-compare.mdx`) | 30–40 min | at most ~100 lines |
| Case study (`template-case-study.mdx`) | 35–50 min | at most ~150 lines |

- 50 minutes is the hard maximum. Past 50, split the page.
- Under 30 is fine for a small topic, as long as nothing core is missing.
- Section word counts in the templates are ceilings, not targets.

- Everything on the page counts, including `<details>` answers and asides.
- When a page runs long, cut in this order: anything the reader already knows, repeated
  explanations, narrative, a fourth or fifth real-world example, extra gotchas, code that the
  `examples/` folder already holds. Keep the core mechanisms, the failure cases and the worked
  examples with numbers.
- A topic that cannot fit in 50 minutes is two topics. Split it into an overview page and child pages
  rather than going over budget.
- Short is not the goal; clear is. Every section must teach something the reader didn't know.
