---
name: add-topic
description: Research, write, illustrate and publish one topic page on the system design site — a plain-words Part 1 for freshers, then a deep Part 2, SVG diagrams, interactive simulation, Python and JavaScript code — then build, commit and push to the develop branch. Works for topics already in CURRICULUM.md and brand-new ones.
argument-hint: "[topic, or empty for the next planned one] [notes / links] [--review] [--no-push] [--update]"
disable-model-invocation: true
allowed-tools: WebSearch WebFetch Bash(npm run build) Bash(python3 *) Bash(node *) Bash(git status *) Bash(git pull *) Bash(git add *) Bash(git commit *) Bash(git push *)
---

# Add a topic: $ARGUMENTS

Before starting, read the "Owner's standing feedback" section of `style-guide.md`; it overrides
anything below that conflicts with it. Then read these files in this skill folder: `template.mdx`, `template-compare.mdx`,
`template-case-study.mdx`, `template-build.mdx`, `style-guide.md`, `visuals.md`. Also read the project's `CLAUDE.md` and `CURRICULUM.md`.

Work through the phases in order. Don't skip a phase because the topic feels familiar.

## Phase 0 — Understand the request

- If no topic was given (empty arguments, or only flags): pick the next topic yourself. If the
  Inbox at the end of `CURRICULUM.md` has entries, show the oldest three and ask whether to take one
  of them; if the user declines or the Inbox is empty, take the first `planned` or `pilot` topic from the starter path in `CURRICULUM.md`; once those are all
  published, take the first `planned` topic in curriculum order (track by track, top to bottom).
  Tell the user which topic you picked, then carry on.
- Otherwise the topic is the first part of the arguments. Everything after it is the user's notes: what they
  learned today, links they read, the angle they care about. The finished page must clearly cover
  everything in those notes.
- Flags:
  - `--review` stop after the outline (Phase 3) and wait for approval
  - `--no-push` commit on `develop` but don't push
  - `--update` rewrite or extend an existing page instead of creating one
- Expand abbreviations before searching (for example DCR = Dynamic Client Registration,
  CIMD = Client ID Metadata Documents). If an abbreviation is ambiguous, pick the meaning that fits
  the user's notes and state the assumption in the final report.

## Phase 1 — Place it

1. Search `CURRICULUM.md` and `src/content/docs/` for the topic and its synonyms.
2. If a published page already covers it and `--update` was not given: stop and tell the user
   which page covers it, and offer to extend that page.
3. If it's listed as `planned`, `outline` or `pilot`: use its track, slug and order. An `outline`
   page already exists with `outline: true`: write the full page over it, keeping its title,
   slug, tagline (unless it fails the tagline rules), `prerequisites`, `next` and `sidebar.order`,
   and remove `outline`, `giscus: false`, `pagefind: false` and the `noindex` head entry. Its
   headings are the plan, not a contract: adapt them to the template. Change its status in
   `CURRICULUM.md` to `published (YYYY-MM-DD)`.
4. If it's new:
   - Pick the best existing track. Create a new track only if nothing fits, and add it to the
     sidebar config too.
   - Choose a short kebab-case slug.
   - If the topic is really a small part of an existing page, add a section to that page instead
     and say so. If it's huge, create an overview page plus child pages and say so.
   - Add a row to `CURRICULUM.md` with `Post #` = `new`.
5. If the topic came from the Inbox, move it out of the Inbox into its track's table.
6. Pick the page shape:
   - **Single topic** (one idea, possibly with several variants or algorithms): `template.mdx`.
   - **Comparison** (the title is "X vs Y" or "X vs Y vs Z" and the reader's real problem is telling
     the concepts apart): `template-compare.mdx`. Each concept compared should have its own row in
     `CURRICULUM.md`; add missing ones as `planned`. The comparison page links to those deep pages
     and does not repeat their mechanics.
   - Topics such as "TCP vs UDP" or "SQL vs NoSQL", where one page teaches both sides in depth and
     no separate deep pages exist, stay single-topic pages.
   - **Case study** ("How X works" for one real system, or "Design X"), where the page traces one
     system end to end and pulls many concepts together: `template-case-study.mdx`, in the
     `case-studies` track. Each deep dive links to its concept's own page; add missing concepts
     to `CURRICULUM.md` as `planned`.
   - **Build project** (a page in the `build` track that teaches one concept by building one
     small working project): `template-build.mdx`. The title is the concept's name, the tagline
     starts with "Build" and says what is built, the slug ends in `-lab`, and the concept page is
     the first prerequisite. The concept page's `next` lists the build page. The whole project
     lives in `examples/<slug>/`, runs free on a laptop, and was run end to end before publishing.
