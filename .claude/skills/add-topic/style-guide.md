# Style guide

How every page should sound, read and teach.

## Owner's standing feedback: read this first

Uday has reviewed the pages twice. In October 2026 he rejected the first IRCTC Tatkal and proxy
vs load balancer vs gateway pages for being narrative and shallow. In November 2026, after reading
every published page, he found the opposite problem: the pages go too fast. Terms such as
"in flight" and "utilisation" (latency vs throughput), or secrets tables, QR scanners and bytes
(Google Authenticator), arrive before the reader understands the basic idea. Neither a fresher nor
Uday could follow them. The plain sentence "when you scan the QR code, the app saves a secret, and
every 30 seconds it turns that secret and the time into six digits" appeared nowhere on the
Google Authenticator page.

These points combine both rounds. Where an October point conflicted with November, November wins
and the old point has been rewritten here. Every new or rewritten page must meet all of them.

1. **Write for the fresher first.** The reader we must never lose is a final-year student or new
   graduate who knows basic programming, HTTP requests and simple SQL. If they can follow every
   paragraph, the experienced engineer can too, and will skim what they know. Never write a
   paragraph that only an experienced engineer can follow. Still do not explain how products work
   from the user's side (booking a ticket, logging in, scanning a QR code with a phone).
2. **Every page has two parts.** **Part 1, "Understand it"**, explains the whole idea from zero,
   in plain words, with one running example and the simplest picture. A reader who stops there can
   explain the topic to a friend. **Part 2, "How it really works"**, is the depth: mechanisms,
   data structures, numbers, failure modes, production design. Part 2 builds on Part 1 and never
   uses an idea Part 1 or Part 2 has not explained yet.
3. **Technical core, not narrative.** Stories about teams, deadlines, users and screens are
   narrative; cut them. A slow, plain, step-by-step explanation of the mechanism is not narrative;
   it is the core, and it is never cut. The IRCTC page failed in October because it said nothing
   about how the database is locked; the November pages failed because they said it too fast.
4. **Fact checks are not content.** Listing public facts and rules is not an explanation. Cite facts
   inline where they shape the design; never spend a section on them.
5. **Two openings.** The page opens with a question a fresher can understand and wants answered,
   and answers it in plain words within the first screen. The sharp "I never asked myself that"
   question for experienced readers opens Part 2, not the page.
6. **Say each thing once.** Do not re-explain a term or mechanism in a later section; build on it.
   A plain-words version in Part 1 and its precise version in Part 2 are not repetition, as long
   as Part 2 adds the precision and does not restate the plain version.
7. **Length follows understanding.** There is no reading-time target. A page takes as long as it
   needs to explain its topic to a fresher without padding: usually 40–60 minutes, 75 at most.
   Past that, split it into a basics page and a deep-dive page. Never cut an explanation to save
   minutes; cut stories, extra examples and extra gotchas first (see "Length").
8. **Simulations must be worth looking at.** A sim that walks through the steps of a flow (the
   booking steps, a request passing boxes) is not worth building. Sims show mechanisms the reader
   cannot see in a diagram: contention, races, allocation, imbalance, queues, retries multiplying.
   The reader changes an input and sees the outcome change.
9. **No information older than 2020** (see "Accuracy").
10. **Comparison pages follow the same rules.** Compare what each concept can see and decide, and
   how they behave differently under load, not feature lists. Part 1 still explains each concept
   in plain words first.
11. **Every new concept gets four steps, in this order** (see "Introducing a new concept"): what it
   is in one plain sentence, why it exists, a worked example with real numbers, and only then the
   technical version. One new idea per paragraph. No sentence uses two terms that have not been
   explained yet.
12. **A fresher read before publishing.** Read the finished page as a final-year student who knows
   only what "Who we write for" lists. Mark every sentence where that reader would stop and
   ask "what does that mean?" or "why?", and fix every one (see "The fresher read").

