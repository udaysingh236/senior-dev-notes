// A connection pool in front of a database with 4 CPU cores. Requests arrive at random, wait in
// the pool's queue for a free connection (or give up after the acquire timeout), then hold it for
// a query, an optional stretch of work outside the database (an HTTP call inside the
// transaction), and a second query. Every request needs 10 ms of CPU in total.
//
// The database shares its cores between the queries running at that moment. With more queries
// than cores, each one gets a slice, and the total also shrinks a little per extra query, standing
// in for lock waits and context switches. That loss is a model, roughly matching the drop we
// measured with pgbench (examples/connection-pooling): about 30% fewer transactions at 64
// connections than at the peak.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const CORES = 4;
const CPU_MS = 10; // CPU per request, split over two queries
const CONTENTION = 0.007; // efficiency lost per running query beyond the core count
const SLOW = 4; // sim ms per model ms
const TICK = 0.25; // model ms
const MAX_SLOTS = 64;
const QUEUE_SHOWN = 32;

type Phase = 'query1' | 'outside' | 'query2';
interface Req {
  arrived: number;
  phase: Phase;
  left: number; // CPU ms left in the current query, or ms left outside the database
}

/** Share of a core each running query gets, with n queries running. */
export function speed(n: number): number {
  if (n === 0) return 1;
  const efficiency = 1 / (1 + CONTENTION * Math.max(0, n - CORES));
  return Math.min(1, CORES / n) * efficiency;
}

