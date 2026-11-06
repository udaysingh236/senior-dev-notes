// An open system: new requests arrive at a steady rate whatever happens to earlier ones. One server
// works through a first-in, first-out queue at a fixed rate. Clients give up on an attempt after
// 1 s, and the attempt stays in the queue: when the server reaches it, the work is wasted.
// At t = 5 s a trigger halves the server's capacity for a few seconds (a deploy, a slow disk, a
// noisy neighbour). The question is what happens after the trigger ends, under each retry policy.
//
// What the reader controls: the retry policy, the number of retries, the normal load and the
// trigger's length. What they watch: whether the server recovers when the trigger ends.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const CAPACITY = 100; // attempts per second the healthy server completes
const TIMEOUT_MS = 1000; // clients give up on an attempt after this long
const TRIGGER_AT = 5000; // first trigger
const QUEUE_MAX = 1500; // past this, the server rejects new attempts at once
const BASE_MS = 250; // backoff: retry k waits random(0, min(cap, base × 2^(k-1)))
const CAP_MS = 4000;
const BUDGET_RATIO = 0.1; // every new request earns 0.1 token; every retry spends 1
const BUDGET_MAX = 10;
const BUCKET_MS = 500; // chart resolution
const WINDOW_MS = 20000; // chart width
const RECENT_MS = 5000; // stats cover the last 5 s

export const POLICIES = ['no retries', 'retry at once', 'backoff + jitter', 'backoff + jitter + budget'] as const;

interface Req {
  attempts: number;
  done: boolean;
}
interface Attempt {
  req: Req;
  sentAt: number;
  timedOut: boolean;
}
interface Bucket {
  at: number;
  first: number;
  retry: number;
  ok: number;
  wasted: number;
}

