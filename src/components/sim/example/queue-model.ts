// A minimal reference SimModel: requests arrive at random, one server works through a bounded
// queue, and anything that arrives to a full queue is rejected. Copy this shape for topic sims.
import { layer, percent, stamp, svg, text, clear, token } from '../svg';
import type { Rng, SimFactory } from '../types';

interface Job {
  id: number;
  arrivedAt: number;
}

export const createQueueModel: SimFactory = () => {
  let rng: Rng;
  let p: Record<string, number> = {};
  let t = 0;
  let nextArrival = 0;
  let nextId = 1;
  let queue: Job[] = [];
  let inService: { job: Job; doneAt: number } | null = null;
  let accepted = 0;
  let rejected = 0;
  let served = 0;
  let recent: ('ok' | 'bad')[] = [];
  let lastEvent: string | null = null;

  function arrive(): void {
    const job = { id: nextId++, arrivedAt: t };
    if (queue.length >= p.capacity) {
      rejected++;
      recent.push('bad');
      lastEvent = `${stamp(t)} #${job.id} rejected: queue full (${queue.length}/${p.capacity})`;
    } else {
      accepted++;
      queue.push(job);
      lastEvent = `${stamp(t)} #${job.id} queued, ${queue.length} waiting`;
    }
    recent = recent.slice(-24);
  }

  return {
    params: [
      { name: 'arrivalRate', label: 'Arrivals', min: 1, max: 20, step: 1, value: 6, unit: 'req/s' },
      { name: 'serviceRate', label: 'Server speed', min: 1, max: 20, step: 1, value: 5, unit: 'req/s' },
      { name: 'capacity', label: 'Queue size', min: 1, max: 12, step: 1, value: 8 },
    ],

    reset(params, r) {
      rng = r;
      p = params;
      t = 0;
      nextId = 1;
      queue = [];
      inService = null;
      accepted = rejected = served = 0;
      recent = [];
      lastEvent = 'Press Play, or Step to move 100 ms at a time.';
      nextArrival = rng.exponential(1000 / p.arrivalRate);
    },

    step(dt) {
      t += dt;
      while (nextArrival <= t) {
        arrive();
        nextArrival += rng.exponential(1000 / p.arrivalRate);
      }
      if (inService && inService.doneAt <= t) {
        served++;
        recent.push('ok');
        lastEvent = `${stamp(t)} #${inService.job.id} served after ${Math.round(t - inService.job.arrivedAt)} ms`;
        inService = null;
      }
      if (!inService && queue.length > 0) {
        inService = { job: queue.shift()!, doneAt: t + 1000 / p.serviceRate };
      }
    },

    // Drawn on the default 400 × 240 canvas. Text is 19 units or larger, which renders at about
    // 14px on a 360px phone.
    render(view) {
      // Static layer: drawn once, kept between frames.
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        const label = { fill: token('--viz-ink'), 'font-size': 20, 'font-weight': 600 };
        text('Queue', { ...label, x: 12, y: 30 }, base);
        text('Server', { ...label, x: 290, y: 30 }, base);
        text('Last outcomes', { x: 12, y: 180, fill: token('--viz-muted'), 'font-size': 19 }, base);
      }

      // Moving layer: rebuilt every frame (well under 100 elements).
      const live = layer(view, 'live');
      clear(live);
      const slotW = 260 / p.capacity;
      for (let i = 0; i < p.capacity; i++) {
        const filled = i < queue.length;
        svg('rect', {
          x: 12 + i * slotW + 1.5, y: 44, width: slotW - 3, height: 56, rx: 4,
          fill: filled ? token('--viz-flow-soft') : 'none',
          stroke: filled ? token('--viz-flow') : token('--viz-stroke'),
          'stroke-width': 2,
        }, live);
      }
      svg('rect', {
        x: 290, y: 44, width: 98, height: 56, rx: 6,
        fill: inService ? token('--viz-ok-soft') : token('--viz-server-soft'),
        stroke: inService ? token('--viz-ok') : token('--viz-server'),
        'stroke-width': 2,
      }, live);
      text(inService ? `#${inService.job.id}` : 'idle', {
        x: 339, y: 79, 'text-anchor': 'middle', fill: token('--viz-ink'), 'font-size': 20,
      }, live);
      text(`${queue.length} of ${p.capacity} waiting`, { x: 12, y: 130, fill: token('--viz-muted'), 'font-size': 19 }, live);

      // Outcomes: shape and colour both carry the meaning (circle = served, cross = rejected).
      recent.slice(-16).forEach((r, i) => {
        const cx = 22 + i * 23.5;
        if (r === 'ok') svg('circle', { cx, cy: 212, r: 7, fill: token('--viz-ok') }, live);
        else svg('path', { d: `M${cx - 6} 206 l12 12 M${cx + 6} 206 l-12 12`, stroke: token('--viz-bad'), 'stroke-width': 3.5, 'stroke-linecap': 'round' }, live);
      });
    },

    stats() {
      const total = accepted + rejected;
      return {
        time: `${(t / 1000).toFixed(1)} s`,
        arrived: total,
        served,
        rejected: `${rejected} (${percent(rejected, total)})`,
      };
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Send a burst of 10',
        run() {
          for (let i = 0; i < 10; i++) arrive();
        },
      },
    ],
  };
};