13. **Never make the reader do maths** (November 2026, after the "where the other 839 go" tagline).
   The page does every calculation for the reader, in words, step by step (see "Numbers without
   maths for the reader").
14. **The author reads the whole page as a normal reader before publishing**, top to bottom, every
   word, on the built page, and fixes what a reader would trip on. Agent reports, checklists and
   a passing build are not a substitute (see "The publishing read").

No published page meets the November standard yet. Every page published before November 2026 will
be rewritten with `/add-topic --update`, one page per session, starting with Google Authenticator
(the pilot) and then latency vs throughput. The first page Uday approves under these rules becomes
the reference.

## Who we write for

- Write for a final-year CS student or a new graduate. Engineers with 6–8 years of experience read
  the site too; they skim Part 1 and read Part 2. Both must find every paragraph worth it.
- Many read on phones. Many speak English as a second language.
- Assume they know: Python or JavaScript, HTTP requests and status codes, SQL tables and basic
  queries, what a server and a database are, and how everyday products work from the user's side.
  Never explain those.
- Everything else gets explained before it is used, even if "every engineer knows it": queues,
  threads, hashing, encryption keys, bits and bytes, percentiles, locks, transactions, time zones
  and Unix time, caches, protocols. If unsure, explain it; a reader who knows it loses ten seconds,
  a reader who doesn't loses the page.

## The voice: a senior engineer mentoring a junior

Picture an engineer with 25+ years behind them. They built systems through the early web, the move
to cloud, mobile scale and now AI. They have been paged at 3 AM, caused outages and fixed them.
They are patient, they enjoy teaching, and they never make you feel stupid.

- Talk to "you". Use "we" when walking through a design together.
- Explain why before how. Every mechanism exists because something hurt.
- Explain at the pace of someone sitting next to the reader: one step, check it landed, next step.
  If a step needs two new ideas, it is two steps.
- Share judgment, not only facts: "In practice I'd start with X, because…",
  "This is the part people get wrong."
- Be honest about trade-offs and uncertainty. There are no silver bullets.
- Warm, with an occasional dry line of humour. Never a joke at the reader's expense.
  No memes, no emoji in body text.
- Experience-flavoured wisdom is written as general truth ("Teams usually discover…",
  "A classic outage pattern is…"). Never invent first-person anecdotes or fake incidents at real
  companies. Illustrative examples are clearly illustrative ("Imagine…"). Real incidents only when
  sourced, with a link to the public postmortem.

## The opening

The first screen decides whether the reader stays. It does two things:

1. **A question the fresher understands and wants answered** (2–4 sentences). It may be
   surprising, but it uses only words the reader already knows.
   - Good: "Your phone is in airplane mode, yet the six digits in Google Authenticator are exactly
     what the bank's server expects. The phone and the server have not talked since you scanned
     a QR code months ago. How do they agree?"
   - Good: "A server that is 90% busy is not 10% away from trouble. It is already making most
     requests wait several times longer than they need. Why?"
   - Bad: a question that needs the page to understand it ("Why does a ±1 step window with drift
     tracking double the valid codes?"). That question belongs at the start of Part 2.
   - Bad: a paragraph about a team, a deadline or what a user sees on the screen.
2. **The answer in plain words**, right after: the first paragraphs of "The idea in plain words"
   (Part 1). The reader should know the gist before the first scroll.

## The title line, tagline and description

The tagline under the title and the `description` (shown in search results and link previews) are
the first words anyone reads, before the opening. They follow the fresher rule more strictly than
anything else on the page:

- One plain sentence saying what the page explains, in words a fresher already knows.
- No riddles, no wordplay, no hidden reference to a number explained later in the page.
- No arithmetic the reader has to do. "Your connection could download the page in a thousandth of
  a second" works; "a 1 Gbit/s line does not download 100 KB in a millisecond" makes the reader
  convert units before they understand the claim.
- Bad: "Here is where the other 839 go." Good: "What happens between pressing Enter and seeing the
  page, and why distance, not your internet speed, decides how long it takes."

The same goes for the opening question: give the reader the conclusion in plain words ("almost a
full second"), and show the exact numbers and the arithmetic afterwards, in Part 1.

## Part 1: "Understand it"

Part 1 is a short page of its own. It contains:

- **The question** (above).
- **The idea in plain words.** The whole story from start to finish, told with one running example
  (one user, one request, one code, one berth) and real numbers. No jargon: if a term is needed,
  it is introduced with the four steps below. The mental-model diagram goes here: the simplest
  picture of the idea, a handful of boxes, no internals (`visuals.md`).
- **The building blocks**, if the plain story needs them: each concept the rest of the page relies
  on, introduced with the four steps. For Google Authenticator: a shared secret, a one-way
  function, Unix time. For latency vs throughput: latency, throughput, a queue, "in flight",
  utilisation.
- **If you stop here**: a `:::tip[If you stop here]` aside with 3–5 bullets a fresher could repeat
  to a friend. It closes Part 1.

Part 1 usually takes 8–15 minutes. It does not cover edge cases, numbers from production,
variants or failure modes; those are Part 2.

## Part 2: "How it really works"

Part 2 opens with a heading such as "Going deeper" and the sharp question for experienced readers
(2–4 sentences): the hard problem the rest of the page answers. Then the template's deep sections
in order. Part 2 can use every term Part 1 explained, and introduces every new one with the four
steps.

## Introducing a new concept

Every algorithm, data structure, protocol detail or term that is not on the "assume they know"
list gets four steps, in this order, before it is used:

1. **What it is**, in one plain sentence, without other new terms.
2. **Why it exists**: the problem it solves, in one or two sentences.
3. **A worked example with real numbers**, small enough to follow in your head.
4. **The technical version**: the precise definition, the formula, the code, the byte layout.

Example, for HMAC on the Google Authenticator page:
1. "An HMAC is a fingerprint of a message that only someone holding a secret key can produce."
2. "The server needs to check that six digits came from your phone's secret, without the secret
   ever travelling. A plain fingerprint would not do: anyone can fingerprint the number 42."
3. "With key K, the HMAC of the time-slot number 59,798,724 is 20 bytes that look random. Change
   the slot to 59,798,725 and all 20 bytes change. Without K you cannot produce either."
4. Then the RFC detail: SHA-1, 8-byte counter, dynamic truncation, with a diagram.

Further rules:

- One new idea per paragraph. If a paragraph introduces two, split it.
- No sentence uses two terms that have not been explained yet.
- Expand every abbreviation on first use and explain it (HMAC, KMS, NTP, P99).
- Bits, bytes, hex and binary are building blocks too. Before any byte-level diagram, say what a
  byte is, what hex notation is and why we are looking at bytes at all. Byte-level detail comes
  only after the plain version, and only when it teaches something.
- When a section uses a number (80% utilisation, 3 valid codes, 90 seconds), show where the number
  comes from before using it.

## Numbers without maths for the reader

A reader should never have to stop and calculate to follow a sentence.

- **State the result in plain words first, then show how it was worked out.** "The line could carry
  the whole page in under a thousandth of a second. Here is why: 1 Gbit/s is 125 MB every second, so
  100 KB takes 100 ÷ 125,000 of a second, which is 0.0008 s, or 0.8 ms."
- **Never leave a conversion to the reader.** Bits to bytes, Gbit/s to MB/s, milliseconds to
  seconds, percentages to fractions: write each step out the first time it appears on the page.
- **Every number the page derives shows its working,** one operation per step, with units on every
  number. "5 × 150 = 750 ms", not "five round trips, so 750 ms".
- **No hidden numbers.** A sentence must not depend on a number the reader would have to remember
  from elsewhere or work out ("the other 839", "a fifth of a request").
- **Formulas come after a worked example, never before.** Name every symbol in words next to the
  formula ("S, the time one request needs"). After the formula, plug in the running example's
  numbers and show the result.
- **Prefer comparisons a reader can feel** ("a thousand times smaller", "almost a full second") to
  raw figures when the point is the size, and give the exact figure after.
- **Tables of numbers get one sentence saying what to notice.** The reader should not have to compare
  rows to find the point.

## Say each thing once, without padding

- Say each thing once, in the section that owns it. Later sections build on it or link back.
- No sections whose only job is to restate: recap is bullets, not prose.
- Do not explain how products work from the user's side or what is on the "assume they know" list.
  Everything else is not obvious: explain it.
- Never pad: no filler sentences, no stories that carry no mechanism, no third example that teaches
  nothing new. Slow is not padding; vague is.

## The shape of every explanation: left, right, then centre

Before landing on the answer, walk around it:

- **Left — the world before.** What problem exists, who feels it, what it costs.
- **Right — the neighbours.** What people try first and why it breaks. Which nearby concepts it gets
  confused with, and how they differ.
- **Centre — the core.** The key idea in plain words, then real depth.
- **Forward — what's next.** What this unlocks and which topic to read after it.

Part 1 walks this shape quickly, in plain words; Part 2 walks it again in depth for each mechanism:
intuition → how it works step by step → worked example with real numbers → where it breaks → when to pick it.

## Clarity rules

- Short paragraphs of 2–4 sentences. A heading, visual or code block at least every ~400 words.
- Plain words over clever ones. Avoid idioms and slang that don't translate ("ballpark",
  "out of the park", "low-hanging fruit").
- Define every term the first time it appears: **bold** the term, then the four steps above. Link
  to its own page if one exists, but still explain it enough for this page.
- Use concrete numbers: "a bucket of 10 tokens refilling at 5 per second", not "some tokens".
- An everyday analogy whenever it makes a new idea easier to picture, and then say where it stops
  working. Examples should be familiar worldwide. Indian everyday examples (UPI payments, Tatkal
  ticket rush, festival sale traffic, toll plazas, dabbawalas) are welcome where they fit naturally.
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

- **No information older than 2020.** Every source, fact, number, incident, benchmark and
  default on a page must come from material published in 2020 or later. If the only source for a
  claim is older, find a 2020+ source that confirms it is still true, or leave the claim out. The
  one exception is a standard that is still the current normative version (for example RFC 768,
  UDP, 1980): cite it, but only for what the standard says, never for numbers or behaviour in the
  wild. Write the year next to every source in Further reading so the rule can be checked.
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

The "min read" in the page header counts about 220 words a minute plus about 20 lines of code a
minute. Length follows what a fresher needs to understand the topic, not a target:

| Page shape | Part 1 | Whole page, usual | Hard maximum | Code shown on the page |
|---|---|---|---|---|
| Single topic (`template.mdx`) | 8–15 min | 40–60 min | 75 min | at most ~150 lines |
| Comparison (`template-compare.mdx`) | 8–15 min | 35–50 min | 60 min | at most ~100 lines |
| Case study (`template-case-study.mdx`) | 8–15 min | 45–65 min | 75 min | at most ~150 lines |

- Past the hard maximum, split: a basics page (Part 1 plus the first mechanisms) and a deep-dive
  page, linked to each other. Never squeeze explanations to stay under it.
- Under the usual range is fine for a small topic, as long as the fresher read passes.
- Section word counts in the templates are guides, not ceilings for explanation.
- Everything on the page counts, including `<details>` answers and asides.
- When a page runs long, cut in this order: narrative, a fourth or fifth real-world example, extra
  gotchas, interview material that repeats the page, code that the `examples/` folder already
  holds. Never cut: Part 1, the four steps for a concept, worked examples with numbers, the core
  mechanisms, the failure cases.

## The publishing read

The last step before a page goes to `develop` or `main`, done by the author who publishes it (the
main session, not a helper agent that wrote the page):

1. Build the site and open the built page, or read the `.mdx` from the first line of frontmatter to
   the last line of Further reading. Read the title, the tagline and the description first, as a
   person landing from a search result would.
2. Read every word in order, as a normal reader with the background in "Who we write for". Do not
   skim sections because they looked fine before.
3. Stop at every sentence where that reader would have to calculate, convert, guess a term, look
   back for a number, or decode a figure. Fix it, then continue.
4. Only then publish. If the page was written by a helper agent, its report is a summary of what it
   did, never evidence that the page reads well.

## The fresher read

Before publishing, read the finished page as a final-year student who knows only what "Who we
write for" lists, top to bottom, without skipping. If you can, give this job to a fresh agent with
none of the research in its context. List in `research/<slug>.md`:

- every sentence where that reader would ask "what does this word mean?";
- every place a number or claim appears without where it comes from;
- every diagram they would not understand from its caption and the sentence before it;
- every jump where a step is missing ("so the server accepts it" — why?).

Fix every item, then read again until the list is empty. Also check: can the reader, after Part 1
alone, explain the idea in three sentences to a friend? If not, Part 1 is not done.
