// Many balancers in front of one pool. Four picking rules run on the same arrivals and the same
// work per request:
//   least, shared table   everyone reads one table of true in-flight counts, refreshed every
//                         `age` ms, and picks the smallest (random among ties)
//   P2C, shared table     the same table, but the smaller of two random backends
//   P2C, own counts       each balancer compares two random backends by its own in-flight requests
//   peak EWMA, own        each balancer compares two by its latency estimate × (its in-flight + 1)
// Eight backends serve one request at a time, 10 ms of work on average; backend 1 can be slower.
// Same mechanics as examples/load-balancing/python/fleet.py.
import { createRng } from '../../sim/rng';
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const N = 8;
const SERVICE_MS = 10;
const WINDOW_MS = 3000; // p99 over the last 3 s
const TAU_MS = 1000;
const ALPHA = 0.3;

type Rule = 'least-table' | 'p2c-table' | 'p2c-own' | 'ewma-own';
const LANES: { id: Rule; title: string; short: string }[] = [
  { id: 'least-table', title: 'Least loaded, shared table', short: 'Least, shared' },
  { id: 'p2c-table', title: 'Two choices, shared table', short: 'P2C, shared' },
  { id: 'p2c-own', title: 'Two choices, own counts', short: 'P2C, own' },
  { id: 'ewma-own', title: 'Peak EWMA, own view', short: 'EWMA, own' },
];

interface Ewma { value: number; at: number }
const readEwma = (e: Ewma, now: number) => e.value * Math.exp(-(now - e.at) / TAU_MS);

class Lane {
  rule: Rule;
  rng: Rng;
  freeAt = new Array(N).fill(0);
  inflight = new Array(N).fill(0);
  own: number[][];
  ewma: Ewma[][];
  table = new Array(N).fill(0);
  done: [number, number, number, number][] = []; // [finish, backend, balancer, latency], by finish time
  recent: [number, number][] = []; // [finish time, latency]
  sent = new Array(N).fill(0);

  constructor(rule: Rule, balancers: number, seed: number) {
    this.rule = rule;
    this.rng = createRng(seed);
    this.own = Array.from({ length: balancers }, () => new Array(N).fill(0));
    this.ewma = Array.from({ length: balancers }, () => Array.from({ length: N }, () => ({ value: SERVICE_MS, at: 0 })));
  }

  finishUntil(when: number): void {
    // `done` is kept sorted by finish time (insertion below), so completions pop from the front.
    while (this.done.length && this.done[0][0] <= when) {
      const [at, k, b, lat] = this.done.shift()!;
      this.inflight[k] -= 1;
      this.own[b][k] -= 1;
      const e = this.ewma[b][k];
      const current = readEwma(e, at);
      e.value = lat > current ? lat : current + ALPHA * (lat - current);
      e.at = at;
      this.recent.push([at, lat]);
    }
  }

  snapshot(): void {
    this.table = this.inflight.slice();
  }

  two(): [number, number] {
    const a = Math.floor(this.rng.next() * N);
    const b = Math.floor(this.rng.next() * (N - 1));
    return [a, b >= a ? b + 1 : b];
  }

  pick(lb: number, now: number, live: boolean): number {
    const table = live ? this.inflight : this.table;
    if (this.rule === 'least-table') {
      const low = Math.min(...table);
      const ties: number[] = [];
      for (let i = 0; i < N; i++) if (table[i] === low) ties.push(i);
      return ties[Math.floor(this.rng.next() * ties.length)];
    }
    const [a, b] = this.two();
    if (this.rule === 'p2c-table') return table[a] <= table[b] ? a : b;
    const own = this.own[lb];
    if (this.rule === 'p2c-own') return own[a] <= own[b] ? a : b;
    const cost = (i: number) => readEwma(this.ewma[lb][i], now) * (own[i] + 1);
    return cost(a) <= cost(b) ? a : b;
  }

  arrive(lb: number, now: number, base: number, slow: number, live: boolean): void {
    const k = this.pick(lb, now, live);
    const start = Math.max(now, this.freeAt[k]);
    this.freeAt[k] = start + base * (k === 0 ? slow : 1);
    this.inflight[k] += 1;
    this.own[lb][k] += 1;
    this.sent[k] += 1;
    const entry: [number, number, number, number] = [this.freeAt[k], k, lb, this.freeAt[k] - now];
    let i = this.done.length;
    while (i > 0 && this.done[i - 1][0] > entry[0]) i--;
    this.done.splice(i, 0, entry);
  }

  trim(now: number): void {
    while (this.recent.length && this.recent[0][0] < now - WINDOW_MS) this.recent.shift();
  }

