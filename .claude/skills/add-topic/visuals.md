# Visuals guide

Every page should let the reader see the idea, and where it moves, watch it move.

- **Diagrams** show structure: who talks to whom, where data lives.
- **Simulations** show behaviour over time: tokens draining, queues filling, replicas lagging.
- **Step-throughs** show sequences: handshakes, auth flows, two-phase commit, saga compensation.

## Minimum per topic

- One overview (hero) diagram at "The core idea".
- One diagram per major mechanism or variant.
- At least one interactive simulation, or a step-through when the concept is a sequence rather than
  something that changes over time.
- Algorithm topics: one sim mode per algorithm, plus a compare mode that runs them side by side on
  the same input when that teaches something.
- Protocol and flow topics (TLS, OAuth, DCR, 2PC): a step-through sequence diagram.
- Comparison pages (`template-compare.mdx`): one overlap (hero) diagram, one small diagram per
  concept drawn in the same layout so they can be compared at a glance, and a decision-flow
  diagram or list. A sim is optional: add one only when the concepts differ in behaviour over time.
- Case studies (`template-case-study.mdx`): one architecture (hero) diagram of at most ~8 boxes, a
  step-through of one request end to end, one diagram per deep dive, and a sim of the peak moment
  (with and without the key mechanism) when the system's hard part is load.

## Diagram rules (SVG)

- Hand-authored SVG inside Astro components: `src/components/diagrams/<slug>/<Name>.astro`.
- Colours come only from theme tokens in `src/styles/custom.css`, defined for both light and dark:
  `--viz-ink`, `--viz-muted`, `--viz-surface`, `--viz-stroke`, `--viz-client`, `--viz-server`,
  `--viz-store`, `--viz-flow`, `--viz-ok`, `--viz-warn`, `--viz-bad`. Never hard-code a colour.
  Every colour token also has a `-soft` variant for fills (for example `--viz-client-soft`).
  Apply tokens with `style="fill: var(--viz-ok)"` or CSS, so they follow the light/dark switch.
- Meaning of colour is the same on every page: blue = requests or data in flight,
  green = accepted or healthy, amber = waiting or degraded, red = rejected or failed.
  Never rely on colour alone: pair it with a label, icon or shape.
- Responsive: `viewBox` only, `width="100%"`, no fixed pixel sizes.
- Readable at 360px wide: text at least ~14px at that width, about 8 boxes at most.
  If it doesn't fit, split it into two diagrams rather than shrinking it.
  In practice: draw on a 400-unit-wide `viewBox` with `font-size` 19 or more. `<Figure>` caps
  diagrams at about 34rem on desktop; pass `wide` for diagrams drawn 640 units or wider (those
  rely on tap-to-enlarge on phones).
- Accessible: `role="img"`, a `<title>` and a `<desc>`. The `<Figure>` caption states the key point
  in words.
- Look: rounded rectangles, 1.5–2px strokes, generous whitespace, arrowheads via `<marker>`, labels
  on arrows when the arrow carries meaning. Flat style, no gradients or heavy shadows.
  Consistent shapes: clients are rounded rectangles, stores are cylinders, queues are segmented bars.

## Simulation rules

Every sim is built on the shared `SimShell` (`src/components/sim/`). A topic's sim lives in
`src/components/sims/<slug>/` and implements this contract:

```ts
export interface ParamSpec {
  name: string; label: string; min: number; max: number; step: number; value: number; unit?: string;
}

export interface SimModel {
  params: ParamSpec[];                                  // rendered as sliders by the shell
  reset(params: Record<string, number>, rng: Rng): void; // rebuild state from scratch
  step(dtMs: number): void;                             // advance simulated time
  render(view: SVGSVGElement): void;                    // draw the current state
  stats(): Record<string, string | number>;             // live counters under the sim
  log?(): string | null;                                // latest event, e.g. "t=1.2s #14 rejected: bucket empty"
  actions?: { label: string; run(): void }[];           // e.g. "Send a burst of 20"
}
```

The shell provides: Play/Pause, Step, Reset, Speed (0.25×–4×), parameter sliders, a stats panel,
an event log line, and a "What to watch for" caption slot that the page fills in.

- Deterministic: seeded RNG, so Reset replays exactly the same run.
- `prefers-reduced-motion`: start paused, never auto-play.
- Pause automatically when scrolled out of view (IntersectionObserver).
- `requestAnimationFrame`, at most ~200 animated elements, smooth on a mid-range Android phone.
- Keyboard: every control focusable, Space toggles play/pause when the sim has focus.
- No network calls. No new libraries without asking the user first.
- Every sim has a "What to watch for" caption telling the reader the one or two things to notice.

