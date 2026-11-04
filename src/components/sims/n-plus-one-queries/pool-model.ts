// Two copies of the same "list orders" endpoint, fed the same stream of requests. One loads each
// order's customer and items with a query per order (1 + 2N queries); the other batches them
// (3 queries). Each copy has its own connection pool and its own database with 4 cores.
//
// A request holds its connection for its whole life: for every query, one network round trip
// and then the query's work on the database. The work shares the cores with every other query
// running at that moment. The per-query costs are calibrated to our PostgreSQL 16 measurements
// (examples/n-plus-one-queries): a primary-key lookup costs about 0.085 ms of database and
// driver time; the batched queries cost a little more each, growing with the page size.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const CORES = 4;
const LOOKUP_MS = 0.085; // one primary-key lookup, server and driver
const ACQUIRE_TIMEOUT = 1000; // ms a request waits for a connection before failing
const TICK = 0.05; // model ms per inner step; leftovers carry into the next phase
const QUEUE_SHOWN = 32;

interface Req {
  arrived: number;
  query: number; // index of the query in flight
  onWire: boolean; // waiting for the network, or working on the database
  left: number; // ms left in the current phase
}

interface Lane {
  name: string;
  costs: number[]; // database ms for each query of one request
  waiting: number[];
  holding: Req[];
  latencies: number[];
  doneTimes: number[];
  completed: number;
  failed: number;
  cpuBusy: number;
}

/** Database ms per query for one request, for each strategy, with `rows` orders on the page. */
export function queryCosts(strategy: 'n+1' | 'batched', rows: number): number[] {
  const page = 0.15 + 0.002 * rows;
  if (strategy === 'n+1') return [page, ...Array(2 * rows).fill(LOOKUP_MS)];
  return [page, 0.1 + 0.004 * rows, 0.1 + 0.008 * rows];
}

