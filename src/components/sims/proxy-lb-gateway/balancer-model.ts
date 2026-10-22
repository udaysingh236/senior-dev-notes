// Clients with one long-lived HTTP/2 connection each send requests to a pool of backends through
// three balancers on the same arrivals:
//   L4            picks a backend once per connection (fewest connections), then forwards bytes
//   L7 round robin   picks the next backend for every request
//   L7 least outstanding   picks the backend with the fewest requests in flight
// Each backend serves one request at a time; backend 1 can be made slower.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

type Kind = 'l4' | 'rr' | 'lor';
const LANES: { id: Kind; title: string }[] = [
  { id: 'l4', title: 'L4: one backend per connection' },
  { id: 'rr', title: 'L7: round robin per request' },
  { id: 'lor', title: 'L7: least outstanding requests' },
];
const RATE = 60; // requests per second per client connection
const SERVICE_MS = 10; // a healthy backend serves 100 req/s
const WINDOW_MS = 1000;

interface Backend {
  queue: number[]; // arrival times of waiting requests
  busyUntil: number;
  inService: number | null; // arrival time of the request being served
  served: number[]; // completion times in the last window
  conns: number;
}

class Lane {
  kind: Kind;
  backends: Backend[];
  connTo: number[] = []; // client -> backend (L4)
  rr = 0;
  latencies: number[] = [];
  constructor(kind: Kind, n: number, clients: number) {
    this.kind = kind;
    this.backends = Array.from({ length: n }, () => ({ queue: [], busyUntil: 0, inService: null, served: [], conns: 0 }));
    for (let c = 0; c < clients; c++) {
      let best = 0;
      for (let k = 1; k < n; k++) if (this.backends[k].conns < this.backends[best].conns) best = k;
      this.backends[best].conns++;
      this.connTo.push(best);
    }
  }

  route(client: number): number {
    if (this.kind === 'l4') return this.connTo[client];
    if (this.kind === 'rr') return this.rr++ % this.backends.length;
    let best = 0;
    const load = (b: Backend) => b.queue.length + (b.inService !== null ? 1 : 0);
    for (let k = 1; k < this.backends.length; k++) if (load(this.backends[k]) < load(this.backends[best])) best = k;
    return best;
  }

  arrive(client: number, now: number): void {
    this.backends[this.route(client)].queue.push(now);
  }

  advance(now: number, slow: number): void {
    this.backends.forEach((b, k) => {
      const service = SERVICE_MS * (k === 0 ? slow : 1);
      // Serve as many requests as fit before `now`, one at a time.
      while (true) {
        if (b.inService !== null) {
          if (b.busyUntil > now) break;
          b.served.push(b.busyUntil);
          this.latencies.push(b.busyUntil - b.inService);
          b.inService = null;
        }
        if (!b.queue.length) break;
        const arrived = b.queue.shift()!;
        b.inService = arrived;
        b.busyUntil = Math.max(b.busyUntil, arrived) + service;
      }
      while (b.served.length && b.served[0] < now - WINDOW_MS) b.served.shift();
    });
    if (this.latencies.length > 400) this.latencies.splice(0, this.latencies.length - 400);
  }

  p95(): number {
    if (!this.latencies.length) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)];
  }
}

export const createBalancerModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let next: number[] = [];
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'clients', label: 'Client connections', min: 1, max: 8, step: 1, value: 4 },
      { name: 'backends', label: 'Backends', min: 2, max: 8, step: 1, value: 6 },
      { name: 'slow', label: 'Backend 1 slower by', min: 1, max: 6, step: 1, value: 1, unit: '×' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      lanes = LANES.map((l) => new Lane(l.id, p.backends, p.clients));
      next = Array.from({ length: p.clients }, () => rng.exponential(1000 / RATE));
      lastEvent = `${p.clients} long-lived connections × ${RATE} req/s = ${p.clients * RATE} req/s; each backend serves ${1000 / SERVICE_MS} req/s.`;
    },

    step(dt) {
      t += dt;
      for (let c = 0; c < next.length; c++) {
        while (next[c] <= t) {
          for (const lane of lanes) lane.arrive(c, next[c]);
          next[c] += rng.exponential(1000 / RATE);
        }
      }
      for (const lane of lanes) lane.advance(t, p.slow);
    },

    render(view) {
      const laneH = 128;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        LANES.forEach((l, li) => text(l.title, { x: 4, y: li * laneH + 20, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, base));
      }
      const live = layer(view, 'live');
      clear(live);
      const n = p.backends;
      const w = Math.min(44, (392 - 6 * (n - 1)) / n);
      lanes.forEach((lane, li) => {
        const top = li * laneH + 32;
        lane.backends.forEach((b, k) => {
          const x = 4 + k * (w + 6);
          const capacity = 1000 / (SERVICE_MS * (k === 0 ? p.slow : 1));
          const util = Math.min(1, b.served.length / capacity);
          const backlog = b.queue.length;
          const tone = backlog > 20 ? 'bad' : util > 0.85 ? 'warn' : util > 0.02 ? 'ok' : 'stroke';
          svg('rect', { x, y: top, width: w, height: 60, rx: 4, fill: 'none', stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, live);
          if (util > 0) {
            svg('rect', { x, y: top + 60 - 60 * util, width: w, height: 60 * util, rx: 4, fill: token(`--viz-${tone === 'stroke' ? 'ok' : tone}-soft`), stroke: token(`--viz-${tone === 'stroke' ? 'ok' : tone}`), 'stroke-width': 1.5 }, live);
          }
          text(backlog > 5 ? `${backlog > 999 ? '999+' : backlog}` : util < 0.02 ? 'idle' : `${Math.round(util * 100)}%`, {
            x: x + w / 2, y: top + 80, 'font-size': 15, 'font-weight': 700, 'text-anchor': 'middle',
            fill: backlog > 5 ? token('--viz-bad') : token('--viz-muted'),
          }, live);
          if (k === 0 && p.slow > 1) text('slow', { x: x + w / 2, y: top + 36, 'font-size': 14, 'text-anchor': 'middle', fill: token('--viz-warn') }, live);
        });
      });
    },

    stats() {
      const out: Record<string, string | number> = { time: `${(t / 1000).toFixed(1)} s` };
      const names: Record<Kind, string> = { l4: 'L4', rr: 'L7 round robin', lor: 'L7 least outstanding' };
      for (const lane of lanes) {
        const idle = lane.backends.filter((b) => b.served.length === 0 && b.queue.length === 0).length;
        const p95 = lane.p95();
        out[`${names[lane.kind]} p95`] = p95 > 5000 ? `${(p95 / 1000).toFixed(1)} s` : `${Math.round(p95)} ms`;
        out[`${names[lane.kind]} idle backends`] = idle;
      }
      return out;
    },

    log: () => lastEvent,
  };
};