How a topic sim is wired (the reference example is `src/components/sim/example/`, shown on the
dev-only page `/dev/components/` in `npm run dev`):

- `src/components/sims/<slug>/model.ts` exports a `SimFactory` (`(config) => SimModel`). Types
  are in `src/components/sim/types.ts`; drawing helpers (`svg`, `text`, `layer`, `clear`,
  `token`, `stamp`, `percent`) are in `src/components/sim/svg.ts`.
- `src/components/sims/<slug>/<Name>Sim.astro` renders
  `<SimShell name title description watchFor viewBox? config? />` and then, in a `<script>`,
  calls `mountAll('<name>', factory)` from `src/components/sim/shell.ts`.
- The shell steps the model in fixed 20 ms ticks (`tickMs`) so runs are identical at any frame
  rate; Step advances 100 ms (`stepMs`). Sliders call `reset()` with the new values.
- The default canvas is `0 0 400 240`. Use font-size 19+ in it, and draw static parts once into
  a `layer()` so each frame only redraws what moves.

### Ambition example: rate limiting

One sim with a shared traffic generator (steady, bursty, random spike, and a "send burst" button)
feeding a selectable algorithm:

- token bucket — tokens as dots refilling into a bucket; requests take a token or bounce red
- leaky bucket — a queue draining at a fixed rate; overflow bounces
- fixed window — a counter that resets at each boundary; show the 2× burst at the boundary
- sliding window log — timestamps sliding out of the window
- sliding window counter — the weighted blend of the previous and current window

Sliders: capacity, refill rate, window size. A compare mode runs all five on the same traffic with
an accepted/rejected timeline under each. The reader should see with their own eyes why a fixed
window can let through twice the limit at a boundary.

## Step-through rules

`<StepThrough steps={[...]} />` renders an SVG sequence diagram with Back/Next and numbered steps.
Each step highlights the actors and arrows involved and shows at most three sentences of
explanation. The last step summarises the whole flow.

```mdx
<StepThrough
  title="A cache-aside read"
  actors={[{ id: 'app', label: 'App', kind: 'client' }, { id: 'db', label: 'Database', kind: 'store' }]}
  steps={[
    { from: 'app', to: 'db', label: 'SELECT', text: 'Up to three sentences.' },
    { from: 'db', to: 'app', label: 'row', text: '…', tone: 'ok', dashed: true },
  ]}
  summary="What the whole flow achieved, in up to three sentences."
/>
```

- `kind`: `client` (rounded box), `server` (box, default), `store` (cylinder), `queue`.
- `tone`: `flow` (default), `ok`, `warn`, `bad`. `dashed: true` for responses.
  `from === to` draws a note on that actor for local work.
- Up to 3 actors fit a phone without scrolling; 4–6 scroll sideways. Keep labels to about
  14 characters. An unknown actor id fails the build.

## Optional: promo clips (only when the user asks)

A `scripts/record-sim.mjs` that uses Playwright to record a sim at 1080×1080 and ffmpeg to turn it
into MP4 or GIF for social posts. Ask before installing Playwright or ffmpeg.

## How visuals sit on the page

The site's look is an engineer's notebook (see `src/styles/custom.css`). Shared frames already
apply it, so topic visuals need no extra styling:

- `<Figure>`, `SimShell` and `StepThrough` draw a paper card with a faint blueprint grid behind
  the drawing. Keep diagram backgrounds transparent so the grid shows through.
- Figure captions are numbered automatically ("Fig. 3"). Never number them by hand.
- Figures, sims, step-throughs, asides and code blocks fade in as the reader scrolls to them.
  Do not add entrance animations of your own.
- `--note-*` tokens (highlighter, margin red, grid) are decoration for the site chrome only.
  Diagrams use `--viz-*` tokens, whose colours carry meaning.
- Headings use Fraunces, body text IBM Plex Sans, code IBM Plex Mono. In SVG, use
  `var(--note-font-display)` with `font-style: italic` for handwritten-style margin notes and
  `var(--sl-font-mono)` for code or numbers.
- Wrap a phrase in `<mark>` for a highlighter stroke in prose. Use it rarely: once or twice a page.

## Verify every visual

Run `npm run dev` and check each page at 360px and 1280px, in light and dark mode, and with reduced
motion turned on. If a browser tool is available, take screenshots and look at them before
publishing.
