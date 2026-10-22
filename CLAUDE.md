# Senior Dev Notes — system design, explained like a mentor

A static learning site that teaches system design and production engineering to beginners:
final-year students, new grads and engineers in their first job. Every topic is explained the way an
engineer with 25+ years of experience would mentor a junior: start from the real problem, walk
around it, then go deep, then point to what to learn next.

Owner: Uday. Repo: `udaysingh236/senior-dev-notes`. Live site: `https://seniordevnotes.netlify.app`.

## Stack

- Astro + Starlight, pages in MDX. Node version pinned in `netlify.toml`.
- Diagrams: hand-authored SVG in Astro components. Interactive simulations: vanilla TypeScript on a
  shared `SimShell` component. No UI framework unless already added to the project.
- Hosting: Netlify, connected to the GitHub repo. Build settings live in `netlify.toml`
  (`npm run build`, publish `dist`). A push to `main` deploys the site; other branches get
  deploy previews. The site is served from the domain root (a custom domain once bought), so there
  is no `base` path.

## Repo map

```
src/content/docs/<track>/<slug>.mdx   topic pages (track folders match CURRICULUM.md)
src/components/diagrams/<slug>/       SVG diagram components for one topic
src/components/sims/<slug>/           simulation components for one topic
src/components/sim/                   SimShell and shared simulation helpers
src/components/                       Figure, StepThrough, TopicHeader, Footer and other shared components
src/components/landing/               landing page hero, animated drawings and 404 graphic
src/styles/custom.css                 the notebook theme: colours, fonts, --viz-* diagram tokens
examples/<slug>/python|js/            runnable code behind every snippet on the page
research/<slug>.md                    research notes and sources (not published)
CURRICULUM.md                         master topic list: track, order, slug, status, plus the Inbox of saved ideas
.claude/skills/add-topic/             the workflow, page templates (single topic, comparison, case study), style guide, visuals guide
.claude/skills/save-topic/            quick capture of topic ideas into the CURRICULUM.md Inbox
```

## Commands

- `npm run dev` — local preview at http://localhost:4321
- `npm run build` — must pass before every commit
- `npm run preview` — serve the built site

## Rules

1. Write or extend topics with `/add-topic`. Every page follows `.claude/skills/add-topic/template.mdx`,
   `template-compare.mdx` for "X vs Y vs Z" pages, or `template-case-study.mdx` for "How X works"
   walkthroughs of one real system. Save ideas for later with `/save-topic`.
2. Reading budget: usually 30–45 minutes, 50 at most, set by the topic and never padded (style guide,
   "Length"). Pages open with a sharp technical question, not a story, and never repeat themselves.
3. Voice, clarity, code and accuracy rules: `.claude/skills/add-topic/style-guide.md`. Read its
   "Owner's standing feedback" section before writing or rewriting any page: technical core over
   narrative, no explaining the obvious, no fact-check sections, a hook question, no repetition,
   and sims that show mechanisms, not steps.
4. Diagrams and simulations: `.claude/skills/add-topic/visuals.md`.
5. Research widely, then write in our own words. Never copy text, diagrams or code from sources.
   Credit every source in the page's Further reading. No information older than 2020: every
   source, fact and number must be from 2020 or later, except standards still in force (style
   guide, "Accuracy").
6. Every code snippet on a page has a runnable twin in `examples/<slug>/` that was actually run.
7. Visuals work in light and dark mode, at 360px and 1280px wide, and with reduced motion.
8. Keep `CURRICULUM.md` in sync with what exists on disk.
9. One topic per session works best. Run `/clear` before starting the next topic.

## Git

- All work goes on the `develop` branch: commit there and push `develop`, so nothing is lost if a
  cloud container is reclaimed.
- Never push to `main` and never open a PR into it. Every push to `main` is a Netlify deploy, and
  the monthly build quota is limited. Uday merges `develop` into `main` once a week.
- Run `npm run build` before every commit, since Netlify no longer catches failures per commit.
