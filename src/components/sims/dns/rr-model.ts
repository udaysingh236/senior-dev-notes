// DNS round robin across four servers, seen from the servers.
//
// The authoritative server hands out the four addresses in a fresh random order on every query
// (what BIND's random ordering or Route 53's multivalue answers amount to). Each resolver caches the order it got for one TTL, so every user behind that resolver sees the same
// order until it expires. Resolver sizes follow a Zipf curve (the k-th largest serves 1/k as many
// users as the largest), the way a few big ISPs and public resolvers carry most users.
//
// A share of clients connects to the first address in the list (after the OS has sorted it, which
// glibc does by RFC 6724 rules); the rest pick one at random. Load is computed exactly from those
// shares, so the picture shows the mechanism without request noise.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const SERVERS = 4;
const TOTAL = 4000; // req/s across all users (illustrative)
const FAIR = TOTAL / SERVERS;
const SPEED = 60; // simulated seconds per real second
const END = 2 * 3600;
const HOT = 1.5; // a server above 1.5× its fair share counts as a hot spot
const NAMES = ['A', 'B', 'C', 'D'];

interface Resolver {
  weight: number; // share of all users
  first: number; // index of the first address in its cached answer
  expires: number;
}

export interface RrResult {
  peakRatio: number; // worst instantaneous busiest/fair seen
  avgRatioNow: number; // ratio of the busiest server's average load over the run to fair share
  longestHot: number; // seconds, longest stretch one server spent above HOT × fair
  hotShare: number; // % of time some server was above HOT × fair
  biggestShare: number; // share of users behind the largest resolver
}