export const createPoolModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;
  let lastFailLog = -Infinity;

  function newLane(name: string, costs: number[]): Lane {
    return { name, costs, waiting: [], holding: [], latencies: [], doneTimes: [], completed: 0, failed: 0, cpuBusy: 0 };
  }

  function advanceLane(lane: Lane): void {
    while (lane.waiting.length && t - lane.waiting[0] > ACQUIRE_TIMEOUT) {
      lane.waiting.shift();
      lane.failed++;
      if (t - lastFailLog > 500) {
        lastFailLog = t;
        lastEvent = `t=${(t / 1000).toFixed(1)}s ${lane.name}: no connection within 1 s, request failed (${lane.failed} so far)`;
      }
    }
    while (lane.waiting.length && lane.holding.length < p.pool) {
      lane.holding.push({ arrived: lane.waiting.shift()!, query: 0, onWire: true, left: p.rtt });
    }
    const working = lane.holding.filter((r) => !r.onWire).length;
    const speed = working > CORES ? CORES / working : 1;
    lane.cpuBusy += Math.min(CORES, working) * TICK;
    const still: Req[] = [];
    for (const r of lane.holding) {
      r.left -= r.onWire ? TICK : speed * TICK;
      if (r.left > 0) {
        still.push(r);
      } else if (r.onWire) {
        r.onWire = false;
        r.left += lane.costs[r.query];
        still.push(r);
      } else if (r.query + 1 < lane.costs.length) {
        r.query++;
        r.onWire = true;
        r.left += p.rtt;
        still.push(r);
      } else {
        lane.completed++;
        lane.latencies.push(t - r.arrived);
        lane.doneTimes.push(t);
      }
    }
    lane.holding = still;
    if (lane.latencies.length > 600) lane.latencies.splice(0, lane.latencies.length - 600);
    while (lane.doneTimes.length && lane.doneTimes[0] < t - 2000) lane.doneTimes.shift();
  }

  function advance(): void {
    t += TICK;
    while (nextArrival <= t) {
      for (const lane of lanes) lane.waiting.push(nextArrival);
      nextArrival += rng.exponential(1000 / p.rate);
    }
    for (const lane of lanes) advanceLane(lane);
  }

  function pct(lane: Lane, q: number): number {
    if (!lane.latencies.length) return 0;
    const sorted = [...lane.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }

  function holdMs(lane: Lane): number {
    return lane.costs.length * p.rtt + lane.costs.reduce((a, b) => a + b, 0);
  }

  function drawLane(live: SVGGElement, lane: Lane, y: number): void {
    const queries = lane.costs.length;
    const ceiling = Math.round((p.pool / holdMs(lane)) * 1000);
    text(`${lane.name}: ${queries} queries, holds ${formatMs(holdMs(lane))}`, {
      x: 4, y, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink'),
    }, live);
    text(`pool can serve at most ${ceiling}/s`, {
      x: 4, y: y + 22, 'font-size': 15, fill: ceiling < p.rate ? token('--viz-bad') : token('--viz-muted'),
    }, live);

    // Pool: one cell per connection, filled as far as that request has got through its queries.
    for (let i = 0; i < p.pool; i++) {
      const r = lane.holding[i];
      const x = 4 + (i % 16) * 24;
      const cy = y + 32 + Math.floor(i / 16) * 22;
      svg('rect', { x, y: cy, width: 20, height: 18, rx: 3, fill: token('--viz-surface'), stroke: r ? token('--viz-flow') : token('--viz-stroke'), 'stroke-width': 1.5 }, live);
      if (r) {
        const done = (r.query + (r.onWire ? 0 : 0.5)) / queries;
        svg('rect', { x: x + 1, y: cy + 18 - 17 * done - 0.5, width: 18, height: Math.max(1, 17 * done), rx: 2, fill: token('--viz-flow-soft') }, live);
      }
    }
    const poolRows = Math.ceil(p.pool / 16);

    // Queue: requests waiting for a connection, red once they are close to giving up.
    const qy = y + 40 + poolRows * 22;
    const shown = Math.min(lane.waiting.length, QUEUE_SHOWN);
    for (let i = 0; i < shown; i++) {
      const old = t - lane.waiting[i] > ACQUIRE_TIMEOUT * 0.7;
      svg('rect', {
        x: 4 + i * 11, y: qy, width: 8, height: 12, rx: 2,
        fill: old ? token('--viz-bad-soft') : token('--viz-warn-soft'),
        stroke: old ? token('--viz-bad') : token('--viz-warn'), 'stroke-width': 1.2,
      }, live);
    }
    const waitText = `${lane.waiting.length ? `${lane.waiting.length} waiting` : 'nobody waiting'} · ${lane.failed} failed`;
    text(waitText, { x: 4, y: shown ? qy + 32 : qy + 11, 'font-size': 15, fill: lane.failed ? token('--viz-bad') : token('--viz-muted') }, live);
  }

  return {
    params: [
      { name: 'rtt', label: 'Network round trip', min: 0.1, max: 5, step: 0.1, value: 0.1, unit: 'ms' },
      { name: 'rows', label: 'Orders on the page (N)', min: 5, max: 200, step: 5, value: 50 },
      { name: 'rate', label: 'Requests per second', min: 50, max: 1000, step: 25, value: 200 },
      { name: 'pool', label: 'Pool size', min: 2, max: 32, step: 1, value: 10, unit: 'connections' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      lastFailLog = -Infinity;
      nextArrival = rng.exponential(1000 / p.rate);
      lanes = [newLane('N+1', queryCosts('n+1', p.rows)), newLane('Batched', queryCosts('batched', p.rows))];
      const [a, b] = lanes;
      lastEvent = `Per request: N+1 makes ${a.costs.length} round trips and holds a connection ${formatMs(holdMs(a))}; batched makes 3 and holds it ${formatMs(holdMs(b))}.`;
    },

    step(dt) {
      const end = t + dt;
      while (t < end) advance();
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      drawLane(live, lanes[0], 20);
      drawLane(live, lanes[1], 190);
    },

    stats() {
      const out: Record<string, string | number> = { 'model time': formatMs(t) };
      for (const lane of lanes) {
        out[`${lane.name}: done per second`] = lane.doneTimes.length / 2;
        out[`${lane.name}: p99 latency`] = lane.latencies.length ? formatMs(pct(lane, 0.99)) : '–';
        out[`${lane.name}: database CPU`] = t ? `${Math.round((lane.cpuBusy / (t * CORES)) * 100)}%` : '–';
      }
      return out;
    },

    log: () => lastEvent,
  };
};
