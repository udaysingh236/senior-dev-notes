// A service with a fixed pool of workers. Each request takes a worker and calls one dependency.
// Most calls answer in about 40 ms (log-normal, p99 about 160 ms); a share of them never answer,
// the way calls to a struggling dependency hang. The worker waits for the answer or for its
// timeout, whichever comes first. Requests that find every worker busy wait in a short queue;
// when that is full, the service rejects them at once.
//
// What the reader controls: the timeout, the share of calls that hang, the traffic and the
// number of workers. What they watch: worker time going to calls that will never answer.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const MEDIAN_MS = 40;
const SIGMA = 0.6; // log-normal spread: p99 ≈ 40 × e^(2.33 × 0.6) ≈ 160 ms
const QUEUE_MAX = 40;
const WINDOW_MS = 2000; // outcome counts cover the last 2 s
const TICK = 1; // model ms per inner step

type Outcome = 'ok' | 'timeout' | 'rejected';
interface Call {
  started: number;
  ends: number; // when the dependency answers; Infinity for a hung call
}

/** Normal sample by Box-Muller, from the seeded generator. */
function normal(rng: Rng): number {
  const u = Math.max(rng.next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

export const createBrownoutModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let queue: number[] = [];
  let workers: (Call | null)[] = [];
  let outcomes: { at: number; kind: Outcome }[] = [];
  let latencies: number[] = [];
  let busyMs = 0;
  let hungMs = 0;
  let lastEvent: string | null = null;
  let lastLog = -Infinity;

  function note(msg: string): void {
    if (t - lastLog > 600) {
      lastLog = t;
      lastEvent = `t=${(t / 1000).toFixed(1)}s ${msg}`;
    }
  }

  function startCall(): Call {
    const hangs = rng.chance(p.hang / 100);
    const duration = MEDIAN_MS * Math.exp(SIGMA * normal(rng));
    return { started: t, ends: hangs ? Infinity : t + duration };
  }

  function advance(): void {
    t += TICK;
    while (nextArrival <= t) {
      if (queue.length < QUEUE_MAX) queue.push(nextArrival);
      else {
        outcomes.push({ at: t, kind: 'rejected' });
        note('every worker busy and the queue full: request rejected');
      }
      nextArrival += rng.exponential(1000 / p.rate);
    }
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      if (w) {
        busyMs += TICK;
        if (w.ends === Infinity) hungMs += TICK;
        if (t >= w.ends) {
          outcomes.push({ at: t, kind: 'ok' });
          latencies.push(t - w.started);
          workers[i] = null;
        } else if (t - w.started >= p.timeout) {
          outcomes.push({ at: t, kind: 'timeout' });
          if (w.ends !== Infinity) note(`a healthy call was slower than ${p.timeout} ms: timed out anyway`);
          workers[i] = null;
        }
      }
      if (!workers[i] && queue.length) {
        queue.shift();
        workers[i] = startCall();
      }
    }
    while (outcomes.length && outcomes[0].at < t - WINDOW_MS) outcomes.shift();
    if (latencies.length > 800) latencies.splice(0, latencies.length - 800);
  }

  function counts(): Record<Outcome, number> {
    const c = { ok: 0, timeout: 0, rejected: 0 };
    for (const o of outcomes) c[o.kind]++;
    return c;
  }

  return {
    params: [
      { name: 'timeout', label: 'Timeout on the dependency call', min: 50, max: 5000, step: 50, value: 2000, unit: 'ms' },
      { name: 'hang', label: 'Calls that never answer', min: 0, max: 20, step: 1, value: 5, unit: '%' },
      { name: 'rate', label: 'Requests per second', min: 50, max: 400, step: 10, value: 200 },
      { name: 'workers', label: 'Workers', min: 5, max: 40, step: 1, value: 20 },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      queue = [];
      workers = Array(p.workers).fill(null);
      outcomes = [];
      latencies = [];
      busyMs = 0;
      hungMs = 0;
      lastLog = -Infinity;
      nextArrival = rng.exponential(1000 / p.rate);
      // Average time a worker is held per request: healthy calls ≈ 48 ms on average, hung ones the full timeout.
      const healthy = Math.min(MEDIAN_MS * Math.exp((SIGMA * SIGMA) / 2), p.timeout);
      const hold = (1 - p.hang / 100) * healthy + (p.hang / 100) * p.timeout;
      const ceiling = Math.round((p.workers / hold) * 1000);
      lastEvent = `Each request holds a worker ${Math.round(hold)} ms on average, so ${p.workers} workers can serve about ${ceiling}/s. Traffic: ${p.rate}/s.`;
    },

    step(dt) {
      const end = t + dt;
      while (t < end) advance();
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const label = { 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') };
      text('Workers', { x: 4, y: 20, ...label }, live);

      // Workers: blue while waiting on a call that will answer, amber on one that never will.
      const cols = 10;
      workers.forEach((w, i) => {
        const x = 4 + (i % cols) * 38;
        const y = 30 + Math.floor(i / cols) * 34;
        const tone = !w ? null : w.ends === Infinity ? 'warn' : 'flow';
        svg('rect', {
          x, y, width: 32, height: 28, rx: 4,
          fill: tone ? token(`--viz-${tone}-soft`) : token('--viz-surface'),
          stroke: tone ? token(`--viz-${tone}`) : token('--viz-stroke'), 'stroke-width': 1.5,
        }, live);
        if (w) {
          // A bar fills towards the timeout: how much longer this worker can be held.
          const used = Math.min(1, (t - w.started) / p.timeout);
          svg('rect', { x: x + 3, y: y + 22, width: 26 * used, height: 3, fill: tone === 'warn' ? token('--viz-warn') : token('--viz-flow') }, live);
        }
      });
      const rows = Math.ceil(workers.length / cols);
      const hungNow = workers.filter((w) => w && w.ends === Infinity).length;
      const busy = workers.filter(Boolean).length;
      let y = 30 + rows * 34 + 18;
      text(`${busy - hungNow} on healthy calls · ${hungNow} on hung calls`, {
        x: 4, y, 'font-size': 15, fill: hungNow > workers.length / 2 ? token('--viz-warn') : token('--viz-muted'),
      }, live);

      y += 30;
      text('Queue', { x: 4, y, ...label }, live);
      const shown = Math.min(queue.length, QUEUE_MAX);
      for (let i = 0; i < shown; i++) {
        svg('rect', { x: 70 + (i % 20) * 16, y: y - 14 + Math.floor(i / 20) * 16, width: 12, height: 12, rx: 2, fill: token('--viz-flow-soft'), stroke: token('--viz-flow'), 'stroke-width': 1.2 }, live);
      }
      if (!queue.length) text('empty', { x: 70, y, 'font-size': 15, fill: token('--viz-muted') }, live);

      // Outcomes over the last 2 s, as one stacked bar.
      y += 46;
      text('Last 2 s', { x: 4, y, ...label }, live);
      const c = counts();
      const total = c.ok + c.timeout + c.rejected;
      let x = 4;
      const barY = y + 10;
      for (const [kind, tone] of [['ok', 'ok'], ['timeout', 'warn'], ['rejected', 'bad']] as const) {
        const w = total ? (392 * c[kind]) / total : 0;
        if (w > 0) svg('rect', { x, y: barY, width: w, height: 22, fill: token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.2 }, live);
        x += w;
      }
      const pc = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : '–');
      text(`${pc(c.ok)} answered`, { x: 4, y: barY + 46, 'font-size': 15, fill: token('--viz-ok') }, live);
      text(`${pc(c.timeout)} timed out`, { x: 140, y: barY + 46, 'font-size': 15, fill: token('--viz-warn') }, live);
      text(`${pc(c.rejected)} rejected`, { x: 280, y: barY + 46, 'font-size': 15, fill: token('--viz-bad') }, live);
    },

    stats() {
      const c = counts();
      const total = c.ok + c.timeout + c.rejected;
      const sorted = [...latencies].sort((a, b) => a - b);
      const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] : 0;
      return {
        'model time': formatMs(t),
        'answered per second': c.ok / 2,
        'answered': total ? `${Math.round((c.ok / total) * 100)}%` : '–',
        'p99 of answered calls': sorted.length ? formatMs(p99) : '–',
        'worker time on hung calls': busyMs ? `${Math.round((hungMs / busyMs) * 100)}%` : '–',
      };
    },

    log: () => lastEvent,
  };
};