export const createPoolModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let waiting: number[] = []; // arrival times, oldest first
  let holding: Req[] = [];
  let latencies: number[] = []; // recent completed requests
  let doneTimes: number[] = []; // completion times in the last 2 s, for throughput
  let completed = 0;
  let timedOut = 0;
  let cpuBusy = 0; // core-ms used
  let lastEvent: string | null = null;
  let lastTimeoutLog = -Infinity;

  const running = () => holding.filter((r) => r.phase !== 'outside').length;

  function advance(): void {
    t += TICK;
    while (nextArrival <= t) {
      waiting.push(nextArrival);
      nextArrival += rng.exponential(1000 / p.rate);
    }
    // Give up after the acquire timeout: the caller gets an error instead of a connection.
    while (waiting.length && t - waiting[0] > p.timeout) {
      waiting.shift();
      timedOut++;
      if (t - lastTimeoutLog > 400) {
        lastTimeoutLog = t;
        lastEvent = `t=${(t / 1000).toFixed(1)}s no free connection for ${p.timeout} ms: request failed (${timedOut} so far)`;
      }
    }
    while (waiting.length && holding.length < p.pool) {
      holding.push({ arrived: waiting.shift()!, phase: 'query1', left: CPU_MS / 2 });
    }
    const n = running();
    const s = speed(n);
    cpuBusy += Math.min(CORES, n) * TICK;
    for (const r of holding) r.left -= r.phase === 'outside' ? TICK : s * TICK;
    const still: Req[] = [];
    for (const r of holding) {
      if (r.left > 0) still.push(r);
      else if (r.phase === 'query1' && p.outside > 0) still.push({ ...r, phase: 'outside', left: p.outside });
      else if (r.phase !== 'query2') still.push({ ...r, phase: 'query2', left: CPU_MS / 2 });
      else {
        completed++;
        latencies.push(t - r.arrived);
        doneTimes.push(t);
      }
    }
    holding = still;
    if (latencies.length > 600) latencies.splice(0, latencies.length - 600);
    while (doneTimes.length && doneTimes[0] < t - 2000) doneTimes.shift();
  }

  function pct(q: number): number {
    if (!latencies.length) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }

  return {
    params: [
      { name: 'pool', label: 'Pool size', min: 1, max: MAX_SLOTS, step: 1, value: 8, unit: 'connections' },
      { name: 'rate', label: 'Requests per second', min: 50, max: 450, step: 10, value: 250 },
      { name: 'outside', label: 'Held outside the database', min: 0, max: 200, step: 10, value: 0, unit: 'ms' },
      { name: 'timeout', label: 'Acquire timeout', min: 100, max: 2000, step: 100, value: 500, unit: 'ms' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      waiting = [];
      holding = [];
      latencies = [];
      doneTimes = [];
      completed = 0;
      timedOut = 0;
      cpuBusy = 0;
      lastTimeoutLog = -Infinity;
      nextArrival = rng.exponential(1000 / p.rate);
      const holdMs = CPU_MS + p.outside; // with no other query competing for a core
      const ceiling = Math.round((p.pool / holdMs) * 1000);
      lastEvent = `Each request holds a connection for at least ${Math.round(holdMs)} ms, so ${p.pool} connections can serve at most ${ceiling}/s; the cores alone, ${(CORES / CPU_MS) * 1000}/s.`;
    },

    step(dt) {
      const end = t + dt / SLOW;
      while (t < end) advance();
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        const label = { 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') };
        text('Waiting for a connection', { x: 4, y: 20, ...label }, base);
        text('The pool', { x: 4, y: 124, ...label }, base);
        text(`Database: ${CORES} cores`, { x: 4, y: 274, ...label }, base);
      }
      const live = layer(view, 'live');
      clear(live);

      // Queue: one square per waiting request.
      const shown = Math.min(waiting.length, QUEUE_SHOWN);
      for (let i = 0; i < shown; i++) {
        const age = (t - waiting[i]) / p.timeout;
        svg('rect', {
          x: 4 + (i % 16) * 20, y: 30 + Math.floor(i / 16) * 20, width: 16, height: 16, rx: 3,
          fill: age > 0.7 ? token('--viz-bad-soft') : token('--viz-flow-soft'),
          stroke: age > 0.7 ? token('--viz-bad') : token('--viz-flow'), 'stroke-width': 1.5,
        }, live);
      }
      if (waiting.length > QUEUE_SHOWN) {
        text(`+${waiting.length - QUEUE_SHOWN}`, { x: 330, y: 64, 'font-size': 17, 'font-weight': 700, fill: token('--viz-bad') }, live);
      }
      if (!waiting.length) text('nobody', { x: 4, y: 48, 'font-size': 16, fill: token('--viz-muted') }, live);
      text(`${timedOut} gave up after ${formatMs(p.timeout)}`, { x: 4, y: 92, 'font-size': 15, fill: timedOut ? token('--viz-bad') : token('--viz-muted') }, live);

      // Pool: one cell per connection. Blue = running a query, amber = held but idle in transaction.
      const cols = 16;
      for (let i = 0; i < p.pool; i++) {
        const r = holding[i];
        const tone = !r ? null : r.phase === 'outside' ? 'warn' : 'flow';
        svg('rect', {
          x: 4 + (i % cols) * 24, y: 134 + Math.floor(i / cols) * 22, width: 20, height: 18, rx: 3,
          fill: tone ? token(`--viz-${tone}-soft`) : token('--viz-surface'),
          stroke: tone ? token(`--viz-${tone}`) : token('--viz-stroke'), 'stroke-width': 1.5,
        }, live);
        if (r?.phase === 'outside') {
          svg('line', { x1: 8 + (i % cols) * 24, y1: 143 + Math.floor(i / cols) * 22, x2: 20 + (i % cols) * 24, y2: 143 + Math.floor(i / cols) * 22, stroke: token('--viz-warn'), 'stroke-width': 2 }, live);
        }
      }
      const n = running();
      const outside = holding.length - n;
      text(`${n} in a query · ${outside} held, not querying · ${p.pool - holding.length} idle`, {
        x: 4, y: 242, 'font-size': 15, fill: token('--viz-muted'),
      }, live);

      // Cores: how fast each running query goes.
      const s = speed(n);
      for (let c = 0; c < CORES; c++) {
        const busy = c < Math.min(n, CORES);
        svg('rect', {
          x: 4 + c * 46, y: 284, width: 40, height: 28, rx: 4,
          fill: busy ? token('--viz-ok-soft') : token('--viz-surface'),
          stroke: busy ? token('--viz-ok') : token('--viz-stroke'), 'stroke-width': 1.5,
        }, live);
      }
      const slow = n > CORES;
      text(n ? `${n} queries share them: each runs at ${Math.round(s * 100)}% speed` : 'idle', {
        x: 4, y: 334, 'font-size': 15, fill: slow ? token('--viz-warn') : token('--viz-muted'),
      }, live);
      text(`${doneTimes.length / 2}/s done`, { x: 196, y: 304, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, live);
    },

    stats() {
      return {
        'model time': formatMs(t),
        'completed per second': `${doneTimes.length / 2}`,
        'p50 latency': latencies.length ? formatMs(pct(0.5)) : '–',
        'p99 latency': latencies.length ? formatMs(pct(0.99)) : '–',
        'failed (no connection in time)': timedOut,
        'database CPU busy': t ? `${Math.round((cpuBusy / (t * CORES)) * 100)}%` : '–',
      };
    },

    log: () => lastEvent,
  };
};