  p99(now: number): number | null {
    // Requests still waiting count too, with the time they have waited so far.
    const waits = this.recent.map(([, lat]) => lat);
    for (const d of this.done) waits.push(Math.max(0, now - (d[0] - d[3])));
    if (waits.length < 20) return null;
    waits.sort((x, y) => x - y);
    return waits[Math.floor(waits.length * 0.99)];
  }
}

const fmt = (ms: number | null) => (ms === null ? '…' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export const createFleetModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let nextRefresh = 0;
  let rate = 0; // arrivals per ms
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'balancers', label: 'Balancers', min: 1, max: 50, step: 1, value: 1 },
      { name: 'age', label: 'Shared table refreshed every', min: 0, max: 1000, step: 20, value: 0, unit: 'ms' },
      { name: 'load', label: 'Load', min: 40, max: 90, step: 5, value: 70, unit: '%' },
      { name: 'slow', label: 'Backend 1 slower by', min: 1, max: 5, step: 1, value: 3, unit: '×' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      nextRefresh = 0;
      const capacity = (N - 1) / SERVICE_MS + 1 / (SERVICE_MS * p.slow);
      rate = (p.load / 100) * capacity;
      nextArrival = rng.exponential(1 / rate);
      lanes = LANES.map((l, i) => new Lane(l.id, p.balancers, 1000 + i));
      const perLb = (rate * 1000) / p.balancers;
      lastEvent = `${Math.round(rate * 1000)} req/s in total; each of ${p.balancers} balancer${p.balancers > 1 ? 's' : ''} sends about ${perLb >= 10 ? Math.round(perLb) : perLb.toFixed(1)} req/s.`;
    },

    step(dt) {
      const end = t + dt;
      const live = p.age === 0;
      while (nextArrival <= end) {
        const now = nextArrival;
        const lb = Math.floor(rng.next() * p.balancers);
        const base = rng.exponential(SERVICE_MS);
        while (!live && nextRefresh <= now) {
          for (const lane of lanes) {
            lane.finishUntil(nextRefresh);
            lane.snapshot();
          }
          nextRefresh += p.age;
        }
        for (const lane of lanes) {
          lane.finishUntil(now);
          lane.arrive(lb, now, base, p.slow, live);
        }
        nextArrival += rng.exponential(1 / rate);
      }
      t = end;
      for (const lane of lanes) {
        lane.finishUntil(t);
        lane.trim(t);
      }
    },

    render(view) {
      const laneH = 100;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        LANES.forEach((l, li) => text(l.title, { x: 4, y: li * laneH + 18, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base));
      }
      const live = layer(view, 'live');
      clear(live);
      const w = 42;
      const gap = (392 - N * w) / (N - 1);
      lanes.forEach((lane, li) => {
        const top = li * laneH + 28;
        const p99 = lane.p99(t);
        const tone = p99 === null ? 'muted' : p99 > 1000 ? 'bad' : p99 > 150 ? 'warn' : 'ok';
        text(`p99 ${fmt(p99)}`, { x: 396, y: li * laneH + 18, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'end', fill: token(`--viz-${tone}`) }, live);
        lane.inflight.forEach((count, k) => {
          const x = 4 + k * (w + gap);
          const h = 44 * Math.min(1, count / 20);
          const fillTone = count > 15 ? 'bad' : count > 5 ? 'warn' : 'flow';
          svg('rect', { x, y: top, width: w, height: 44, rx: 4, fill: 'none', stroke: token(k === 0 && p.slow > 1 ? '--viz-warn' : '--viz-stroke'), 'stroke-width': 1.5, 'stroke-dasharray': k === 0 && p.slow > 1 ? '4 3' : null }, live);
          if (h > 0) svg('rect', { x, y: top + 44 - h, width: w, height: h, rx: 4, fill: token(`--viz-${fillTone}-soft`), stroke: token(`--viz-${fillTone}`), 'stroke-width': 1.5 }, live);
          text(count > 99 ? '99+' : count, { x: x + w / 2, y: top + 62, 'font-size': 15, 'font-weight': 700, 'text-anchor': 'middle', fill: token(count > 15 ? '--viz-bad' : '--viz-muted') }, live);
        });
      });
    },

    stats() {
      const out: Record<string, string | number> = { time: `${(t / 1000).toFixed(1)} s` };
      const total = (lane: Lane) => lane.sent.reduce((a, b) => a + b, 0);
      LANES.forEach((l, i) => {
        const lane = lanes[i];
        out[`${l.short}: p99`] = fmt(lane.p99(t));
        if (p.slow > 1) out[`${l.short}: to slow backend`] = total(lane) ? `${((100 * lane.sent[0]) / total(lane)).toFixed(1)}%` : '0%';
      });
      if (p.slow > 1) out['fair share for the slow backend'] = `${((100 * (1 / p.slow)) / (N - 1 + 1 / p.slow)).toFixed(1)}%`;
      return out;
    },

    log: () => lastEvent,
  };
};
