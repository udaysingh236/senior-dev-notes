// A page service with a fixed pool of workers. Every page takes a worker, does 10 ms of its own
// work and calls a Reviews service. A healthy call answers in about 40 ms; when Reviews is down,
// calls hang until the 300 ms timeout. A circuit breaker in front of the call watches the last N
// calls, opens when too many failed, refuses calls at once while open (the page is served
// without reviews), and after the open time lets one trial call through (half-open).
//
// By default a script runs: Reviews is healthy, then every call hangs from 3 s to 20 s, then it
// recovers. Buttons replace the script with a fixed state of Reviews.
//
// What the reader controls: the breaker on or off, its threshold, its window, its open time and
// the traffic. What they watch: workers stuck on Reviews, what Reviews receives, and the pages.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const WORKERS = 20;
const OWN_MS = 10; // the page's own work
const TIMEOUT_MS = 300;
const MEDIAN_MS = 38;
const SIGMA = 0.35; // healthy calls: median 38 ms, average about 40 ms
const QUEUE_MAX = 40;
const OUTCOME_WINDOW_MS = 2000;
const SCRIPT_DOWN = 3000;
const SCRIPT_UP = 20000;
const TICK = 1;

type Mode = 'healthy' | 'down' | 'quarter';
type State = 'closed' | 'open' | 'half-open';
type Outcome = 'reviews' | 'without' | 'rejected';

interface Job {
  ends: number;
  called: boolean; // false when the breaker refused the call
  hangs: boolean;
  trial: boolean;
}

