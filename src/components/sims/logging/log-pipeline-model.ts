// A service writing log lines through a bounded buffer to a central log store.
// Requests arrive at random (Poisson). Each request writes a fixed number of lines: 10 at INFO,
// 50 at DEBUG. Lines go into a buffer inside the service; a shipper sends lines from the buffer to
// the log store at a fixed rate. When the buffer is full, the service either makes the request wait
// for space (block) or throws the lines away and counts them (drop).
//
// Buttons: the log store slows to a tenth of its speed for 10 s, and a traffic spike (3x requests
// for 10 s).
//
// What the reader controls: requests per second, log level, buffer size, block or drop.
// What they watch: the buffer filling, request time (block) or lost lines (drop), and the cost of
// the log volume per day.
import { layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const LINES = [10, 50]; // lines per request at INFO and DEBUG
const BYTES_PER_LINE = 170; // a JSON line, measured in examples/logging/python/bench.py
const PRICE_PER_GB = 0.5; // USD, CloudWatch Logs standard ingestion, as of November 2026
const SHIP_RATE = 20000; // lines per second the shipper can send normally
const BASE_MS = 20; // the request's own work
const EVENT_MS = 10000;
const WINDOW_MS = 1000;

interface Waiting { arrived: number; lines: number }

export const createLogPipelineModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let buffer = 0; // lines waiting in the buffer (fractional while draining)
  let shipped = 0;
  let dropped = 0;
  let waiting: Waiting[] = [];
  let done: { at: number; ms: number }[] = [];
  let producedLines: { at: number; n: number }[] = [];
  let slowUntil = -1;
  let spikeUntil = -1;
  let lastEvent: string | null = null;

  const note = (m: string) => (lastEvent = `t=${(t / 1000).toFixed(1)}s ${m}`);
  const capacity = () => p.buffer;
  const linesPerRequest = () => LINES[p.level];
  const shipRate = () => SHIP_RATE * (t < slowUntil ? 0.1 : 1);
  const rate = () => p.rate * (t < spikeUntil ? 3 : 1);

  function accept(arrived: number, lines: number): void {
    buffer += lines;
    done.push({ at: t, ms: t - arrived + BASE_MS });
    producedLines.push({ at: t, n: lines });
  }

  function tick(dt: number): void {
    // Ship lines from the buffer.
    const ship = Math.min(buffer, (shipRate() * dt) / 1000);
    buffer -= ship;
    shipped += ship;

    // Waiting requests (block mode) take free space in arrival order.
    while (waiting.length && capacity() - buffer >= waiting[0].lines) {
      const w = waiting.shift()!;
      accept(w.arrived, w.lines);
    }

    // New requests.
    while (t >= nextArrival) {
      const lines = linesPerRequest();
      if (p.block === 1) {
        if (!waiting.length && capacity() - buffer >= lines) accept(t, lines);
        else waiting.push({ arrived: t, lines });
      } else {
        const room = Math.max(0, Math.floor(capacity() - buffer));
        const kept = Math.min(room, lines);
        if (kept < lines) {
          if (dropped === 0) note('buffer full: lines are being dropped');
          dropped += lines - kept;
        }
        buffer += kept;
        done.push({ at: t, ms: BASE_MS });
        producedLines.push({ at: t, n: lines });
      }
      nextArrival += rng.exponential(1000 / rate());
    }

    if (p.block === 1 && waiting.length === 1) note('buffer full: requests now wait for log space');
    t += dt;
    done = done.filter((d) => d.at > t - WINDOW_MS);
    producedLines = producedLines.filter((d) => d.at > t - WINDOW_MS);
  }

  function requestMs(): number {
    // Average over the last second, counting requests still waiting at their current wait.
    const waits = done.map((d) => d.ms).concat(waiting.map((w) => t - w.arrived + BASE_MS));
    return waits.length ? waits.reduce((s, x) => s + x, 0) / waits.length : BASE_MS;
  }

  function linesPerSecond(): number {
    return producedLines.reduce((s, d) => s + d.n, 0) * (1000 / WINDOW_MS);
  }

  function gbPerDay(): number {
    // lines a second × bytes a line × seconds a day ÷ 1,000,000,000 bytes a GB
    return (rate() * linesPerRequest() * BYTES_PER_LINE * 86400) / 1e9;
  }

  return {
    params: [
      { name: 'rate', label: 'Requests per second', min: 100, max: 1000, step: 50, value: 500 },
      { name: 'level', label: 'Log level', min: 0, max: 1, step: 1, value: 0, format: (v) => (v ? 'DEBUG (50 lines a request)' : 'INFO (10 lines a request)') },
      { name: 'buffer', label: 'Buffer size', min: 2000, max: 50000, step: 2000, value: 10000, unit: 'lines' },
      { name: 'block', label: 'When the buffer is full', min: 0, max: 1, step: 1, value: 0, format: (v) => (v ? 'make the request wait' : 'drop the lines') },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      nextArrival = rng.exponential(1000 / p.rate);
      buffer = 0;
      shipped = 0;
      dropped = 0;
      waiting = [];
      done = [];
      producedLines = [];
      slowUntil = -1;
      spikeUntil = -1;
      lastEvent = null;
    },

    step(dt) {
      const end = t + dt;
      while (t < end) tick(Math.min(5, end - t));
    },

    render(view) {
      const g = layer(view, 'live');
      g.replaceChildren();
      const ink = token('--viz-ink');
      const muted = token('--viz-muted');
      const bold = { 'font-size': 17, 'font-weight': 700, fill: ink };
      const ms = requestMs();
      const slowReq = ms > 100;

      // Service
      svg('rect', { x: 2, y: 10, width: 128, height: 74, rx: 6, fill: token(slowReq ? '--viz-warn-soft' : '--viz-server-soft'), stroke: token(slowReq ? '--viz-warn' : '--viz-server'), 'stroke-width': 1.5 }, g);
      text('Checkout', { x: 66, y: 34, 'text-anchor': 'middle', ...bold }, g);
      text(`${Math.round(rate())} req/s`, { x: 66, y: 54, 'text-anchor': 'middle', 'font-size': 14, fill: muted }, g);
      text(`request ${ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'}`, { x: 66, y: 74, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 700, fill: token(slowReq ? '--viz-warn' : '--viz-ok') }, g);

      // Buffer bar
      const bx = 150, bw = 120, by = 26, bh = 40;
      const fill = Math.min(1, buffer / capacity());
      const tone = fill > 0.95 ? '--viz-bad' : fill > 0.6 ? '--viz-warn' : '--viz-flow';
      text('buffer', { x: bx, y: by - 8, 'font-size': 14, fill: muted }, g);
      svg('rect', { x: bx, y: by, width: bw, height: bh, rx: 4, fill: token('--viz-surface'), stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, g);
      svg('rect', { x: bx + 2, y: by + 2, width: Math.max(0, (bw - 4) * fill), height: bh - 4, rx: 3, fill: token(`${tone}-soft` as `--viz-${string}`), stroke: token(tone as `--viz-${string}`), 'stroke-width': 1 }, g);
      text(`${Math.round(fill * 100)}% full`, { x: bx + bw / 2, y: by + 26, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: ink }, g);
      svg('line', { x1: 131, y1: 46, x2: 148, y2: 46, stroke: token('--viz-flow'), 'stroke-width': 2 }, g);
      svg('line', { x1: 271, y1: 46, x2: 288, y2: 46, stroke: token('--viz-flow'), 'stroke-width': 2, 'stroke-dasharray': t < slowUntil ? '4 4' : null }, g);

      // Log store
      const slow = t < slowUntil;
      svg('path', { d: 'M290 18 L290 76 A54 7 0 0 0 398 76 L398 18', fill: token(slow ? '--viz-warn-soft' : '--viz-store-soft'), stroke: token(slow ? '--viz-warn' : '--viz-store'), 'stroke-width': 1.5 }, g);
      svg('ellipse', { cx: 344, cy: 18, rx: 54, ry: 7, fill: token(slow ? '--viz-warn-soft' : '--viz-store-soft'), stroke: token(slow ? '--viz-warn' : '--viz-store'), 'stroke-width': 1.5 }, g);
      text('Log store', { x: 344, y: 46, 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700, fill: ink }, g);
      text(slow ? 'slow: 2,000/s' : '20,000 lines/s', { x: 344, y: 66, 'text-anchor': 'middle', 'font-size': 13, fill: muted }, g);

      // Waiting or dropped
      const y2 = 124;
      if (p.block === 1) {
        text(`requests waiting for log space: ${waiting.length}`, { x: 2, y: y2, 'font-size': 15, fill: waiting.length ? token('--viz-warn') : muted, 'font-weight': waiting.length ? 700 : 400 }, g);
      } else {
        text(`lines dropped: ${dropped.toLocaleString('en-US')}`, { x: 2, y: y2, 'font-size': 15, fill: dropped ? token('--viz-bad') : muted, 'font-weight': dropped ? 700 : 400 }, g);
      }
      text(`lines shipped: ${Math.round(shipped).toLocaleString('en-US')}`, { x: 2, y: y2 + 26, 'font-size': 15, fill: muted }, g);
      text(`lines written: ${Math.round(linesPerSecond()).toLocaleString('en-US')} a second`, { x: 2, y: y2 + 52, 'font-size': 15, fill: muted }, g);

      // Cost bar
      const gb = gbPerDay();
      svg('rect', { x: 2, y: 196, width: 396, height: 40, rx: 6, fill: token('--viz-surface'), stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, g);
      text(`At this rate: ${Math.round(gb)} GB a day, about $${Math.round(gb * PRICE_PER_GB)} a day`, { x: 200, y: 222, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: ink }, g);
    },

    stats() {
      return {
        'request time': `${Math.round(requestMs())} ms`,
        'buffer': `${Math.round(buffer).toLocaleString('en-US')} / ${capacity().toLocaleString('en-US')}`,
        'dropped': dropped.toLocaleString('en-US'),
        'waiting requests': waiting.length,
        'GB a day': Math.round(gbPerDay()),
      };
    },

    log: () => lastEvent,

    actions: [
      { label: 'Log store slows down (10 s)', run() { slowUntil = t + EVENT_MS; note('the log store slows to 2,000 lines a second for 10 s'); } },
      { label: 'Traffic spike (10 s)', run() { spikeUntil = t + EVENT_MS; note('3x requests for 10 s'); } },
    ],
  };
};
