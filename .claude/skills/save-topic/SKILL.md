---
name: save-topic
description: Save one or more topic ideas to the Inbox in CURRICULUM.md for a future /add-topic run. Checks for duplicates, suggests a track and slug, and records the user's note. Does not research or write pages.
argument-hint: "<topic name>[; another topic] [-- note on the angle you care about]"
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git checkout *) Bash(git pull *) Bash(git add *) Bash(git commit *) Bash(git push *)
---

# Save a topic idea: $ARGUMENTS

This is a quick capture, not research. Read `CURRICULUM.md` and nothing else. Finish in one short reply.

## Steps

1. Split the arguments into topics on `;` or new lines. Anything after `--` is the user's note for
   the topic before it. Expand abbreviations only when the meaning is clear (say the assumption).
2. For each topic, search `CURRICULUM.md` (every track table and the Inbox) for the name, its
   synonyms and its parts:
   - **Already published or planned:** don't add it. Tell the user which row covers it. If the
     user's note adds an angle, append the note to that Inbox entry or mention it for `/add-topic`.
   - **A comparison of existing rows** ("X vs Y vs Z" where X, Y and Z are rows): add it to the
     Inbox and say it will use the comparison template.
   - **A walkthrough of one real system** ("How X works", "Design X"): add it to the Inbox in the
     `case-studies` track and say it will use the case-study template.
   - **New:** add it to the Inbox.
3. For each new Inbox entry, suggest a track (a folder from `CURRICULUM.md`) and a kebab-case slug.
   Don't create a new track; if nothing fits, write `track?`.
4. Append to the `## Inbox` section at the end of `CURRICULUM.md`, oldest first, one bullet each:

   ```
   - 2026-10-21 · Reverse proxy vs load balancer vs API gateway · `traffic/proxy-lb-gateway` · compare — note: why people mix them up in interviews
   ```

   Fields: date added · title · `track/slug` · `compare` or `case-study` only for those page shapes · `note:` only
   when the user gave one. Keep bullets, not a table: track tables are parsed by the site build.
5. On `develop` (`git checkout develop && git pull --rebase origin develop`), commit only
   `CURRICULUM.md`: `docs(curriculum): save <title> to inbox` (or `save N topics`). Push with
   `git push origin develop`. Never push to `main` (see CLAUDE.md, "Git").

## Reply

One line per topic: added (with track/slug), or already covered (with the row). Nothing else.
