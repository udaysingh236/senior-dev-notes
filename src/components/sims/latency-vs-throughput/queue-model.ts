// One server, requests arriving at random (a Poisson stream). The reader sets utilisation (how
// busy the server is on average) and how much service times vary. The chart compares the
// measured mean latency with the M/G/1 formula: W = S + ρ·S·(1 + cv²) / (2·(1 − ρ)).
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const S = 10; // mean service time, ms
const SLOW = 4; // sim ms per model ms, so a 10 ms request is visible

export function theory(rho: number, cv: number): number {
  return rho >= 1 ? Infinity : S + (rho * S * (1 + cv * cv)) / (2 * (1 - rho));
}

export const createQueueModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0; // model ms
  let nextArrival = 0;
  let queue: number[] = []; // arrival times
  let busyUntil = 0;
  let inService: number | null = null;
  let latencySum = 0;
  let served = 0;
  let areaInSystem = 0; // integral of number-in-system over time, for Little's law
  let lastEvent: string | null = null;

  const rho = () => p.util / 100;
  const cv = () => p.variability / 100;
  const serviceTime = () => S * (1 - cv()) + cv() * rng.exponential(S); // mean S, std cv·S

  function advance(end: number): void {
    // Advance event by event so waiting times are exact.
    while (true) {
      const nextDone = inService !== null ? busyUntil : Infinity;
      const tNext = Math.min(nextArrival, nextDone, end);
      areaInSystem += (queue.length + (inService !== null ? 1 : 0)) * (tNext - t);
      t = tNext;
      if (t === end && nextArrival > end && nextDone > end) break;
      if (nextDone <= nextArrival && nextDone <= end) {
        latencySum += t - (inService as number);
        served++;
        inService = null;
      } else if (nextArrival <= end) {
        queue.push(t);
        nextArrival = t + rng.exponential(S / rho());
      }
      if (inService === null && queue.length) {
        inService = queue.shift()!;
        busyUntil = t + serviceTime();
      }
    }
  }

  return {
    params: [
      { name: 'util', label: 'Utilisation', min: 10, max: 98, step: 1, value: 80, unit: '%' },
      { name: 'variability', label: 'Service-time variability', min: 0, max: 100, step: 25, value: 100, unit: '%' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      queue = [];
      busyUntil = 0;
      inService = null;
      latencySum = 0;
      served = 0;
      areaInSystem = 0;
      nextArrival = rng.exponential(S / rho());
      advance(30_000); // 30 s of warm-up, so the measured mean starts near its long-run value
      lastEvent = `Requests arrive every ${formatMs(S / rho())} on average; each takes ${S} ms of work on average.`;
    },

    step(dt) {
      advance(t + dt / SLOW);
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        // Chart frame: x = utilisation 0..100%, y = latency 0..200 ms.
        svg('line', { x1: 40, y1: 290, x2: 392, y2: 290, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
        svg('line', { x1: 40, y1: 120, x2: 40, y2: 290, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
        text('utilisation →', { x: 44, y: 312, 'font-size': 15, fill: token('--viz-muted') }, base);
        text('latency', { x: 4, y: 114, 'font-size': 15, fill: token('--viz-muted') }, base);
        for (const [u, label] of [[0.5, '50%'], [0.8, '80%'], [1, '100%']] as const) {
          text(label, { x: 40 + u * 352, y: 308, 'font-size': 14, 'text-anchor': u === 1 ? 'end' : 'middle', fill: token('--viz-muted') }, base);
        }
        text('200', { x: 36, y: 128, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, base);
        text('10', { x: 36, y: 294, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, base);
        text('ms', { x: 36, y: 146, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, base);
        text('queue', { x: 4, y: 22, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base);
        text('server', { x: 330, y: 22, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      // Queue and server.
      const shown = Math.min(queue.length, 14);
      for (let i = 0; i < 14; i++) {
        svg('rect', { x: 300 - (i + 1) * 20, y: 34, width: 16, height: 40, rx: 3, fill: i < shown ? token('--viz-flow-soft') : 'none', stroke: i < shown ? token('--viz-flow') : token('--viz-stroke'), 'stroke-width': 1.5 }, live);
      }
      if (queue.length > 14) text(`+${queue.length - 14}`, { x: 4, y: 60, 'font-size': 16, 'font-weight': 700, fill: token('--viz-bad') }, live);
      svg('rect', { x: 318, y: 30, width: 74, height: 48, rx: 6, fill: inService !== null ? token('--viz-ok-soft') : token('--viz-server-soft'), stroke: inService !== null ? token('--viz-ok') : token('--viz-server'), 'stroke-width': 2 }, live);
      text(inService !== null ? 'busy' : 'idle', { x: 355, y: 60, 'font-size': 16, 'text-anchor': 'middle', fill: token('--viz-ink') }, live);
      text(`${queue.length} waiting`, { x: 4, y: 96, 'font-size': 16, fill: token('--viz-muted') }, live);

      // Theory curve for the current variability, clipped at 200 ms.
      const y = (ms: number) => 290 - Math.min(1, (ms - S) / 190) * 170;
      let d = '';
      for (let u = 0; u <= 0.985; u += 0.01) {
        const w = theory(u, cv());
        d += `${d ? 'L' : 'M'}${(40 + u * 352).toFixed(1)} ${y(w).toFixed(1)}`;
        if (w > 200) break;
      }
      svg('path', { d, fill: 'none', stroke: token('--viz-flow'), 'stroke-width': 2 }, live);
      if (served > 20) {
        const mean = latencySum / served;
        svg('circle', { cx: 40 + rho() * 352, cy: y(mean), r: 7, fill: token('--viz-warn'), stroke: token('--viz-ink'), 'stroke-width': 1 }, live);
        text(`measured ${Math.round(mean)} ms`, { x: Math.min(300, 40 + rho() * 352 - 8), y: y(mean) - 12, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-ink') }, live);
      }
    },

    stats() {
      return {
        'model time': formatMs(t),
        'mean latency': served ? formatMs(latencySum / served) : '–',
        formula: formatMs(theory(rho(), cv())),
        'average in system (L)': t ? (areaInSystem / t).toFixed(2) : '–',
        'throughput × latency': served && t ? ((served / t) * (latencySum / served)).toFixed(2) : '–',
        'served': served,
      };
    },

    log: () => lastEvent,
  };
};
