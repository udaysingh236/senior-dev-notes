// Fan-out and the tail. Pages arrive ten a second. Each page calls N backends at the same time
// and is ready when the slowest call answers. A call is fast (20-50 ms) unless it is unlucky:
// with the "slow" chance it takes 500-1,500 ms, the same numbers as
// examples/percentiles-and-tail-latency/python/percentiles.py.
//
// Optional hedging: if a call has not answered after the hedge delay, a second copy goes to
// another replica and whichever answers first wins.
//
// What the reader controls: calls per page, the slow chance, the hedge delay.
// What they watch: the latest page's calls, and where calls and pages land on a time line,
// with the p50 and p99 of each.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const PAGE_EVERY_MS = 100;
const HISTORY = 3000; // values kept for the percentiles
const DOTS = 120; // recent values drawn as dots
const X0 = 78;
const X1 = 388;
const LOG_MIN = Math.log10(10);
const LOG_MAX = Math.log10(2000);

type Kind = 'fast' | 'slow' | 'rescued';

function xFor(ms: number): number {
  const v = Math.min(Math.max(Math.log10(Math.max(ms, 10)), LOG_MIN), LOG_MAX);
  return X0 + ((v - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (X1 - X0);
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(Math.ceil((p / 100) * sorted.length), 1) - 1];
}

export const createFanoutModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextPage = 0;
  let pageCount = 0;
  let calls: number[] = [];
  let pages: number[] = [];
  let sent = 0;
  let wanted = 0;
  let slowPages = 0;
  let latest: { kinds: Kind[]; ms: number } = { kinds: [], ms: 0 };
  let sortedCalls: number[] = [];
  let sortedPages: number[] = [];
  let lastEvent: string | null = null;

  function rawCall(): number {
    if (rng.next() < p.slow / 100) return 500 + 1000 * rng.next();
    return 20 + 30 * rng.next();
  }

  function oneCall(): { ms: number; kind: Kind } {
    const first = rawCall();
    wanted += 1;
    sent += 1;
    if (p.hedge > 0 && first > p.hedge) {
      sent += 1;
      const second = p.hedge + rawCall();
      if (second < first) return { ms: second, kind: 'rescued' };
    }
    return { ms: first, kind: first > 100 ? 'slow' : 'fast' };
  }

  function makePage() {
    pageCount += 1;
    const kinds: Kind[] = [];
    let slowest = 0;
    let slowIndex = -1;
    for (let i = 0; i < p.fanout; i++) {
      const c = oneCall();
      kinds.push(c.kind);
      calls.push(c.ms);
      if (c.ms > slowest) {
        slowest = c.ms;
        slowIndex = i;
      }
    }
    pages.push(slowest);
    if (slowest > 100) slowPages += 1;
    if (calls.length > HISTORY) calls = calls.slice(-HISTORY);
    if (pages.length > HISTORY) pages = pages.slice(-HISTORY);
    sortedCalls = [...calls].sort((a, b) => a - b);
    sortedPages = [...pages].sort((a, b) => a - b);
    latest = { kinds, ms: slowest };
    const why =
      slowest > 100 ? ` (call ${slowIndex + 1} was slow)` : kinds.includes('rescued') ? ' (a hedge saved it)' : '';
    lastEvent = `t=${(t / 1000).toFixed(1)}s page #${pageCount}: ${p.fanout} calls, ready in ${formatMs(slowest)}${why}`;
  }

  function drawStrip(g: SVGGElement, label: string, values: number[], sorted: number[], y: number) {
    text(label, { x: 6, y: y + 6, 'font-size': 19, fill: token('--viz-ink') }, g);
    svg('line', { x1: X0, y1: y + 16, x2: X1, y2: y + 16, 'stroke-width': 1.5, stroke: token('--viz-stroke') }, g);
    const recent = values.slice(-DOTS);
    recent.forEach((ms, i) => {
      const jitter = ((i * 7919) % 23) - 11; // fixed scatter so dots do not sit on one line
      svg(
        'circle',
        {
          cx: xFor(ms).toFixed(1),
          cy: y + jitter * 0.9,
          r: 3,
          fill: token(ms > 100 ? '--viz-warn' : '--viz-flow'),
          opacity: 0.55,
        },
        g,
      );
    });
    for (const [name, value, colour] of [
      ['p50', pct(sorted, 50), '--viz-ok'],
      ['p99', pct(sorted, 99), '--viz-bad'],
    ] as const) {
      if (sorted.length === 0) continue;
      const x = xFor(value);
      svg('line', { x1: x, y1: y - 16, x2: x, y2: y + 16, 'stroke-width': 3, stroke: token(colour) }, g);
      // p50 is labelled to the left of its line and p99 to the right, so they never overlap.
      const left = name === 'p50' || x > 368; // keep a far-right p99 label inside the drawing
      text(
        name,
        { x: left ? x - 4 : x + 4, y: y - 18, 'font-size': 19, 'font-weight': 700, 'text-anchor': left ? 'end' : 'start', fill: token('--viz-ink') },
        g,
      );
    }
  }

  return {
    params: [
      { name: 'fanout', label: 'Calls per page', min: 1, max: 100, step: 1, value: 10 },
      { name: 'slow', label: 'Chance a call is slow', min: 0, max: 5, step: 0.5, value: 1, unit: '%' },
      {
        name: 'hedge',
        label: 'Hedge a call after',
        min: 0,
        max: 200,
        step: 10,
        value: 0,
        format: (v) => (v === 0 ? 'off' : `${v} ms`),
      },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      nextPage = 0;
      pageCount = 0;
      calls = [];
      pages = [];
      sortedCalls = [];
      sortedPages = [];
      sent = 0;
      wanted = 0;
      slowPages = 0;
      latest = { kinds: [], ms: 0 };
      lastEvent = null;
    },

    step(dtMs) {
      t += dtMs;
      while (nextPage <= t) {
        makePage();
        nextPage += PAGE_EVERY_MS;
      }
    },

    render(view) {
      const axis = layer(view, 'axis');
      if (!axis.hasChildNodes()) {
        for (const [ms, label] of [
          [10, '10 ms'],
          [50, '50'],
          [100, '100'],
          [500, '500'],
          [1000, '1 s'],
          [2000, '2 s'],
        ] as const) {
          const x = xFor(ms);
          svg('line', { x1: x, y1: 150, x2: x, y2: 282, 'stroke-width': 1, 'stroke-dasharray': '3 5', stroke: token('--viz-stroke') }, axis);
          text(label, { x, y: 304, 'font-size': 18, 'text-anchor': ms === 2000 ? 'end' : 'middle', fill: token('--viz-muted') }, axis);
        }
      }

      const live = layer(view, 'live');
      clear(live);
      const head = latest.kinds.length
        ? `last page: ${latest.kinds.length} calls, ${formatMs(latest.ms)}`
        : 'pages arrive 10 a second';
      text(head, { x: 6, y: 22, 'font-size': 19, 'font-weight': 700, fill: token('--viz-ink') }, live);
      latest.kinds.forEach((kind, i) => {
        const col = i % 20;
        const row = Math.floor(i / 20);
        const tone = kind === 'slow' ? '--viz-warn' : kind === 'rescued' ? '--viz-ok' : '--viz-flow';
        svg(
          'rect',
          {
            x: 8 + col * 19.4,
            y: 36 + row * 19,
            width: 16,
            height: 16,
            rx: 3,
            'stroke-width': kind === 'fast' ? 1 : 2,
            fill: token(`${tone}-soft` as `--viz-${string}`),
            stroke: token(tone as `--viz-${string}`),
          },
          live,
        );
      });
      drawStrip(live, 'calls', calls, sortedCalls, 188);
      drawStrip(live, 'pages', pages, sortedPages, 254);
    },

    stats() {
      return {
        'call p99': formatMs(pct(sortedCalls, 99)),
        'page p50': formatMs(pct(sortedPages, 50)),
        'page p99': formatMs(pct(sortedPages, 99)),
        'pages over 100 ms': pageCount ? `${((slowPages / pageCount) * 100).toFixed(1)}%` : '0%',
        'extra calls (hedges)': wanted ? `${(((sent - wanted) / wanted) * 100).toFixed(1)}%` : '0%',
      };
    },

    log() {
      return lastEvent;
    },
  };
};
