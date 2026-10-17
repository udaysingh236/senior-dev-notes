# System design site — Claude Code starter kit

Everything Claude Code needs to build and grow a system design learning site, one deep topic at a
time, and publish each topic to Netlify with a single command.

## What's inside

| File | What it does |
|---|---|
| `CLAUDE.md` | Project memory. Claude Code reads it at the start of every session. |
| `CURRICULUM.md` | 135 topics in 14 tracks, covering all 111 items from the original list plus missing fundamentals. |
| `KICKOFF.md` | The one-time prompt that scaffolds the site and sets up deployment. |
| `.claude/skills/add-topic/SKILL.md` | The `/add-topic` command: research → outline → write → diagrams and sims → code → build → push. |
| `.claude/skills/add-topic/template.mdx` | The 15-section page structure every topic follows. |
| `.claude/skills/add-topic/style-guide.md` | The voice ("25-year engineer mentoring a junior"), clarity, code and accuracy rules. |
| `.claude/skills/add-topic/visuals.md` | Rules for SVG diagrams, interactive simulations and step-throughs. |
| `netlify.toml` | Netlify build settings: build command, publish folder, Node version. |
| `.claude/settings.json` | Lets Claude Code build, run examples, commit and push without asking each time. Blocks force-push and `rm -rf`. |

## Setup (once)

1. Create an empty GitHub repo (public or private, both work with Netlify), then clone it.
2. Copy everything from this kit into the repo root, including the hidden `.claude` folder.
3. Open the folder in VS Code with the Claude Code extension. Run `/model` and pick Opus.
4. Paste the prompt from `KICKOFF.md`. It scaffolds the site, pushes it, and walks you through
   connecting the repo on Netlify (Add new site → Import from GitHub).
5. When you buy your domain, ask Claude Code to connect it. It will walk you through Netlify's
   Domain management and the DNS records at your registrar.

From then on, every push to `main` goes live automatically, and every other branch gets its own
preview URL.

## Daily use

Each topic is one `/add-topic` run. Nothing generates on its own in the background, so you stay in
control of quality and usage.

Write the next planned topic (Claude picks it from `CURRICULUM.md`):

```
/add-topic
```

Write a specific planned topic:

```
/add-topic rate-limiting
```

Add something you learned today, with your notes:

```
/add-topic DCR and CIMD in MCP — learned today: MCP auth uses OAuth 2.1; clients can register
dynamically (DCR) or identify themselves with a URL to a metadata document (CIMD). Link: <url>
```

Useful flags:

- `--review` — show the outline first and wait for your approval
- `--no-push` — commit locally without publishing
- `--update` — rewrite or extend an existing page

## Tips

- One topic per session gives the best depth. Run `/clear` before the next one.
- Review the first few pages closely. Each correction you fold back into `style-guide.md` or
  `visuals.md` improves every topic after it.
- Pages are long and research-heavy, so each one uses a fair amount of your Claude usage.
