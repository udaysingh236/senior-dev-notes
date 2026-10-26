// Writes arrive at random and go to a backend whose every call costs a fixed overhead (a disk
// flush, a network round trip) plus a little per item. Two writers on the same arrivals:
//   one at a time   one backend call per write
//   batched         when the backend is free, take everything waiting (up to 100), but if only
//                   one or two are waiting, wait up to the batch window for more
// Both have one backend call in flight at a time.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const OVERHEAD = 2; // ms per backend call
const PER_ITEM = 0.05; // ms per item in a call
const MAX_BATCH = 100;
const SLOW = 10; // sim ms per model ms

class Writer {
  batched: boolean;
  queue: number[] = [];
  busyUntil = 0;
  inFlight: number[] = [];
  firstWaitAt = -1; // when the oldest waiting item arrived, for the window
  done = 0;
  latencySum = 0;
  recent: number[] = [];
  calls = 0;
  constructor(batched: boolean) {
    this.batched = batched;
  }

  advance(now: number, windowMs: number): void {
    // Finish the call in flight.
    if (this.inFlight.length && now >= this.busyUntil) {
      for (const a of this.inFlight) {
        const l = this.busyUntil - a;
        this.latencySum += l;
        this.recent.push(l);
      }
      this.done += this.inFlight.length;
      if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
      this.inFlight = [];
    }
    if (this.inFlight.length || !this.queue.length) return;
    const start = Math.max(now, this.busyUntil);
    if (!this.batched) {
      this.inFlight = [this.queue.shift()!];
    } else {
      const oldestWaited = start - this.queue[0];
      if (this.queue.length < 3 && oldestWaited < windowMs) return; // wait a little for company
      this.inFlight = this.queue.splice(0, MAX_BATCH);
    }
    this.calls++;
    this.busyUntil = start + OVERHEAD + PER_ITEM * this.inFlight.length;
  }

  meanRecent(): number {
    return this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : 0;
  }
}

export const createBatchModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let next = 0;
  let writers: Writer[] = [];
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'rate', label: 'Writes per second', min: 100, max: 3000, step: 100, value: 400 },
      { name: 'window', label: 'Batch window', min: 0, max: 10, step: 1, value: 2, unit: 'ms' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      writers = [new Writer(false), new Writer(true)];
      next = rng.exponential(1000 / p.rate);
      const cap = Math.round(1000 / (OVERHEAD + PER_ITEM));
      lastEvent = `One call at a time can do at most ${cap} writes a second (${OVERHEAD + PER_ITEM} ms each).`;
    },

    step(dt) {
      const end = t + dt / SLOW;
      const tick = 0.05; // model ms resolution
      while (t < end) {
        t = Math.min(end, t + tick);
        while (next <= t) {
          for (const w of writers) w.queue.push(next);
          next += rng.exponential(1000 / p.rate);
        }
        for (const w of writers) w.advance(t, p.window);
      }
    },

    render(view) {
      const laneH = 120;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        text('One backend call per write', { x: 4, y: 20, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, base);
        text('Batched', { x: 4, y: laneH + 20, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      writers.forEach((w, i) => {
        const y = i * laneH + 32;
        const backlog = w.queue.length;
        const cells = Math.min(backlog, 40);
        for (let k = 0; k < 40; k++) {
          svg('rect', { x: 4 + (k % 20) * 15, y: y + Math.floor(k / 20) * 15, width: 12, height: 12, rx: 2, fill: k < cells ? token('--viz-flow-soft') : 'none', stroke: k < cells ? token('--viz-flow') : token('--viz-stroke'), 'stroke-width': 1 }, live);
        }
        if (backlog > 40) text(`+${backlog - 40}`, { x: 306, y: y + 24, 'font-size': 16, 'font-weight': 700, fill: token('--viz-bad') }, live);
        svg('rect', { x: 330, y, width: 66, height: 27, rx: 5, fill: w.inFlight.length ? token('--viz-ok-soft') : token('--viz-server-soft'), stroke: w.inFlight.length ? token('--viz-ok') : token('--viz-server'), 'stroke-width': 1.5 }, live);
        text(w.inFlight.length ? `${w.inFlight.length} in call` : 'idle', { x: 363, y: y + 19, 'font-size': 13, 'text-anchor': 'middle', fill: token('--viz-ink') }, live);
        const tput = t ? Math.round((w.done / t) * 1000) : 0;
        const overloaded = backlog > 200;
        text(`${tput}/s done · latency ${formatMs(w.meanRecent())}${overloaded ? ' and growing' : ''}`, {
          x: 4, y: y + 56, 'font-size': 16, fill: overloaded ? token('--viz-bad') : token('--viz-muted'),
        }, live);
        if (w.batched && w.calls) text(`average batch ${(w.done / w.calls).toFixed(1)} writes`, { x: 4, y: y + 78, 'font-size': 15, fill: token('--viz-muted') }, live);
      });
    },

    stats() {
      const out: Record<string, string | number> = { 'model time': formatMs(t) };
      const [one, batch] = writers;
      out['one-at-a-time throughput'] = t ? `${Math.round((one.done / t) * 1000)}/s` : '–';
      out['one-at-a-time latency'] = formatMs(one.meanRecent());
      out['one-at-a-time backlog'] = one.queue.length;
      out['batched throughput'] = t ? `${Math.round((batch.done / t) * 1000)}/s` : '–';
      out['batched latency'] = formatMs(batch.meanRecent());
      return out;
    },

    log: () => lastEvent,
  };
};
