// Outlier ejection and panic mode in front of ten hosts.
// Each host serves one request at a time, 10 ms of work on average (100 req/s). A request that
// takes longer than TIMEOUT_MS fails with a gateway timeout. The balancer picks the less busy of
// two random hosts among those not ejected. After 5 failures in a row a host is ejected for
// BASE_EJECT_MS × (times ejected), unless that would eject more than the allowed share of hosts.
// Panic mode: when fewer than `panic`% of hosts are left, the balancer ignores ejection and uses
// all of them. The action makes three hosts fail every request in 1 ms for 20 s (a bad deploy).
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const H = 10;
const SERVICE_MS = 10;
const TIMEOUT_MS = 250;
const CONSECUTIVE = 5;
const BASE_EJECT_MS = 10_000; // Envoy's default is 30 s; shortened so the sim recovers in view
const BAD_MS = 20_000;
const BUCKET_MS = 500;
const HISTORY = 60; // buckets on the chart: 30 s

interface Host {
  freeAt: number;
  inflight: number;
  fails: number;
  ejectedUntil: number;
  times: number;
  badUntil: number;
}
type Outcome = [number, number, boolean, number]; // [time, host, ok, latency]

export const createEjectModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let next = 0;
  let rate = 0;
  let hosts: Host[] = [];
  let pending: Outcome[] = [];
  let buckets: { ok: number; all: number }[] = [];
  let panic = false;
  let lastEvent: string | null = null;

  const ejected = (h: Host) => h.ejectedUntil > t;
  const ejectedCount = () => hosts.filter(ejected).length;

  function settle(until: number): void {
    while (pending.length && pending[0][0] <= until) {
      const [at, k, ok] = pending.shift()!;
      const h = hosts[k];
      h.inflight -= 1;
      const b = Math.floor(at / BUCKET_MS);
      while (buckets.length <= b) buckets.push({ ok: 0, all: 0 });
      buckets[b].all += 1;
      if (ok) {
        buckets[b].ok += 1;
        h.fails = 0;
        continue;
      }
      h.fails += 1;
      const allowed = Math.max(1, Math.floor((H * p.maxEject) / 100));
      if (h.fails >= CONSECUTIVE && h.ejectedUntil <= at && hosts.filter((x) => x.ejectedUntil > at).length < allowed) {
        h.times += 1;
        h.ejectedUntil = at + BASE_EJECT_MS * Math.min(h.times, 3);
        h.fails = 0;
        lastEvent = `t=${(at / 1000).toFixed(1)}s host ${k + 1} ejected for ${(BASE_EJECT_MS * Math.min(h.times, 3)) / 1000} s after ${CONSECUTIVE} failures in a row`;
      }
    }
  }

  function arrive(now: number): void {
    const usable = hosts.map((_, k) => k).filter((k) => hosts[k].ejectedUntil <= now);
    const wasPanic = panic;
    panic = (100 * usable.length) / H < p.panic;
    if (panic && !wasPanic) lastEvent = `t=${(now / 1000).toFixed(1)}s panic: only ${usable.length} of ${H} hosts left, sending to all of them`;
    const pool = panic ? hosts.map((_, k) => k) : usable;
    const b = Math.floor(now / BUCKET_MS);
    if (!pool.length) {
      while (buckets.length <= b) buckets.push({ ok: 0, all: 0 });
      buckets[b].all += 1; // 503: no healthy upstream
      return;
    }
    const a = pool[Math.floor(rng.next() * pool.length)];
    let c = pool[Math.floor(rng.next() * pool.length)];
    if (pool.length > 1) while (c === a) c = pool[Math.floor(rng.next() * pool.length)];
    const k = hosts[a].inflight <= hosts[c].inflight ? a : c;
    const h = hosts[k];
    h.inflight += 1;
    let outcome: Outcome;
    if (h.badUntil > now) {
      outcome = [now + 1, k, false, 1];
    } else {
      const start = Math.max(now, h.freeAt);
      h.freeAt = start + rng.exponential(SERVICE_MS);
      const latency = h.freeAt - now;
      outcome = latency > TIMEOUT_MS ? [now + TIMEOUT_MS, k, false, TIMEOUT_MS] : [h.freeAt, k, true, latency];
    }
    let i = pending.length;
    while (i > 0 && pending[i - 1][0] > outcome[0]) i--;
    pending.splice(i, 0, outcome);
  }

  return {
    params: [
      { name: 'load', label: 'Load', min: 40, max: 95, step: 5, value: 80, unit: '%' },
      { name: 'maxEject', label: 'Max ejected', min: 10, max: 100, step: 10, value: 100, unit: '%' },
      { name: 'panic', label: 'Panic below', min: 0, max: 80, step: 10, value: 0, unit: '% left' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      rate = ((p.load / 100) * H) / SERVICE_MS;
      next = rng.exponential(1 / rate);
      hosts = Array.from({ length: H }, () => ({ freeAt: 0, inflight: 0, fails: 0, ejectedUntil: 0, times: 0, badUntil: 0 }));
      pending = [];
      buckets = [];
      panic = false;
      lastEvent = `${Math.round(rate * 1000)} req/s across ${H} hosts that serve 100 req/s each. Press "Bad deploy".`;
    },

    step(dt) {
      const end = t + dt;
      while (next <= end) {
        settle(next);
        t = next;
        arrive(next);
        next += rng.exponential(1 / rate);
      }
      t = end;
      settle(t);
    },

    actions: [
      {
        label: 'Bad deploy on 3 hosts (20 s)',
        run() {
          for (let k = 0; k < 3; k++) hosts[k].badUntil = t + BAD_MS;
          lastEvent = `t=${(t / 1000).toFixed(1)}s hosts 1–3 now fail every request in 1 ms, for 20 s`;
        },
      },
    ],

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const w = 34;
      const gap = (392 - H * w) / (H - 1);
      hosts.forEach((h, k) => {
        const x = 4 + k * (w + gap);
        const out = ejected(h);
        const bad = h.badUntil > t;
        const queue = Math.max(0, h.inflight);
        const tone = out ? 'muted' : bad ? 'bad' : queue > 20 ? 'warn' : 'ok';
        svg('rect', {
          x, y: 8, width: w, height: 56, rx: 5,
          fill: out ? 'none' : token(`--viz-${tone}-soft`),
          stroke: token(`--viz-${tone === 'muted' ? 'stroke' : tone}`),
          'stroke-width': 1.5, 'stroke-dasharray': out ? '4 3' : null,
        }, live);
        text(k + 1, { x: x + w / 2, y: 32, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'middle', fill: token('--viz-ink') }, live);
        text(out ? 'out' : bad ? 'err' : queue > 99 ? '99+' : queue, {
          x: x + w / 2, y: 54, 'font-size': 14, 'text-anchor': 'middle',
          fill: token(out ? '--viz-muted' : bad ? '--viz-bad' : queue > 20 ? '--viz-warn' : '--viz-muted'),
        }, live);
      });
      if (panic) text('PANIC: using all hosts', { x: 200, y: 88, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle', fill: token('--viz-warn') }, live);

      // Success rate over the last 30 s.
      const top = 100;
      const height = 110;
      const left = 44;
      const right = 396;
      const axis = layer(view, 'axis');
      if (!axis.childElementCount) {
        svg('line', { x1: left, y1: top, x2: left, y2: top + height, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, axis);
        svg('line', { x1: left, y1: top + height, x2: right, y2: top + height, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, axis);
        text('100%', { x: left - 4, y: top + 6, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, axis);
        text('0%', { x: left - 4, y: top + height, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, axis);
        text('requests that succeed, last 30 s', { x: (left + right) / 2, y: top + height + 22, 'font-size': 15, 'text-anchor': 'middle', fill: token('--viz-muted') }, axis);
      }
      const current = Math.floor(t / BUCKET_MS);
      const points: string[] = [];
      for (let i = 0; i < HISTORY; i++) {
        const b = current - HISTORY + i;
        const bucket = buckets[b];
        if (b < 0 || !bucket || !bucket.all) continue;
        const x = left + ((right - left) * i) / (HISTORY - 1);
        const y = top + height - (height * bucket.ok) / bucket.all;
        points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      if (points.length > 1) svg('polyline', { points: points.join(' '), fill: 'none', stroke: token('--viz-flow'), 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, live);
    },

    stats() {
      const last = buckets.slice(-3, -1);
      const ok = last.reduce((a, b) => a + b.ok, 0);
      const all = last.reduce((a, b) => a + b.all, 0);
      return {
        time: `${(t / 1000).toFixed(1)} s`,
        'success, last second': all ? `${Math.round((100 * ok) / all)}%` : '—',
        'hosts ejected': ejectedCount(),
        'panic mode': panic ? 'on' : 'off',
      };
    },

    log: () => lastEvent,
  };
};