7. Decide `prerequisites` and `next` slugs (planned pages are fine).
8. Create `research/<slug>.md`.

## Phase 2 — Research

Always research, even topics you know well. Aim for 6–12 sources, in this priority:

1. Primary: RFCs, specifications, official docs, original papers.
2. Engineering blogs from teams running it at scale (Stripe, Cloudflare, AWS Builders' Library,
   Netflix, Uber, Discord, Shopify, Google SRE book, and similar).
3. Respected explainers, to learn how the topic is usually taught and where learners get confused.
   Read for understanding. Never copy.

For fast-moving topics (specs, cloud products, AI tooling), find the current version and record the
version and date.

**Sources must be from 2020 or later.** Do not use any blog post, paper, talk, incident report,
benchmark or measurement published before 2020. If a well-known fact only has an older source, find
a 2020+ source that confirms it still holds, or drop it. The only exception is a standard that is
still the current version (an RFC or spec in force): cite it for what it specifies, nothing more.
Record the publication year of every source in `research/<slug>.md`.

Write `research/<slug>.md` with:

- key facts, each with its source URL
- real numbers: defaults, limits, latencies, typical sizes
- common misconceptions and confusing points
- sourced real incidents, if any
- how 2–3 popular explainers structure the topic, and what they leave out (that's our angle)
- the full source list for Further reading

Keep quotes in notes under 15 words. Notes are for understanding, not for pasting.

## Phase 3 — Outline

Fill the chosen template's sections with bullet outlines, and give each section a word budget
(see "Length" in `style-guide.md`). Plan Part 1 first; it is the part a fresher must not miss.
Decide:

- the opening question a fresher understands, and its plain-words answer (2–4 sentences each)
- the one running example that Part 1 follows from start to finish, with its numbers
- Part 1's plain-words story as 5–10 numbered steps, and the "If you stop here" bullets
- the building blocks: every concept the page uses that is not on the style guide's "assume they
  know" list, in the order they are first needed, each with its four steps (one plain sentence,
  why it exists, a worked example with numbers, the technical version)
- the sharp question that opens Part 2
- the everyday analogy and where it breaks
- the list of mechanisms or variants for "How it works"
- the diagram list: one line each on what it shows, starting with the Part 1 mental-model diagram
- the sim or step-through design: state, controls, and what the reader should notice
- the code plan: naive → correct → production-shaped, in Python and JavaScript
- which real systems to cover, the gotchas, the quiz questions, the next topics

If `--review` was given: show the outline and wait for the user.

## Phase 4 — Write the page

Create `src/content/docs/<track>/<slug>.mdx` from the template chosen in Phase 1.

