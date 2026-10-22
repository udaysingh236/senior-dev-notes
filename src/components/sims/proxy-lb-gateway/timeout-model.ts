// One user click through client -> gateway -> service, with a timeout and retries at both hops.
// The service never cancels work: when a caller gives up, the service keeps going for nobody.
// Each click is laid out as a timeline: client attempts, gateway attempts, service executions.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

interface Bar {
  row: 'client' | 'gateway' | 'service';
  start: number;
  end: number;
  outcome: 'ok' | 'timeout' | 'wasted' | 'error';
}

interface Click {
  bars: Bar[];
  success: boolean;
  doneAt: number;
  serviceCalls: number;
  serviceMs: number;
  usefulMs: number;
}

export function simulateClick(p: Record<string, number>, sample: () => number): Click {
  const bars: Bar[] = [];
  let serviceCalls = 0;
  let serviceMs = 0;
  let usefulMs = 0;

  /** One gateway request starting at t: returns when and how the gateway answers. */
  function gateway(t0: number, clientDeadline: number): { at: number; ok: boolean; useful: Bar | null } {
    let t = t0;
    for (let attempt = 0; attempt <= p.retries; attempt++) {
      const d = sample();
      serviceCalls++;
      serviceMs += d;
      const service: Bar = { row: 'service', start: t, end: t + d, outcome: 'wasted' };
      bars.push(service);
      if (d <= p.gatewayTimeout) {
        bars.push({ row: 'gateway', start: t, end: t + d, outcome: t + d <= clientDeadline ? 'ok' : 'wasted' });
        return { at: t + d, ok: true, useful: service };
      }
      bars.push({ row: 'gateway', start: t, end: t + p.gatewayTimeout, outcome: 'timeout' });
      t += p.gatewayTimeout;
    }
    return { at: t, ok: false, useful: null }; // 504 to the client
  }

  let t = 0;
  for (let attempt = 0; attempt <= p.retries; attempt++) {
    const deadline = t + p.clientTimeout;
    const g = gateway(t, deadline);
    if (g.at <= deadline && g.ok) {
      bars.push({ row: 'client', start: t, end: g.at, outcome: 'ok' });
      g.useful!.outcome = 'ok';
      usefulMs = g.useful!.end - g.useful!.start;
      return { bars, success: true, doneAt: g.at, serviceCalls, serviceMs, usefulMs };
    }
    const end = Math.min(g.at, deadline);
    bars.push({ row: 'client', start: t, end, outcome: g.at <= deadline ? 'error' : 'timeout' });
    t = end; // retry at once
  }
  return { bars, success: false, doneAt: t, serviceCalls, serviceMs, usefulMs };
}

export const createTimeoutModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let click: Click;
  let clock = 0; // ms into the current click's timeline
  let pause = 0;
  let clicks = 0;
  let successes = 0;
  let calls = 0;
  let serviceMs = 0;
  let usefulMs = 0;
  let lastEvent: string | null = null;

  // Service time: the slider is the median; one call in five takes three times as long.
  const sample = () => p.latency * rng.range(0.7, 1.3) * (rng.chance(0.2) ? 3 : 1);

  function nextClick(): void {
    click = simulateClick(p, sample);
    clock = 0;
    pause = 0;
  }

  return {
    params: [
      { name: 'latency', label: 'Service time (median)', min: 100, max: 2000, step: 100, value: 1200, unit: 'ms' },
      { name: 'gatewayTimeout', label: 'Gateway timeout', min: 200, max: 4000, step: 100, value: 1000, unit: 'ms' },
      { name: 'clientTimeout', label: 'Client timeout', min: 200, max: 6000, step: 100, value: 1500, unit: 'ms' },
      { name: 'retries', label: 'Retries at each hop', min: 0, max: 3, step: 1, value: 2 },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      clicks = successes = calls = 0;
      serviceMs = usefulMs = 0;
      nextClick();
      lastEvent = 'Each run is one user click. Service work the user never sees is amber.';
    },

    step(dt) {
      if (clock < click.doneAt) {
        clock = Math.min(click.doneAt, clock + dt * 2); // timeline runs at 2× speed
        if (clock >= click.doneAt) {
          clicks++;
          if (click.success) successes++;
          calls += click.serviceCalls;
          serviceMs += click.serviceMs;
          usefulMs += click.usefulMs;
          lastEvent = `click ${clicks}: ${click.success ? 'answered' : 'failed'} after ${formatMs(click.doneAt)}, ${click.serviceCalls} service call${click.serviceCalls > 1 ? 's' : ''}`;
        }
        return;
      }
      pause += dt;
      if (pause > 1200) nextClick();
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        const label = { x: 4, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') };
        text('client', { ...label, y: 34 }, base);
        text('gateway', { ...label, y: 74 }, base);
        text('service', { ...label, y: 114 }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      const maxEnd = Math.max(...click.bars.map((b) => b.end), 1);
      const X0 = 80;
      const scale = (400 - X0 - 4) / maxEnd;
      const rows: Record<Bar['row'], number[]> = { client: [], gateway: [], service: [] };
      const top: Record<Bar['row'], number> = { client: 20, gateway: 60, service: 100 };
      for (const b of click.bars) {
        if (b.start > clock) continue;
        // Stack overlapping bars of the same row into sub-rows.
        const lanes = rows[b.row];
        let sub = lanes.findIndex((end) => end <= b.start + 0.5);
        if (sub < 0) {
          sub = lanes.length;
          lanes.push(0);
        }
        lanes[sub] = b.end;
        const h = b.row === 'service' ? 9 : 14;
        const y = top[b.row] + sub * (h + 3);
        const end = Math.min(b.end, clock);
        const tone = b.outcome === 'ok' ? 'ok' : b.outcome === 'wasted' ? 'warn' : 'bad';
        svg('rect', {
          x: X0 + b.start * scale, y, width: Math.max(2, (end - b.start) * scale), height: h, rx: 3,
          fill: token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.5,
        }, live);
      }
      // Time axis.
      svg('line', { x1: X0, y1: 214, x2: 396, y2: 214, stroke: token('--viz-stroke'), 'stroke-width': 1 }, live);
      text('0', { x: X0, y: 234, 'font-size': 15, fill: token('--viz-muted') }, live);
      text(formatMs(maxEnd), { x: 396, y: 234, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-muted') }, live);
      svg('line', { x1: X0 + clock * scale, y1: 14, x2: X0 + clock * scale, y2: 214, stroke: token('--viz-flow'), 'stroke-width': 1.5 }, live);
    },

    stats() {
      return {
        clicks,
        answered: clicks ? `${Math.round((successes / clicks) * 100)}%` : '–',
        'service calls per click': clicks ? (calls / clicks).toFixed(1) : '–',
        'service work wasted': serviceMs ? `${Math.round((1 - usefulMs / serviceMs) * 100)}%` : '–',
      };
    },

    log: () => lastEvent,
  };
};