export const createStormModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let queue: Attempt[] = [];
  let qHead = 0;
  let inflight: Attempt[] = []; // in send order, so the oldest times out first
  let iHead = 0;
  let scheduled: { at: number; req: Req }[] = [];
  let serverCredit = 0;
  let tokens = BUDGET_MAX;
  let buckets: Bucket[] = [];
  let triggerStart = TRIGGER_AT;
  let triggerEnd = 0;
  let lastEvent: string | null = null;
  let lastLog = -Infinity;
  let deniedByBudget = 0;

  const policy = () => p.policy;
  const capacityNow = () => (t >= triggerStart && t < triggerEnd ? CAPACITY / 2 : CAPACITY);
  const queued = () => queue.length - qHead;

  function note(msg: string, force = false): void {
    if (force || t - lastLog > 1500) {
      lastLog = t;
      lastEvent = `t=${(t / 1000).toFixed(1)}s ${msg}`;
    }
  }

  function bucket(): Bucket {
    const at = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    let b = buckets[buckets.length - 1];
    if (!b || b.at !== at) {
      b = { at, first: 0, retry: 0, ok: 0, wasted: 0 };
      buckets.push(b);
      while (buckets.length && buckets[0].at < t - WINDOW_MS) buckets.shift();
    }
    return b;
  }

  function send(req: Req): void {
    req.attempts++;
    if (req.attempts === 1) bucket().first++;
    else bucket().retry++;
    if (queued() >= QUEUE_MAX) {
      note('queue full: attempt rejected at once');
      fail(req);
      return;
    }
    const a: Attempt = { req, sentAt: t, timedOut: false };
    queue.push(a);
    inflight.push(a);
  }

  /** The client saw this attempt fail. Decide whether to retry, and when. */
  function fail(req: Req): void {
    const pol = policy();
    if (pol === 0 || req.attempts > p.retries) {
      req.done = true;
      return;
    }
    if (pol === 3) {
      if (tokens < 1) {
        deniedByBudget++;
        note('retry budget empty: failing fast instead of retrying');
        req.done = true;
        return;
      }
      tokens -= 1;
    }
    if (pol === 1) {
      send(req);
      return;
    }
    const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** (req.attempts - 1));
    scheduled.push({ at: t + rng.next() * ceiling, req });
  }

  function advance(): void {
    t += 1;
    // New requests: an open system, so they keep coming at the same rate.
    while (nextArrival <= t) {
      tokens = Math.min(BUDGET_MAX, tokens + BUDGET_RATIO);
      send({ attempts: 0, done: false });
      nextArrival += rng.exponential(1000 / ((p.load / 100) * CAPACITY));
    }
    // Retries whose backoff has elapsed.
    if (scheduled.length) {
      const due = scheduled.filter((s) => s.at <= t);
      if (due.length) {
        scheduled = scheduled.filter((s) => s.at > t);
        for (const s of due) send(s.req);
      }
    }
    // The server completes attempts in order, whether or not anyone still waits for them.
    serverCredit += capacityNow() / 1000;
    while (serverCredit >= 1 && queued() > 0) {
      serverCredit -= 1;
      const a = queue[qHead++];
      if (a.timedOut) {
        bucket().wasted++;
      } else {
        a.timedOut = true; // answered: no longer waiting
        a.req.done = true;
        bucket().ok++;
      }
    }
    if (queued() === 0) serverCredit = Math.min(serverCredit, 1);
    if (qHead > 2000) {
      queue = queue.slice(qHead);
      qHead = 0;
    }
    // Client-side timeouts.
    while (iHead < inflight.length && inflight[iHead].sentAt + TIMEOUT_MS <= t) {
      const a = inflight[iHead++];
      if (!a.timedOut) {
        a.timedOut = true;
        fail(a.req);
      }
    }
    if (iHead > 2000) {
      inflight = inflight.slice(iHead);
      iHead = 0;
    }
    if (t === triggerStart && triggerEnd > triggerStart) note(`trigger: the server drops to half capacity for ${p.trigger} s`, true);
    if (t === triggerEnd && triggerEnd > triggerStart) note('trigger over: the server is back to full capacity', true);
  }

  function recent(): { first: number; retry: number; ok: number; wasted: number } {
    const r = { first: 0, retry: 0, ok: 0, wasted: 0 };
    for (const b of buckets) {
      if (b.at >= t - RECENT_MS) {
        r.first += b.first;
        r.retry += b.retry;
        r.ok += b.ok;
        r.wasted += b.wasted;
      }
    }
    return r;
  }

  function state(): { label: string; tone: 'ok' | 'warn' | 'bad' } {
    if (t < triggerStart) return { label: t < TRIGGER_AT ? 'healthy: waiting for the trigger at 5 s' : 'healthy', tone: 'ok' };
    if (t < triggerEnd) return { label: 'trigger: server at half capacity', tone: 'warn' };
    const r = recent();
    const served = r.ok / Math.max(1, r.first);
    const wait = queued() / CAPACITY;
    if (t - triggerEnd < 3000) return { label: 'trigger over: does it recover?', tone: 'warn' };
    if (served > 0.95 && wait < 0.5) return { label: 'recovered', tone: 'ok' };
    return { label: `trigger ended ${Math.round((t - triggerEnd) / 1000)} s ago: still failing`, tone: 'bad' };
  }

  // Chart geometry.
  const X0 = 34;
  const X1 = 396;
  const Y0 = 34; // top of the plot
  const Y1 = 164; // baseline
  const YMAX = 320; // attempts per second at the top of the plot
  const ys = (perSec: number) => Y1 - (Math.min(perSec, YMAX) / YMAX) * (Y1 - Y0);
  const xs = (at: number) => X1 - ((t - at) / WINDOW_MS) * (X1 - X0);

  return {
    params: [
      { name: 'policy', label: 'Retry policy', min: 0, max: 3, step: 1, value: 2, format: (v) => POLICIES[v] },
      { name: 'retries', label: 'Retries per request', min: 1, max: 5, step: 1, value: 3 },
      { name: 'load', label: 'Normal load', min: 30, max: 95, step: 5, value: 70, unit: '% of capacity' },
      { name: 'trigger', label: 'Trigger length', min: 0, max: 10, step: 1, value: 6, unit: 's' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      queue = [];
      qHead = 0;
      inflight = [];
      iHead = 0;
      scheduled = [];
      serverCredit = 0;
      tokens = BUDGET_MAX;
      buckets = [];
      deniedByBudget = 0;
      lastLog = -Infinity;
      triggerStart = TRIGGER_AT;
      triggerEnd = triggerStart + p.trigger * 1000;
      nextArrival = rng.exponential(1000 / ((p.load / 100) * CAPACITY));
      const worst = (p.load / 100) * CAPACITY * (p.policy === 0 ? 1 : p.policy === 3 ? 1 + BUDGET_RATIO : p.retries + 1);
      lastEvent = `${(p.load / 100) * CAPACITY} new requests/s against a capacity of ${CAPACITY}/s. If every attempt fails, this policy sends up to ${Math.round(worst)} attempts/s.`;
    },

    step(dt) {
      const end = t + dt;
      while (t < end) advance();
    },

    render(view) {
      const axes = layer(view, 'axes');
      if (!axes.childNodes.length) {
        text('attempts per second, last 20 s', { x: 4, y: 18, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, axes);
        svg('line', { x1: X0, y1: Y1, x2: X1, y2: Y1, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, axes);
        for (const v of [100, 200, 300]) {
          text(v, { x: X0 - 4, y: ys(v) + 5, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-muted') }, axes);
          svg('line', { x1: X0, y1: ys(v), x2: X1, y2: ys(v), stroke: token('--viz-stroke'), 'stroke-width': 0.6, 'stroke-dasharray': '2 4' }, axes);
        }
        // Legend.
        const ly = 286;
        svg('rect', { x: 4, y: ly - 11, width: 14, height: 12, rx: 2, fill: token('--viz-flow-soft'), stroke: token('--viz-flow'), 'stroke-width': 1.2 }, axes);
        text('first tries', { x: 22, y: ly, 'font-size': 15, fill: token('--viz-muted') }, axes);
        svg('rect', { x: 104, y: ly - 11, width: 14, height: 12, rx: 2, fill: token('--viz-warn-soft'), stroke: token('--viz-warn'), 'stroke-width': 1.2 }, axes);
        text('retries', { x: 122, y: ly, 'font-size': 15, fill: token('--viz-muted') }, axes);
        svg('line', { x1: 184, y1: ly - 5, x2: 204, y2: ly - 5, stroke: token('--viz-ok'), 'stroke-width': 3 }, axes);
        text('succeeded', { x: 208, y: ly, 'font-size': 15, fill: token('--viz-muted') }, axes);
        svg('line', { x1: 290, y1: ly - 5, x2: 310, y2: ly - 5, stroke: token('--viz-bad'), 'stroke-width': 2, 'stroke-dasharray': '5 3' }, axes);
        text('capacity', { x: 314, y: ly, 'font-size': 15, fill: token('--viz-muted') }, axes);
      }

      const live = layer(view, 'live');
      clear(live);

      // Trigger window.
      if (triggerEnd > triggerStart && t >= triggerStart) {
        const a = Math.max(X0, xs(triggerStart));
        const b = Math.min(X1, xs(Math.min(t, triggerEnd)));
        if (b > a) {
          svg('rect', { x: a, y: Y0 - 6, width: b - a, height: Y1 - Y0 + 6, fill: token('--viz-bad-soft'), opacity: 0.45 }, live);
          text('trigger', { x: a + 3, y: Y0 + 8, 'font-size': 15, fill: token('--viz-bad') }, live);
        }
      }

      // Stacked bars: first tries and retries per second, per half-second bucket.
      const w = ((X1 - X0) * BUCKET_MS) / WINDOW_MS - 1.5;
      const scale = 1000 / BUCKET_MS;
      let okPath = '';
      for (const b of buckets) {
        const x = xs(b.at + BUCKET_MS);
        if (x - w < X0) continue;
        const fy = ys(b.first * scale);
        const ry = ys((b.first + b.retry) * scale);
        svg('rect', { x: x - w, y: fy, width: w, height: Y1 - fy, fill: token('--viz-flow-soft'), stroke: token('--viz-flow'), 'stroke-width': 0.8 }, live);
        if (b.retry) svg('rect', { x: x - w, y: ry, width: w, height: fy - ry, fill: token('--viz-warn-soft'), stroke: token('--viz-warn'), 'stroke-width': 0.8 }, live);
        okPath += `${okPath ? 'L' : 'M'}${(x - w / 2).toFixed(1)} ${ys(b.ok * scale).toFixed(1)}`;
      }
      if (okPath) svg('path', { d: okPath, fill: 'none', stroke: token('--viz-ok'), 'stroke-width': 3, 'stroke-linejoin': 'round' }, live);

      // Capacity line: 100/s, dipping to 50/s during the trigger.
      const segs: [number, number, number][] = [];
      const from = Math.max(0, t - WINDOW_MS);
      const edges = [from, triggerStart, triggerEnd, t].filter((v) => v >= from && v <= t).sort((m, n) => m - n);
      for (let i = 0; i < edges.length - 1; i++) {
        const mid = (edges[i] + edges[i + 1]) / 2;
        const cap = mid >= triggerStart && mid < triggerEnd ? CAPACITY / 2 : CAPACITY;
        segs.push([xs(edges[i]), xs(edges[i + 1]), cap]);
      }
      let capPath = '';
      for (const [a, b, cap] of segs) capPath += `${capPath ? 'L' : 'M'}${a.toFixed(1)} ${ys(cap)}L${b.toFixed(1)} ${ys(cap)}`;
      if (capPath) svg('path', { d: capPath, fill: 'none', stroke: token('--viz-bad'), 'stroke-width': 2, 'stroke-dasharray': '5 3' }, live);

      // Queue: how long a new attempt would wait, against the 1 s clients wait.
      const waitMs = (queued() / capacityNow()) * 1000;
      const qy = 196;
      text('Queue wait', { x: 4, y: qy, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, live);
      const QX = 100;
      const QW = 296;
      const maxWait = 8000;
      svg('rect', { x: QX, y: qy - 14, width: QW, height: 18, rx: 3, fill: token('--viz-surface'), stroke: token('--viz-stroke'), 'stroke-width': 1.2 }, live);
      const fillW = (Math.min(waitMs, maxWait) / maxWait) * QW;
      const tone = waitMs > TIMEOUT_MS ? 'bad' : waitMs > TIMEOUT_MS / 2 ? 'warn' : 'flow';
      if (fillW > 0) svg('rect', { x: QX, y: qy - 14, width: fillW, height: 18, rx: 3, fill: token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.2 }, live);
      const tx = QX + (TIMEOUT_MS / maxWait) * QW;
      svg('line', { x1: tx, y1: qy - 20, x2: tx, y2: qy + 8, stroke: token('--viz-ink'), 'stroke-width': 1.5 }, live);
      text(`${formatMs(waitMs)}${waitMs > TIMEOUT_MS ? ': every answer comes too late' : ''}`, {
        x: QX, y: qy + 24, 'font-size': 15, fill: waitMs > TIMEOUT_MS ? token('--viz-bad') : token('--viz-muted'),
      }, live);
      text('1 s', { x: tx + 3, y: qy - 20, 'font-size': 12, fill: token('--viz-muted') }, live);

      const s = state();
      text(s.label, { x: 4, y: 254, 'font-size': 17, 'font-weight': 700, fill: token(`--viz-${s.tone}`) }, live);
    },

    stats() {
      const r = recent();
      const served = r.ok + r.wasted;
      return {
        'model time': formatMs(t),
        'requests answered in time (last 5 s)': r.first ? `${Math.min(100, Math.round((r.ok / r.first) * 100))}%` : '–',
        'attempts per request (last 5 s)': r.first ? ((r.first + r.retry) / r.first).toFixed(2) : '–',
        'server work wasted on abandoned attempts': served ? `${Math.round((r.wasted / served) * 100)}%` : '–',
        ...(policy() === 3 ? { 'retries refused by the budget': deniedByBudget } : {}),
      };
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Trigger again now',
        run() {
          // A new trigger of the chosen length (at least 1 s), starting now.
          triggerStart = t + 1;
          triggerEnd = triggerStart + Math.max(1, p.trigger) * 1000;
        },
      },
    ],
  };
};