function normal(rng: Rng): number {
  const u = Math.max(rng.next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

export const createBreakerModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let queue = 0;
  let workers: (Job | null)[] = [];
  let outcomes: { at: number; kind: Outcome }[] = [];
  let callsToReviews: number[] = []; // start times of calls in the last second
  let scripted = true;
  let manualMode: Mode = 'healthy';
  // Breaker state
  let state: State = 'closed';
  let recent: boolean[] = []; // true = failed, oldest first
  let openedAt = 0;
  let trialInFlight = false;
  let lastEvent: string | null = null;

  const on = () => p.breaker === 1;
  const mode = (): Mode => (scripted ? (t >= SCRIPT_DOWN && t < SCRIPT_UP ? 'down' : 'healthy') : manualMode);
  const note = (msg: string) => (lastEvent = `t=${(t / 1000).toFixed(2)}s ${msg}`);

  function move(next: State, why: string): void {
    state = next;
    note(`breaker ${next}: ${why}`);
  }

  function allow(): { ok: boolean; trial: boolean } {
    if (!on()) return { ok: true, trial: false };
    if (state === 'open' && t - openedAt >= p.openS * 1000) move('half-open', 'the open time is up, one trial call may go');
    if (state === 'closed') return { ok: true, trial: false };
    if (state === 'half-open' && !trialInFlight) {
      trialInFlight = true;
      return { ok: true, trial: true };
    }
    return { ok: false, trial: false };
  }

  function record(failed: boolean, trial: boolean): void {
    if (!on()) return;
    if (trial) {
      trialInFlight = false;
      if (failed) {
        openedAt = t;
        move('open', 'the trial call failed');
      } else {
        recent = [];
        move('closed', 'the trial call succeeded');
      }
      return;
    }
    if (state !== 'closed') return;
    recent.push(failed);
    if (recent.length > p.window) recent.shift();
    const failures = recent.filter(Boolean).length;
    if (recent.length === p.window && failures * 100 >= p.threshold * p.window) {
      openedAt = t;
      move('open', `${failures} of the last ${p.window} calls failed`);
    }
  }

  function start(): Job {
    const permit = allow();
    if (!permit.ok) return { ends: t + OWN_MS, called: false, hangs: false, trial: false };
    callsToReviews.push(t);
    const m = mode();
    const hangs = m === 'down' || (m === 'quarter' && rng.chance(0.25));
    const call = hangs ? TIMEOUT_MS : Math.min(TIMEOUT_MS, MEDIAN_MS * Math.exp(SIGMA * normal(rng)));
    return { ends: t + OWN_MS + call, called: true, hangs, trial: permit.trial };
  }

  function advance(): void {
    t += TICK;
    while (nextArrival <= t) {
      if (queue < QUEUE_MAX) queue++;
      else outcomes.push({ at: t, kind: 'rejected' });
      nextArrival += rng.exponential(1000 / p.rate);
    }
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      if (w && t >= w.ends) {
        if (w.called) record(w.hangs, w.trial);
        outcomes.push({ at: t, kind: w.called && !w.hangs ? 'reviews' : 'without' });
        workers[i] = null;
      }
      if (!workers[i] && queue > 0) {
        queue--;
        workers[i] = start();
      }
    }
    while (outcomes.length && outcomes[0].at < t - OUTCOME_WINDOW_MS) outcomes.shift();
    while (callsToReviews.length && callsToReviews[0] < t - 1000) callsToReviews.shift();
  }

  function counts(): Record<Outcome, number> {
    const c = { reviews: 0, without: 0, rejected: 0 };
    for (const o of outcomes) c[o.kind]++;
    return c;
  }

  function setMode(m: Mode): void {
    scripted = false;
    manualMode = m;
    note(m === 'healthy' ? 'Reviews is healthy again' : m === 'down' ? 'Reviews stops answering: every call hangs' : 'one Reviews server of four stops answering: 1 call in 4 hangs');
  }

  const label = (s: State) => (s === 'closed' ? 'CLOSED: calls flow' : s === 'open' ? 'OPEN: calls refused' : 'HALF-OPEN: one trial');

  return {
    params: [
      { name: 'breaker', label: 'Circuit breaker', min: 0, max: 1, step: 1, value: 1, format: (v) => (v ? 'on' : 'off') },
      { name: 'threshold', label: 'Opens when this share of the window failed', min: 10, max: 90, step: 5, value: 50, unit: '%' },
      { name: 'window', label: 'Window: last N calls', min: 10, max: 100, step: 10, value: 20 },
      { name: 'openS', label: 'Stays open for', min: 1, max: 30, step: 1, value: 5, unit: 's' },
      { name: 'rate', label: 'Pages per second', min: 50, max: 400, step: 10, value: 200 },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      queue = 0;
      workers = Array(WORKERS).fill(null);
      outcomes = [];
      callsToReviews = [];
      scripted = true;
      manualMode = 'healthy';
      state = 'closed';
      recent = [];
      openedAt = 0;
      trialInFlight = false;
      nextArrival = rng.exponential(1000 / p.rate);
      lastEvent = `Script: Reviews is healthy, stops answering at 3 s, recovers at 20 s. ${on() ? 'Breaker on.' : 'Breaker off.'}`;
    },

    step(dt) {
      const end = t + dt;
      while (t < end) advance();
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const bold = { 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') };
      const small = { 'font-size': 15, fill: token('--viz-muted') };

      // Top row: Product, the breaker, Reviews.
      svg('rect', { x: 2, y: 4, width: 110, height: 56, rx: 6, fill: token('--viz-server-soft'), stroke: token('--viz-server'), 'stroke-width': 1.5 }, live);
      text('Product', { x: 57, y: 28, 'text-anchor': 'middle', ...bold }, live);
      text('20 workers', { x: 57, y: 49, 'text-anchor': 'middle', ...small }, live);

      const m = mode();
      const tone = m === 'healthy' ? 'ok' : m === 'down' ? 'bad' : 'warn';
      svg('rect', { x: 288, y: 4, width: 110, height: 56, rx: 6, fill: token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.5 }, live);
      text('Reviews', { x: 343, y: 28, 'text-anchor': 'middle', ...bold }, live);
      text(m === 'healthy' ? 'healthy' : m === 'down' ? 'hangs' : '1 in 4 hang', { x: 343, y: 49, 'text-anchor': 'middle', 'font-size': 15, fill: token(`--viz-${tone}`) }, live);

      const bTone = !on() ? 'stroke' : state === 'closed' ? 'ok' : state === 'open' ? 'bad' : 'warn';
      const lineTone = !on() || state !== 'open' ? '--viz-flow' : '--viz-stroke';
      svg('line', { x1: 114, y1: 32, x2: 286, y2: 32, stroke: token(lineTone as `--viz-${string}`), 'stroke-width': 2, 'stroke-dasharray': on() && state === 'open' ? '4 4' : null }, live);
      svg('rect', { x: 150, y: 14, width: 100, height: 36, rx: 18, fill: token('--viz-surface'), stroke: token(`--viz-${bTone}`), 'stroke-width': 2 }, live);
      text(on() ? state.toUpperCase() : 'no breaker', { x: 200, y: 38, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: token(on() ? `--viz-${bTone}` : '--viz-muted') }, live);
      text(`${callsToReviews.length} calls/s reach Reviews`, { x: 398, y: 80, 'text-anchor': 'end', ...small }, live);

      // Workers.
      text('Workers', { x: 2, y: 104, ...bold }, live);
      workers.forEach((w, i) => {
        const x = 2 + (i % 10) * 39.6;
        const y = 114 + Math.floor(i / 10) * 32;
        const k = !w ? null : !w.called ? 'ok' : w.hangs ? 'warn' : 'flow';
        svg('rect', {
          x, y, width: 34, height: 26, rx: 4,
          fill: k ? token(`--viz-${k}-soft`) : token('--viz-surface'),
          stroke: k ? token(`--viz-${k}`) : token('--viz-stroke'), 'stroke-width': 1.5,
          'stroke-dasharray': k === 'warn' ? '5 2' : null,
        }, live);
      });
      const stuck = workers.filter((w) => w && w.hangs).length;
      text(`${stuck} of 20 stuck waiting on Reviews · queue ${queue}`, { x: 2, y: 196, 'font-size': 15, fill: stuck > 10 ? token('--viz-warn') : token('--viz-muted') }, live);

      // The breaker's window, or its countdown.
      let y = 226;
      if (!on()) {
        text('No breaker: every page calls Reviews', { x: 2, y, ...small }, live);
      } else if (state === 'open') {
        const left = Math.max(0, p.openS * 1000 - (t - openedAt));
        text(`Open: trial call in ${(left / 1000).toFixed(1)} s`, { x: 2, y, ...bold, fill: token('--viz-bad') }, live);
        svg('rect', { x: 230, y: y - 13, width: 168 * (left / (p.openS * 1000)), height: 14, rx: 3, fill: token('--viz-bad-soft'), stroke: token('--viz-bad'), 'stroke-width': 1 }, live);
      } else if (state === 'half-open') {
        text('Half-open: waiting for the trial call', { x: 2, y, ...bold, fill: token('--viz-warn') }, live);
      } else {
        const f = recent.filter(Boolean).length;
        text(`Last ${recent.length} calls: ${f} failed`, { x: 2, y, ...small }, live);
        const bx = 200;
        const bw = 198;
        svg('rect', { x: bx, y: y - 13, width: bw, height: 14, rx: 3, fill: token('--viz-surface'), stroke: token('--viz-stroke'), 'stroke-width': 1 }, live);
        if (f) svg('rect', { x: bx, y: y - 13, width: (bw * f) / p.window, height: 14, rx: 3, fill: token('--viz-bad-soft'), stroke: token('--viz-bad'), 'stroke-width': 1 }, live);
        const tx = bx + (bw * p.threshold) / 100;
        svg('line', { x1: tx, y1: y - 18, x2: tx, y2: y + 5, stroke: token('--viz-ink'), 'stroke-width': 2 }, live);
      }

      // Pages over the last 2 s.
      y = 256;
      text('Pages, last 2 s', { x: 2, y, ...bold }, live);
      const c = counts();
      const total = c.reviews + c.without + c.rejected;
      let x = 2;
      for (const [kind, tn] of [['reviews', 'ok'], ['without', 'warn'], ['rejected', 'bad']] as const) {
        const w = total ? (396 * c[kind]) / total : 0;
        if (w > 0) svg('rect', { x, y: y + 8, width: w, height: 20, fill: token(`--viz-${tn}-soft`), stroke: token(`--viz-${tn}`), 'stroke-width': 1.2 }, live);
        x += w;
      }
      const pc = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : '–');
      text(`${pc(c.reviews)} with reviews`, { x: 2, y: y + 50, 'font-size': 15, fill: token('--viz-ok') }, live);
      text(`${pc(c.without)} without`, { x: 160, y: y + 50, 'font-size': 15, fill: token('--viz-warn') }, live);
      text(`${pc(c.rejected)} failed`, { x: 290, y: y + 50, 'font-size': 15, fill: token('--viz-bad') }, live);
    },

    stats() {
      const c = counts();
      const total = c.reviews + c.without + c.rejected;
      return {
        'model time': formatMs(t),
        'breaker': on() ? label(state) : 'off',
        'workers stuck on Reviews': workers.filter((w) => w && w.hangs).length,
        'calls reaching Reviews per second': callsToReviews.length,
        'pages with reviews (last 2 s)': total ? `${Math.round((c.reviews / total) * 100)}%` : '–',
        'pages failed (last 2 s)': total ? `${Math.round((c.rejected / total) * 100)}%` : '–',
      };
    },

    log: () => lastEvent,

    actions: [
      { label: 'Reviews: every call hangs', run: () => setMode('down') },
      { label: 'Reviews: 1 call in 4 hangs', run: () => setMode('quarter') },
      { label: 'Reviews: healthy', run: () => setMode('healthy') },
    ],
  };
};
