// Rate limiter sim: one traffic generator feeding one algorithm, or all five side by side.
//
// config.algorithm picks the mode: 'token-bucket' | 'leaky-bucket' | 'fixed-window' |
// 'sliding-log' | 'sliding-counter' | 'compare'. Background traffic is a seeded Poisson stream
// kept under the limit, so nothing is rejected until the reader presses a button.
import { clear, layer, percent, stamp, svg, text, token } from '../../sim/svg';
import type { ParamSpec, Rng, SimFactory } from '../../sim/types';
import {
  FixedWindow,
  LeakyBucketQueue,
  SlidingLog,
  SlidingWindowCounter,
  TokenBucket,
  makeLimiter,
  type AlgorithmId,
  type Limiter,
} from './algorithms';

type Mode = AlgorithmId | 'compare';

const ALGORITHMS: { id: AlgorithmId; short: string }[] = [
  { id: 'token-bucket', short: 'Token' },
  { id: 'leaky-bucket', short: 'Leaky' },
  { id: 'fixed-window', short: 'Fixed' },
  { id: 'sliding-log', short: 'Log' },
  { id: 'sliding-counter', short: 'Counter' },
];

/** What happened to the requests one limiter saw. Times are in seconds. */
interface Track {
  limiter: Limiter;
  accepted: number[]; // when each accepted request reached the API
  rejected: number[];
  peak: number; // most accepted in any span of `peakSpan` seconds
  waitTotal: number;
}

/** A request dot travelling across the picture (single-algorithm modes only). */
interface Sprite {
  id: number;
  born: number; // ms
  allowed: boolean;
  departAt: number; // ms: when it leaves the limiter towards the API
}

const TRAVEL = 260; // ms for a dot to cross one half of the picture
const INK = token('--viz-ink');
const MUTED = token('--viz-muted');

const bucketParams = (capacityLabel: string, rateLabel: string, capacity: number): ParamSpec[] => [
  { name: 'capacity', label: capacityLabel, min: 2, max: 20, step: 1, value: capacity },
  { name: 'rate', label: rateLabel, min: 0.5, max: 5, step: 0.5, value: 1, unit: 'req/s' },
  { name: 'traffic', label: 'Background traffic', min: 0, max: 6, step: 0.1, value: 0.6, unit: 'req/s' },
];

/** `traffic` defaults to 0 where an empty window makes the boundary effect exact. */
const windowParams = (traffic: number): ParamSpec[] => [
  { name: 'limit', label: 'Limit per window', min: 2, max: 20, step: 1, value: 10 },
  { name: 'window', label: 'Window', min: 2, max: 20, step: 1, value: 10, unit: 's' },
  { name: 'traffic', label: 'Background traffic', min: 0, max: 6, step: 0.1, value: traffic, unit: 'req/s' },
];

