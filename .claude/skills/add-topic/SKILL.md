---
name: add-topic
description: Research, write, illustrate and publish one topic page on the system design site — story-first deep explanation, SVG diagrams, interactive simulation, Python and JavaScript code — then build, commit and push so it goes live. Works for topics already in CURRICULUM.md and brand-new ones.
argument-hint: "[topic, or empty for the next planned one] [notes / links] [--review] [--no-push] [--update]"
disable-model-invocation: true
allowed-tools: WebSearch WebFetch Bash(npm run build) Bash(python3 *) Bash(node *) Bash(git status *) Bash(git pull *) Bash(git add *) Bash(git commit *) Bash(git push *)
---

# Add a topic: $ARGUMENTS

Before starting, read these files in this skill folder: `template.mdx`, `template-compare.mdx`,
`style-guide.md`, `visuals.md`. Also read the project's `CLAUDE.md` and `CURRICULUM.md`.

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
  - `--no-push` commit but don't push
  - `--update` rewrite or extend an existing page instead of creating one
- Expand abbreviations before searching (for example DCR = Dynamic Client Registration,
  CIMD = Client ID Metadata Documents). If an abbreviation is ambiguous, pick the meaning that fits
  the user's notes and state the assumption in the final report.

## Phase 1 — Place it

1. Search `CURRICULUM.md` and `src/content/docs/` for the topic and its synonyms.
2. If a published page already covers it and `--update` was not given: stop and tell the user
   which page covers it, and offer to extend that page.
3. If it's listed as `planned` or `pilot`: use its track, slug and order.
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
that adds up to the page's reading budget (see "Length" in `style-guide.md`). Decide:

- the opening story and the question it ends on
- the everyday analogy and where it breaks
- the list of mechanisms or variants for "How it works"
- the diagram list: one line each on what it shows
- the sim or step-through design: state, controls, and what the reader should notice
- the code plan: naive → correct → production-shaped, in Python and JavaScript
- which real systems to cover, the gotchas, the quiz questions, the next topics

If `--review` was given: show the outline and wait for the user.

## Phase 4 — Write the page

Create `src/content/docs/<track>/<slug>.mdx` from the template chosen in Phase 1.

- Follow the section order and the voice and clarity rules in `style-guide.md`.
- Stay inside the reading budget in `style-guide.md`: 35–45 minutes for a single topic, 20–30 for
  a comparison, as shown by the "min read" in the page header. When a section runs long, cut or
  move detail to the page that owns it; don't squeeze the opening story or the core idea.
- Weave in the user's notes from Phase 0.
- Remove every template comment.

## Phase 5 — Visuals

Follow `visuals.md`.

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
- [ ] Reading time in the page header is inside the budget (35–45 min single, 20–30 min comparison)
- [ ] Opens with a problem story; nothing explained before it's motivated
- [ ] Every term defined on first use; no banned words (simply, just, obviously, trivially, easy)
- [ ] Every user note from Phase 0 is covered
- [ ] Diagrams and sim meet the minimums in `visuals.md`, each with a caption
- [ ] Every code example ran; page snippets match the files in `examples/`
- [ ] Changeable facts carry "as of <Month YYYY>" with a source
- [ ] Nothing copied from sources; every source listed in Further reading
- [ ] All internal links resolve (published pages or "coming soon")
- [ ] `npm run build` passes with no errors

## Phase 9 — Publish

1. `git pull --rebase`
2. Stage only the files for this topic: the page, its components, `examples/<slug>/`,
   `research/<slug>.md`, `CURRICULUM.md`, and any pages or shared components touched in Phase 5
   and Phase 7.
3. Commit: `docs(<track>): add <Title>` (or `update <Title>` with `--update`).
4. Unless `--no-push`: `git push`. Netlify builds and deploys `main` in a minute or two.
5. If the push or build fails, report the error plainly and don't retry blindly.

## Final report to the user

Keep it short:

- the live URL of the page (site URL + `/<track>/<slug>/`)
- word count, number of diagrams, sims or step-throughs, code examples, and sources
- any assumption made (abbreviation meaning, placement, merged or split pages)
- anything that deserves a human double-check, such as fast-moving facts