- Follow the section order and the voice and clarity rules in `style-guide.md`.
- Write Part 1 first and read it on its own: a fresher must be able to explain the idea after it.
- Introduce every new concept with the four steps before using it (style guide, "Introducing a
  new concept"). One new idea per paragraph; no sentence with two unexplained terms.
- Length follows understanding (style guide, "Length"): usually 40–60 minutes, 75 at most, as
  shown by the "min read" in the page header. Never pad, and never cut an explanation to save
  minutes. Past the maximum, split into a basics page and a deep-dive page and say so.
- Say each thing once (style guide, "Say each thing once, without padding").
- Weave in the user's notes from Phase 0.
- Remove every template comment.

## Phase 5 — Visuals

Follow `visuals.md`.

- The first diagram is the Part 1 mental model: the simplest picture of the idea, no internals.
  Architecture, byte layouts and data structures come in Part 2.
- Diagrams in `src/components/diagrams/<slug>/`, sims in `src/components/sims/<slug>/`.
- Reuse `SimShell`, `StepThrough` and `Figure`. If a shared component needs a new capability,
  extend it carefully without breaking other pages.
- Check every visual at 360px and 1280px, light and dark, reduced motion.

## Phase 6 — Code

- Write runnable files in `examples/<slug>/python/` and `examples/<slug>/js/`, plus a short
  `examples/<slug>/README.md` with run commands. Standard library first. If a dependency is
  needed, add `requirements.txt` or `package.json` in that folder and ask before installing.
- Run every file. Fix until it runs cleanly and the output matches what the page claims.
- Put the essential part on the page in synced tabs, with a link to the full example in the repo.

## Phase 7 — Connect

- Set `prerequisites` and `next` in the frontmatter, and fill `<NextTopics>`.
- Add a link to this page from the "Where to go next" section of 1–3 related published pages.
- In `CURRICULUM.md`, set the status to `published (YYYY-MM-DD)`.

## Phase 8 — Quality gate

Fix anything that fails. Don't publish with known failures.

- [ ] All sections of the chosen template present, in order, with no leftover template comments
- [ ] Part 1 explains the whole idea in plain words with one running example, before any architecture, byte layout or production detail, and ends with "If you stop here"
- [ ] Opens with a question a fresher understands, answered in plain words on the first screen; Part 2 opens with the sharp question; no narrative; nothing is said twice
- [ ] No maths left to the reader: every derived number shows its working in words, every conversion is written out, formulas come after a worked example (style guide, "Numbers without maths for the reader")
- [ ] Every school-maths idea the page uses (vector, dot product, matrix, probability, power, logarithm, slope, bits) gets a short refresher with tiny numbers before its first use (style guide, "Maths refreshers")
- [ ] Tagline and description are one plain sentence a fresher understands: no riddles, no hidden numbers, no arithmetic (style guide, "The title line, tagline and description"); a human-style read of the first screen done before publishing
- [ ] Every new concept gets the four steps before it is used: plain sentence, why, worked example with numbers, technical version (style guide, "Introducing a new concept")
- [ ] One new idea per paragraph; no sentence uses two unexplained terms; every number shows where it comes from
- [ ] The fresher read is done and its list in `research/<slug>.md` is empty (style guide, "The fresher read")
- [ ] Reading time fits the topic (usually 40–60 min, 75 at most), with no padding and no squeezed explanations
- [ ] Every term defined on first use; no banned words (simply, just, obviously, trivially, easy)
- [ ] Every user note from Phase 0 is covered
- [ ] Diagrams and sim meet the minimums in `visuals.md`, each with a caption
- [ ] Every code example ran; page snippets match the files in `examples/`
- [ ] Changeable facts carry "as of <Month YYYY>" with a source
- [ ] Every source is from 2020 or later (except standards still in force), with its year shown in Further reading
- [ ] Nothing copied from sources; every source listed in Further reading
- [ ] All internal links resolve (published pages or "coming soon")
- [ ] `npm run build` passes with no errors

## Phase 9 — Publish

0. **The publishing read** (style guide, "The publishing read"): read the whole built page yourself,
   top to bottom, as a normal reader, and fix every place they would stop. This is done by the
   session that publishes, even if helper agents wrote the page. Do not publish on an agent's report.
1. `git checkout develop && git pull --rebase origin develop`
2. Stage only the files for this topic: the page, its components, `examples/<slug>/`,
   `research/<slug>.md`, `CURRICULUM.md`, and any pages or shared components touched in Phase 5
   and Phase 7.
3. Commit: `docs(<track>): add <Title>` (or `update <Title>` with `--update`).
4. Unless `--no-push`: `git push origin develop`. Never push to `main`: every push there is a
   Netlify deploy. Uday merges `develop` into `main` once a week (see CLAUDE.md, "Git").
5. If the push or build fails, report the error plainly and don't retry blindly.

## Final report to the user

Keep it short:

- the URL the page will have once `develop` is merged (site URL + `/<track>/<slug>/`)
- word count, number of diagrams, sims or step-throughs, code examples, and sources
- any assumption made (abbreviation meaning, placement, merged or split pages)
- anything that deserves a human double-check, such as fast-moving facts