export const createRrModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let resolvers: Resolver[] = [];
  let load: number[] = [];
  let sums: number[] = [];
  let peakRatio = 1;
  let hotSince: (number | null)[] = [];
  let longestHot = 0; // longest stretch one server spent above HOT × fair
  let hotTime = 0; // time during which some server was above HOT × fair
  let history: number[] = []; // busiest/fair, one sample per 30 s
  let lastEvent: string | null = null;
  let done = false;

  function computeLoad(): void {
    const pFirst = p.first / 100;
    load = Array(SERVERS).fill(0);
    for (const r of resolvers) {
      for (let s = 0; s < SERVERS; s++) load[s] += TOTAL * r.weight * ((1 - pFirst) / SERVERS);
      load[r.first] += TOTAL * r.weight * pFirst;
    }
  }

  function refresh(now: number): void {
    for (const r of resolvers) {
      while (r.expires <= now) {
        r.first = rng.int(0, SERVERS - 1); // a fresh order on every query to the authoritative server
        r.expires += p.ttl;
      }
    }
  }

  const model = {
    params: [
      { name: 'resolvers', label: 'Resolvers your users sit behind', min: 2, max: 200, step: 1, value: 10 },
      { name: 'first', label: 'Clients that take the first address', min: 0, max: 100, step: 10, value: 100, unit: '%' },
      { name: 'ttl', label: 'TTL', min: 30, max: 1800, step: 30, value: 300, unit: 's' },
    ],

    reset(params: Record<string, number>, r: Rng) {
      p = params;
      rng = r;
      t = 0;
      const raw = Array.from({ length: p.resolvers }, (_, k) => 1 / (k + 1));
      const sum = raw.reduce((a, b) => a + b, 0);
      // Each resolver last fetched at a random moment, so their expiries are spread over one TTL.
      resolvers = raw.map((w) => ({ weight: w / sum, first: rng.int(0, SERVERS - 1), expires: rng.range(0, p.ttl) }));
      computeLoad();
      sums = Array(SERVERS).fill(0);
      peakRatio = Math.max(...load) / FAIR;
      hotSince = Array(SERVERS).fill(null);
      longestHot = 0;
      hotTime = 0;
      history = [];
      done = false;
      lastEvent = `The largest resolver carries ${Math.round(resolvers[0].weight * 100)}% of users; fair share is ${FAIR} req/s per server.`;
    },

    step(dtMs: number) {
      if (done) return;
      const dt = (dtMs / 1000) * SPEED;
      const target = Math.min(t + dt, END);
      // Walk in 1 s slices so expiries inside a tick land at the right time.
      while (t < target) {
        const next = Math.min(target, t + 1);
        refresh(next);
        computeLoad();
        for (let s = 0; s < SERVERS; s++) sums[s] += load[s] * (next - t);
        const ratio = Math.max(...load) / FAIR;
        peakRatio = Math.max(peakRatio, ratio);
        if (ratio > HOT) hotTime += next - t;
        for (let s = 0; s < SERVERS; s++) {
          if (load[s] > FAIR * HOT) {
            if (hotSince[s] === null) hotSince[s] = t;
            longestHot = Math.max(longestHot, next - hotSince[s]!);
          } else hotSince[s] = null;
        }
        if (Math.floor(next / 30) > Math.floor(t / 30)) history.push(ratio);
        t = next;
      }
      if (t >= END) {
        done = true;
        lastEvent = 'Two simulated hours done. Change a slider or press Reset.';
      }
    },

    render(view: SVGSVGElement) {
      const base = layer(view, 'base');
      const top = 34;
      const h = 130;
      const scale = (v: number) => (Math.min(v, FAIR * 3) / (FAIR * 3)) * h;
      if (!base.childElementCount) {
        text('Load on each server, req/s', { x: 4, y: 18, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base);
        const fy = top + h - scale(FAIR);
        svg('line', { x1: 4, y1: fy, x2: 300, y2: fy, stroke: token('--viz-muted'), 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, base);
        text('fair share', { x: 306, y: fy + 5, 'font-size': 15, fill: token('--viz-muted') }, base);
        text('busiest server ÷ fair share, over time', { x: 4, y: 222, 'font-size': 15, fill: token('--viz-muted') }, base);
        svg('line', { x1: 4, y1: 316, x2: 396, y2: 316, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      load.forEach((v, s) => {
        const x = 4 + s * 74;
        const bh = scale(v);
        const tone = v > FAIR * HOT ? '--viz-bad' : v > FAIR * 1.15 ? '--viz-warn' : '--viz-ok';
        svg('rect', { x, y: top, width: 60, height: h, rx: 4, fill: 'none', stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, live);
        if (bh > 0.5) svg('rect', { x, y: top + h - bh, width: 60, height: bh, rx: 4, fill: token(`${tone}-soft` as `--viz-${string}`), stroke: token(tone as `--viz-${string}`), 'stroke-width': 1.5 }, live);
        text(`${NAMES[s]} ${Math.round(v)}`, { x: x + 30, y: top + h + 22, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle', fill: token('--viz-ink'), style: 'font-family: var(--sl-font-mono)' }, live);
      });
      const minutes = Math.floor(t / 60);
      text(`${minutes} min`, { x: 396, y: 18, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'end', fill: token('--viz-ink'), style: 'font-family: var(--sl-font-mono)' }, live);

      // Ratio history: y from 1× (bottom) to 3× (top), x over two hours.
      const cy = 234;
      const ch = 82;
      const yOf = (r: number) => cy + ch - ((Math.min(r, 3) - 1) / 2) * ch;
      svg('line', { x1: 4, y1: yOf(HOT), x2: 396, y2: yOf(HOT), stroke: token('--viz-bad'), 'stroke-width': 1, 'stroke-dasharray': '3 4' }, live);
      text('1.5×', { x: 396, y: yOf(HOT) - 4, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-bad') }, live);
      const pts = history.map((r, i) => `${(4 + ((i * 30) / END) * 392).toFixed(1)},${yOf(r).toFixed(1)}`);
      if (pts.length > 1) svg('polyline', { points: pts.join(' '), fill: 'none', stroke: token('--viz-flow'), 'stroke-width': 2 }, live);
    },

    stats() {
      const ratio = Math.max(...load) / FAIR;
      const avgMax = t > 0 ? Math.max(...sums) / t / FAIR : ratio;
      return {
        'busiest now': `${ratio.toFixed(2)}× fair share`,
        'worst moment so far': `${peakRatio.toFixed(2)}×`,
        'time with a server above 1.5×': t > 0 ? `${Math.round((hotTime / t) * 100)}%` : '0%',
        'longest one server stayed above 1.5×': longestHot ? `${Math.max(1, Math.round(longestHot / 60))} min` : 'never',
        'busiest, averaged over the run': `${avgMax.toFixed(2)}×`,
      };
    },

    log: () => lastEvent,

    /** For headless tests: run to the end and report. */
    result(): RrResult {
      while (!done) model.step(20);
      return {
        peakRatio: Number(peakRatio.toFixed(2)),
        avgRatioNow: Number((Math.max(...sums) / t / FAIR).toFixed(2)),
        longestHot: Math.round(longestHot),
        hotShare: Math.round((hotTime / t) * 100),
        biggestShare: Math.round(resolvers[0].weight * 100),
      };
    },
  };
  return model;
};
