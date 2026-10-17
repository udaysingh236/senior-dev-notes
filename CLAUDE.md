# Senior Dev Notes — system design, explained like a mentor

A static learning site that teaches system design and production engineering to beginners:
final-year students, new grads and engineers in their first job. Every topic is explained the way an
engineer with 25+ years of experience would mentor a junior: start from the real problem, walk
around it, then go deep, then point to what to learn next.

Owner: Uday. Repo: `udaysingh236/senior-dev-notes`. Live site: `https://senior-dev-notes.netlify.app`.

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
src/components/                       Figure, StepThrough, TopicHeader and other shared components
src/styles/custom.css                 theme tokens, including --viz-* diagram colours
examples/<slug>/python|js/            runnable code behind every snippet on the page
research/<slug>.md                    research notes and sources (not published)
CURRICULUM.md                         master topic list: track, order, slug, status
.claude/skills/add-topic/             the workflow, page template, style guide and visuals guide
```

## Commands

- `npm run dev` — local preview at http://localhost:4321
- `npm run build` — must pass before every commit
- `npm run preview` — serve the built site

## Rules

1. Write or extend topics with `/add-topic`. Every page follows `.claude/skills/add-topic/template.mdx`.
2. Voice, clarity, code and accuracy rules: `.claude/skills/add-topic/style-guide.md`.
3. Diagrams and simulations: `.claude/skills/add-topic/visuals.md`.
4. Research widely, then write in our own words. Never copy text, diagrams or code from sources.
   Credit every source in the page's Further reading.
5. Every code snippet on a page has a runnable twin in `examples/<slug>/` that was actually run.
6. Visuals work in light and dark mode, at 360px and 1280px wide, and with reduced motion.
7. Keep `CURRICULUM.md` in sync with what exists on disk.
8. One topic per session works best. Run `/clear` before starting the next topic.