export const createRateLimiterModel: SimFactory = (config) => {
  const mode = (config.algorithm as Mode) ?? 'token-bucket';
  const isCompare = mode === 'compare';
  const isWindow = mode === 'fixed-window' || mode === 'sliding-log' || mode === 'sliding-counter' || isCompare;

  const params: ParamSpec[] =
    mode === 'token-bucket'
      ? bucketParams('Bucket size', 'Refill rate', 10)
      : mode === 'leaky-bucket'
        ? bucketParams('Queue size', 'Leak rate', 8)
        : windowParams(mode === 'fixed-window' || isCompare ? 0 : 0.3);

  let rng: Rng;
  let p: Record<string, number> = {};
  let t = 0; // ms
  let nextPoisson = Infinity;
  let scheduled: number[] = []; // ms, sorted
  let nextId = 1;
  let tracks: Track[] = [];
  let sprites: Sprite[] = [];
  let lastEvent: string | null = null;
  let window = 10; // seconds: the window, or capacity / rate for buckets
  let peakSpan = 10;
  let span = 20; // seconds of history the timeline shows

  function newTrack(limiter: Limiter): Track {
    return { limiter, accepted: [], rejected: [], peak: 0, waitTotal: 0 };
  }

  function record(track: Track, at: number): void {
    track.accepted.push(at);
    let inSpan = 0;
    for (let i = track.accepted.length - 1; i >= 0 && track.accepted[i] > at - peakSpan + 1e-9; i--) inSpan++;
    track.peak = Math.max(track.peak, inSpan);
  }

  function arrive(atMs: number): void {
    const id = nextId++;
    const now = atMs / 1000;
    const verdicts: string[] = [];
    for (const track of tracks) {
      const o = track.limiter.tryAcquire(now);
      if (o.allowed) {
        record(track, now + o.delay);
        track.waitTotal += o.delay;
      } else {
        track.rejected.push(now);
      }
      verdicts.push(o.allowed ? 'ok' : 'no');
      if (!isCompare) {
        sprites.push({ id, born: atMs, allowed: o.allowed, departAt: atMs + TRAVEL + o.delay * 1000 });
        lastEvent = `${stamp(atMs)} #${id} ${o.allowed ? 'accepted' : 'rejected'}: ${o.note}`;
      }
    }
    if (isCompare) {
      const by = (v: string) => ALGORITHMS.filter((_, i) => verdicts[i] === v).map((a) => a.short.toLowerCase());
      const no = by('no');
      lastEvent = `${stamp(atMs)} #${id} ` + (no.length ? `rejected by ${no.join(', ')}` : 'accepted by all five');
    }
  }

  function prune(): void {
    const keep = t / 1000 - span - peakSpan;
    for (const tr of tracks) {
      while (tr.accepted.length && tr.accepted[0] < keep) tr.accepted.shift();
      while (tr.rejected.length && tr.rejected[0] < keep) tr.rejected.shift();
    }
    sprites = sprites.filter((s) => t - (s.allowed ? s.departAt : s.born + TRAVEL) < TRAVEL + 200);
  }

  function schedule(times: number[]): void {
    scheduled = [...scheduled, ...times].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- drawing helpers

  const X0 = isCompare ? 100 : 8;
  const X1 = 392;
  const xAt = (sec: number) => X0 + ((sec - (t / 1000 - span)) / span) * (X1 - X0);

  function accept(cx: number, cy: number, parent: Element, r = 5): void {
    svg('circle', { cx, cy, r, fill: token('--viz-ok') }, parent);
  }

  function reject(cx: number, cy: number, parent: Element, h = 5): void {
    svg('path', {
      d: `M${cx - h} ${cy - h} l${2 * h} ${2 * h} M${cx + h} ${cy - h} l${-2 * h} ${2 * h}`,
      stroke: token('--viz-bad'), 'stroke-width': 2.5, 'stroke-linecap': 'round',
    }, parent);
  }

  /** Window boundaries as dashed lines between y1 and y2. */
  function boundaries(y1: number, y2: number, parent: Element): void {
    const now = t / 1000;
    for (let b = Math.ceil((now - span) / window) * window; b <= now; b += window) {
      const x = xAt(b);
      if (x < X0) continue;
      svg('line', { x1: x, x2: x, y1, y2, stroke: MUTED, 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, parent);
    }
  }

  /**
   * The history strip: accepted dots above the line, rejected crosses below. Marks that land
   * almost on top of each other stack (accepted upwards, rejected downwards, up to a cap), so a
   * burst reads as a column whose height you can see, not one blob.
   */
  function timeline(track: Track, yOk: number, yBad: number, parent: Element, gap = 0, capOk = 1, capBad = 1): void {
    const now = t / 1000;
    const marks = (times: number[], cap: number, draw: (x: number, depth: number) => void) => {
      let anchor = -Infinity; // x of the column we are stacking onto
      let depth = 0;
      for (const time of times) {
        const x = xAt(time);
        if (time > now || x < X0) continue;
        if (x - anchor < 4) {
          depth = Math.min(depth + 1, cap - 1);
        } else {
          anchor = x;
          depth = 0;
        }
        draw(anchor, depth);
      }
    };
    marks(track.accepted, capOk, (x, d) => accept(x, yOk - d * gap, parent, 4.5));
    marks(track.rejected, capBad, (x, d) => reject(x, yBad + d * gap, parent, 4.5));
  }

  // Single-mode layout on a 400 × 300 canvas.
  const GATE_IN = 136; // where dots enter the limiter
  const GATE_OUT = 264; // where accepted dots leave it
  const LANE = 104;

  function drawSprites(parent: Element): void {
    for (const s of sprites) {
      const age = t - s.born;
      if (age < 0) continue;
      if (age < TRAVEL) {
        svg('circle', { cx: 14 + (GATE_IN - 14) * (age / TRAVEL), cy: LANE, r: 6, fill: token('--viz-flow') }, parent);
        continue;
      }
      if (!s.allowed) {
        const k = Math.min(1, (age - TRAVEL) / TRAVEL);
        const g = svg('g', { opacity: 1 - k }, parent);
        reject(GATE_IN - 10 - 40 * k, LANE + 50 * k, g, 6);
        continue;
      }
      const out = t - s.departAt;
      if (out >= 0 && out < TRAVEL) {
        svg('circle', { cx: GATE_OUT + (386 - GATE_OUT) * (out / TRAVEL), cy: LANE, r: 6, fill: token('--viz-ok') }, parent);
      }
    }
  }

  function header(label: string, parent: Element): void {
    text(label, { x: 200, y: 26, 'text-anchor': 'middle', fill: INK, 'font-size': 19, 'font-weight': 600 }, parent);
  }

  function drawMechanism(parent: Element): void {
    const now = t / 1000;
    const lim = tracks[0].limiter;
    if (lim instanceof TokenBucket) {
      const level = lim.level(now);
      header(`${Math.floor(level + 1e-9)} of ${lim.capacity} tokens`, parent);
      svg('path', { d: 'M150 58 V150 H250 V58', fill: 'none', stroke: token('--viz-server'), 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, parent);
      for (let i = 0; i < lim.capacity; i++) {
        const col = i % 5;
        const row = Math.floor(i / 5);
        const filled = i < Math.floor(level + 1e-9);
        svg('circle', {
          cx: 160 + col * 20, cy: 140 - row * 20, r: 7,
          fill: filled ? token('--viz-store') : 'none',
          stroke: filled ? token('--viz-store') : token('--viz-stroke'), 'stroke-width': 1.5,
        }, parent);
      }
      // The next token growing in, so the refill is visible between whole tokens.
      if (level < lim.capacity) {
        const frac = level - Math.floor(level);
        svg('circle', { cx: 200, cy: 46, r: 2 + 5 * frac, fill: token('--viz-store-soft'), stroke: token('--viz-store'), 'stroke-width': 1.5 }, parent);
      }
    } else if (lim instanceof LeakyBucketQueue) {
      const waiting = lim.waiting(now);
      const shown = Math.min(lim.capacity, Math.ceil(waiting - 1e-9));
      header(`${shown} of ${lim.capacity} waiting`, parent);
      const w = 128 / lim.capacity;
      for (let i = 0; i < lim.capacity; i++) {
        const filled = i >= lim.capacity - shown; // the queue drains from the right
        svg('rect', {
          x: GATE_IN + i * w + 1, y: LANE - 18, width: w - 2, height: 36, rx: 3,
          fill: filled ? token('--viz-warn-soft') : 'none',
          stroke: filled ? token('--viz-warn') : token('--viz-stroke'), 'stroke-width': 1.5,
        }, parent);
      }
      text(`leaks ${lim.rate} per s →`, { x: 200, y: 150, 'text-anchor': 'middle', fill: MUTED, 'font-size': 19 }, parent);
    } else if (lim instanceof FixedWindow) {
      const count = lim.countAt(now);
      const into = now - Math.floor(now / lim.window) * lim.window;
      header(`window resets in ${(lim.window - into).toFixed(1)} s`, parent);
      svg('rect', { x: GATE_IN, y: 64, width: 128, height: 80, rx: 8, fill: token('--viz-server-soft'), stroke: token('--viz-server'), 'stroke-width': 2 }, parent);
      text(`${count} / ${lim.limit}`, { x: 200, y: 108, 'text-anchor': 'middle', fill: INK, 'font-size': 28, 'font-weight': 700 }, parent);
      svg('rect', { x: GATE_IN + 12, y: 124, width: 104, height: 8, rx: 4, fill: token('--viz-surface'), stroke: token('--viz-stroke') }, parent);
      svg('rect', { x: GATE_IN + 12, y: 124, width: (104 * into) / lim.window, height: 8, rx: 4, fill: MUTED }, parent);
    } else if (lim instanceof SlidingLog) {
      lim.prune(now);
      header(`${lim.log.length} of ${lim.limit} in the last ${lim.window} s`, parent);
      for (let i = 0; i < lim.limit; i++) {
        const filled = i < lim.log.length;
        svg('rect', {
          x: 150 + (i % 5) * 20, y: 130 - Math.floor(i / 5) * 22 - 8, width: 16, height: 14, rx: 2,
          fill: filled ? token('--viz-flow-soft') : 'none',
          stroke: filled ? token('--viz-flow') : token('--viz-stroke'), 'stroke-width': 1.5,
        }, parent);
      }
      text('stored timestamps', { x: 200, y: 160, 'text-anchor': 'middle', fill: MUTED, 'font-size': 19 }, parent);
    } else if (lim instanceof SlidingWindowCounter) {
      const est = lim.estimate(now);
      const wgt = lim.weight(now);
      header(`${lim.previousCount}×${wgt.toFixed(2)} + ${lim.currentCount} = ${est.toFixed(1)} of ${lim.limit}`, parent);
      const base = 150;
      const unit = 80 / lim.limit;
      const prevH = lim.previousCount * unit;
      // Previous window: the outline is its full count, the filled part is what still counts.
      svg('rect', { x: 146, y: base - prevH, width: 40, height: prevH, fill: 'none', stroke: MUTED, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, parent);
      svg('rect', { x: 146, y: base - prevH * wgt, width: 40, height: prevH * wgt, fill: token('--viz-flow-soft'), stroke: token('--viz-flow'), 'stroke-width': 1.5 }, parent);
      const curH = lim.currentCount * unit;
      svg('rect', { x: 214, y: base - curH, width: 40, height: curH, fill: token('--viz-flow-soft'), stroke: token('--viz-flow'), 'stroke-width': 1.5 }, parent);
      svg('line', { x1: 136, x2: 264, y1: base - 80, y2: base - 80, stroke: token('--viz-bad'), 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }, parent);
      svg('line', { x1: 136, x2: 264, y1: base, y2: base, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, parent);
      text('prev', { x: 166, y: 172, 'text-anchor': 'middle', fill: MUTED, 'font-size': 19 }, parent);
      text('now', { x: 234, y: 172, 'text-anchor': 'middle', fill: MUTED, 'font-size': 19 }, parent);
    }
  }

  function renderSingle(view: SVGSVGElement): void {
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      const label = { fill: MUTED, 'font-size': 19, 'font-weight': 600 };
      text('Clients', { ...label, x: 8, y: 26 }, base);
      text('API', { ...label, x: 392, y: 26, 'text-anchor': 'end' }, base);
      svg('line', { x1: 8, x2: 392, y1: 250, y2: 250, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
      text(`${span} s ago`, { x: 8, y: 294, fill: MUTED, 'font-size': 19 }, base);
      text('now', { x: 392, y: 294, fill: MUTED, 'font-size': 19, 'text-anchor': 'end' }, base);
    }
    const live = layer(view, 'live');
    clear(live);
    const now = t / 1000;
    const tr = tracks[0];
    if (mode === 'sliding-log' || mode === 'sliding-counter') {
      // The sliding window itself: the last `window` seconds, ending now.
      svg('rect', { x: xAt(now - window), y: 192, width: xAt(now) - xAt(now - window), height: 86, fill: token('--viz-flow-soft') }, live);
    }
    if (isWindow) boundaries(192, 278, live);
    // Accepted marks stack up to 8 high, so a burst of 20 at a boundary shows as tall columns.
    timeline(tr, 238, 263, live, 5, 8, 3);
    drawMechanism(live);
    drawSprites(live);
  }

  function renderCompare(view: SVGSVGElement): void {
    const ROW = 46;
    const TOP = 40;
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      text(`Same traffic, last ${span} s`, { x: 8, y: 24, fill: MUTED, 'font-size': 19, 'font-weight': 600 }, base);
      ALGORITHMS.forEach((a, i) => {
        const y = TOP + i * ROW;
        text(a.short, { x: 8, y: y + 28, fill: INK, 'font-size': 19, 'font-weight': 600 }, base);
        svg('line', { x1: X0, x2: X1, y1: y + 24, y2: y + 24, stroke: token('--viz-stroke'), 'stroke-width': 1 }, base);
      });
    }
    const live = layer(view, 'live');
    clear(live);
    boundaries(TOP, TOP + ALGORITHMS.length * ROW - 4, live);
    tracks.forEach((tr, i) => timeline(tr, TOP + i * ROW + 13, TOP + i * ROW + 35, live));
  }

  return {
    params,

    reset(values, r) {
      rng = r;
      p = values;
      t = 0;
      nextId = 1;
      scheduled = [];
      sprites = [];
      if (mode === 'token-bucket') {
        tracks = [newTrack(new TokenBucket(p.capacity, p.rate))];
        window = p.capacity / p.rate;
        peakSpan = 1;
        span = 20;
      } else if (mode === 'leaky-bucket') {
        tracks = [newTrack(new LeakyBucketQueue(p.capacity, p.rate))];
        window = p.capacity / p.rate;
        peakSpan = 1;
        span = 20;
      } else {
        window = p.window;
        peakSpan = p.window;
        span = Math.max(20, 2 * p.window);
        const ids = isCompare ? ALGORITHMS.map((a) => a.id) : [mode as AlgorithmId];
        tracks = ids.map((id) => newTrack(makeLimiter(id, p.limit, p.window)));
      }
      nextPoisson = p.traffic > 0 ? rng.exponential(1000 / p.traffic) : Infinity;
      lastEvent = 'Press Play, then try the buttons. Step moves 100 ms at a time.';
    },

    step(dt) {
      t += dt;
      while (true) {
        const next = Math.min(nextPoisson, scheduled[0] ?? Infinity);
        if (next > t) break;
        if (next === nextPoisson) {
          arrive(nextPoisson);
          nextPoisson += rng.exponential(1000 / p.traffic);
        } else {
          arrive(scheduled.shift()!);
        }
      }
      prune();
    },

    render(view) {
      if (isCompare) renderCompare(view);
      else renderSingle(view);
    },

    stats() {
      const time = `${(t / 1000).toFixed(1)} s`;
      if (isCompare) {
        const out: Record<string, string> = { time };
        tracks.forEach((tr, i) => {
          out[`${ALGORITHMS[i].short}: most in ${peakSpan} s`] = String(tr.peak);
        });
        return out;
      }
      const tr = tracks[0];
      const total = tr.accepted.length + tr.rejected.length;
      const out: Record<string, string | number> = {
        time,
        accepted: tr.accepted.length,
        rejected: `${tr.rejected.length} (${percent(tr.rejected.length, total)})`,
        [`most in any ${peakSpan} s`]: tr.peak,
      };
      if (mode === 'leaky-bucket') {
        out['average wait'] = `${(tr.accepted.length ? tr.waitTotal / tr.accepted.length : 0).toFixed(1)} s`;
      }
      return out;
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Send a burst of 20',
        run() {
          schedule(Array.from({ length: 20 }, (_, i) => t + 1 + i * 15));
          lastEvent = `${stamp(t)} a burst of 20 requests is on its way`;
        },
      },
      ...(isWindow
        ? [
            {
              label: 'Hit the window boundary',
              run() {
                // The next boundary at least half a second away, so the "before" half fits.
                const w = window * 1000;
                let b = Math.ceil(t / w) * w;
                if (b - t < 500) b += w;
                const n = p.limit;
                const before = Array.from({ length: n }, (_, i) => b - 400 + (i * 300) / n);
                const after = Array.from({ length: n }, (_, i) => b + 20 + (i * 300) / n);
                schedule([...before, ...after]);
                lastEvent = `${stamp(t)} ${n} requests right before t=${(b / 1000).toFixed(0)}s and ${n} right after`;
              },
            },
          ]
        : []),
    ],
  };
};
