// Four eviction policies on the same request stream: LRU, LFU (no aging), W-TinyLFU
// (simplified) and S3-FIFO. The same policies as examples/caching-strategies/policies.py.
// Traffic: KEYS keys with Zipf popularity (skew s), plus an optional batch job that reads keys
// nobody else reads. The action flips popularity: the coldest keys become the hottest.
// Each lane plots its hit ratio on the normal traffic (not the batch job's reads) over time.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const KEYS = 2000;
const PER_MS = 10; // requests per simulated millisecond: 10,000 req/s
const BUCKET_MS = 250;
const HISTORY = 80; // 20 s on the chart
const ROLLING = 4000; // requests in the headline hit ratio

interface Policy {
  access(key: number): boolean;
}

function mix(x: number): number {
  x >>>= 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const first = <K>(map: Map<K, unknown>): K => map.keys().next().value as K;

function lru(capacity: number): Policy {
  const items = new Map<number, true>();
  return {
    access(key) {
      if (items.delete(key)) {
        items.set(key, true);
        return true;
      }
      items.set(key, true);
      if (items.size > capacity) items.delete(first(items));
      return false;
    },
  };
}

function lfu(capacity: number): Policy {
  const count = new Map<number, number>();
  const buckets = new Map<number, Map<number, true>>();
  let min = 0;
  const bucket = (c: number) => {
    let b = buckets.get(c);
    if (!b) buckets.set(c, (b = new Map()));
    return b;
  };
  return {
    access(key) {
      const c = count.get(key);
      if (c !== undefined) {
        const b = buckets.get(c)!;
        b.delete(key);
        if (!b.size) {
          buckets.delete(c);
          if (min === c) min = c + 1;
        }
        count.set(key, c + 1);
        bucket(c + 1).set(key, true);
        return true;
      }
      if (count.size >= capacity) {
        const b = buckets.get(min)!;
        const victim = first(b);
        b.delete(victim);
        if (!b.size) buckets.delete(min);
        count.delete(victim);
      }
      count.set(key, 1);
      bucket(1).set(key, true);
      min = 1;
      return false;
    },
  };
}

function wTinyLfu(capacity: number): Policy {
  const windowCap = Math.max(1, Math.floor(capacity / 100));
  const mainCap = capacity - windowCap;
  const protectedCap = Math.floor((mainCap * 8) / 10);
  const win = new Map<number, true>();
  const probation = new Map<number, true>();
  const prot = new Map<number, true>();
  let width = 1;
  while (width < capacity * 4) width *= 2;
  const rows = Array.from({ length: 4 }, () => new Uint8Array(width));
  let added = 0;
  const resetAt = 10 * capacity;
  const slot = (key: number, i: number) => mix(key * 4 + i) & (width - 1);
  const estimate = (key: number) => {
    let m = 15;
    for (let i = 0; i < 4; i++) m = Math.min(m, rows[i][slot(key, i)]);
    return m;
  };
  return {
    access(key) {
      for (let i = 0; i < 4; i++) {
        const j = slot(key, i);
        if (rows[i][j] < 15) rows[i][j] += 1;
      }
      if (++added >= resetAt) {
        for (const row of rows) for (let j = 0; j < row.length; j++) row[j] >>= 1;
        added = Math.floor(added / 2);
      }
      for (const area of [win, prot]) {
        if (area.delete(key)) {
          area.set(key, true);
          return true;
        }
      }
      if (probation.delete(key)) {
        prot.set(key, true);
        if (prot.size > protectedCap) {
          const demoted = first(prot);
          prot.delete(demoted);
          probation.set(demoted, true);
        }
        return true;
      }
      win.set(key, true);
      if (win.size > windowCap) {
        const candidate = first(win);
        win.delete(candidate);
        if (probation.size + prot.size < mainCap) probation.set(candidate, true);
        else {
          const area = probation.size ? probation : prot;
          const victim = first(area);
          if (estimate(candidate) > estimate(victim)) {
            area.delete(victim);
            probation.set(candidate, true);
          }
        }
      }
      return false;
    },
  };
}

function s3Fifo(capacity: number): Policy {
  const smallCap = Math.max(1, Math.floor(capacity / 10));
  const ghostCap = capacity - smallCap;
  // Arrays used as queues with a moving head, so popping the front is O(1).
  let small: number[] = [];
  let sHead = 0;
  let main: number[] = [];
  let mHead = 0;
  const freq = new Map<number, number>();
  const ghost = new Map<number, true>();
  const sLen = () => small.length - sHead;
  const mLen = () => main.length - mHead;
  const compact = () => {
    if (sHead > 4096) (small = small.slice(sHead)), (sHead = 0);
    if (mHead > 4096) (main = main.slice(mHead)), (mHead = 0);
  };
  const evictSmall = () => {
    const key = small[sHead++];
    if (freq.get(key)! > 0) {
      freq.set(key, 0);
      main.push(key);
    } else {
      freq.delete(key);
      ghost.set(key, true);
      if (ghost.size > ghostCap) ghost.delete(first(ghost));
    }
  };
  const evictMain = () => {
    for (;;) {
      const key = main[mHead++];
      const f = freq.get(key)!;
      if (f > 0) {
        freq.set(key, f - 1);
        main.push(key);
      } else {
        freq.delete(key);
        return;
      }
    }
  };
  return {
    access(key) {
      const f = freq.get(key);
      if (f !== undefined) {
        freq.set(key, Math.min(f + 1, 3));
        return true;
      }
      while (sLen() + mLen() >= capacity) {
        if (sLen() >= smallCap || !mLen()) evictSmall();
        else evictMain();
      }
      compact();
      freq.set(key, 0);
      if (ghost.delete(key)) main.push(key);
      else small.push(key);
      return false;
    },
  };
}

const LANES = [
  { title: 'LRU', make: lru },
  { title: 'LFU, no aging', make: lfu },
  { title: 'W-TinyLFU', make: wTinyLfu },
  { title: 'S3-FIFO', make: s3Fifo },
];

interface Lane {
  policy: Policy;
  recent: Uint8Array; // ring of the last ROLLING normal requests: 1 = hit
  at: number;
  filled: number;
  hits: number;
  buckets: { hit: number; all: number }[];
}

export const createEvictionModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let cdf: Float64Array;
  let flipped = false;
  let scanKey = KEYS;
  let scanCredit = 0;
  let best = 0;
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;

  function rank(): number {
    const u = rng.next();
    let lo = 0;
    let hi = KEYS;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (u < cdf[mid]) hi = mid;
      else lo = mid + 1;
    }
    return Math.min(lo, KEYS - 1);
  }

  function request(): void {
    scanCredit += p.scan / 100;
    while (scanCredit >= 1) {
      scanCredit -= 1;
      const key = scanKey++;
      for (const lane of lanes) lane.policy.access(key);
    }
    const r = rank();
    const key = flipped ? KEYS - 1 - r : r;
    const b = Math.floor(t / BUCKET_MS);
    for (const lane of lanes) {
      const hit = lane.policy.access(key) ? 1 : 0;
      lane.hits += hit - lane.recent[lane.at];
      lane.recent[lane.at] = hit;
      lane.at = (lane.at + 1) % ROLLING;
      lane.filled = Math.min(ROLLING, lane.filled + 1);
      while (lane.buckets.length <= b) lane.buckets.push({ hit: 0, all: 0 });
      lane.buckets[b].hit += hit;
      lane.buckets[b].all += 1;
    }
  }

  const ratio = (lane: Lane) => (lane.filled ? lane.hits / lane.filled : 0);

  return {
    params: [
      { name: 'size', label: 'Cache size', min: 1, max: 20, step: 1, value: 5, unit: '% of keys' },
      { name: 'skew', label: 'Popularity skew', min: 0.6, max: 1.2, step: 0.1, value: 1, unit: '' },
      { name: 'scan', label: 'Batch job reads', min: 0, max: 150, step: 25, value: 0, unit: '% of traffic' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      flipped = false;
      scanKey = KEYS;
      scanCredit = 0;
      cdf = new Float64Array(KEYS);
      let total = 0;
      for (let k = 1; k <= KEYS; k++) {
        total += Math.pow(k, -p.skew);
        cdf[k - 1] = total;
      }
      for (let k = 0; k < KEYS; k++) cdf[k] /= total;
      const capacity = Math.max(4, Math.round((KEYS * p.size) / 100));
      best = cdf[capacity - 1];
      lanes = LANES.map((l) => ({
        policy: l.make(capacity),
        recent: new Uint8Array(ROLLING),
        at: 0,
        filled: 0,
        hits: 0,
        buckets: [],
      }));
      lastEvent = `${KEYS} keys, cache of ${capacity}. The best possible static cache hits ${(100 * best).toFixed(1)}%.`;
    },

    step(dt) {
      const end = t + dt;
      const n = Math.round(dt * PER_MS);
      for (let i = 0; i < n; i++) {
        t += dt / n;
        request();
      }
      t = end;
    },

    actions: [
      {
        label: 'Flip popularity',
        run() {
          flipped = !flipped;
          lastEvent = `t=${(t / 1000).toFixed(1)}s popularity flipped: the coldest keys are now the hottest`;
        },
      },
    ],

    render(view) {
      const laneH = 76;
      const base = layer(view, 'base');
      const live = layer(view, 'live');
      clear(live);
      const left = 4;
      const right = 396;
      const chartH = 44;
      if (!base.childElementCount) {
        LANES.forEach((l, li) => {
          const top = li * laneH;
          text(l.title, { x: left, y: top + 18, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base);
          svg('line', { x1: left, y1: top + 24 + chartH, x2: right, y2: top + 24 + chartH, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
        });
        text('hit ratio of normal traffic, last 20 s; dashed: best static cache', { x: 200, y: 4 * laneH + 14, 'font-size': 14, 'text-anchor': 'middle', fill: token('--viz-muted') }, base);
      }
      const current = Math.floor(t / BUCKET_MS);
      const top = Math.max(...lanes.map(ratio));
      lanes.forEach((lane, li) => {
        const y0 = li * laneH + 24;
        const r = ratio(lane);
        const tone = !lane.filled ? 'muted' : r >= top - 0.02 ? 'ok' : r >= top - 0.08 ? 'warn' : 'bad';
        text(lane.filled ? `${(100 * r).toFixed(1)}% hits` : '—', {
          x: right, y: li * laneH + 18, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'end', fill: token(`--viz-${tone === 'muted' ? 'muted' : tone}`),
        }, live);
        const by = y0 + chartH - chartH * best;
        svg('line', { x1: left, y1: by, x2: right, y2: by, stroke: token('--viz-muted'), 'stroke-width': 1.2, 'stroke-dasharray': '4 4' }, live);
        const points: string[] = [];
        for (let i = 0; i < HISTORY; i++) {
          const b = current - HISTORY + 1 + i;
          const bucket = lane.buckets[b];
          if (b < 0 || !bucket || !bucket.all) continue;
          const x = left + ((right - left) * i) / (HISTORY - 1);
          const y = y0 + chartH - (chartH * bucket.hit) / bucket.all;
          points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        if (points.length > 1) svg('polyline', { points: points.join(' '), fill: 'none', stroke: token('--viz-flow'), 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, live);
      });
    },

    stats() {
      const out: Record<string, string> = { time: `${(t / 1000).toFixed(1)} s` };
      const misses = lanes.map((l) => 1 - ratio(l));
      const lowest = Math.min(...misses);
      LANES.forEach((l, i) => {
        out[`${l.title}: DB reads`] = lanes[i].filled && lowest > 0 ? `${(misses[i] / lowest).toFixed(2)}×` : '—';
      });
      out['popularity'] = flipped ? 'flipped' : 'original';
      return out;
    },

    log: () => lastEvent,
  };
};
