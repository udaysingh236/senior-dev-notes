// Shared drawing for the fleet and race sims: one lane per strategy, each a row of bars for the
// requests admitted in each of the last few one-second windows, against a dashed limit line.
import { svg, text, token } from '../../sim/svg';

export const LIMIT = 100; // requests per one-second window, the promise every lane tries to keep
export const WINDOW_MS = 1000;
export const HISTORY = 8; // completed windows drawn per lane

/** Admitted counts per one-second window, for one lane. */
export class WindowLog {
  windows: number[] = []; // completed windows, oldest first
  current = 0;
  index = 0; // number of the window `current` belongs to

  add(at: number): void {
    this.roll(at);
    this.current++;
  }

  /** Closes every window that ended before `at`. */
  roll(at: number): void {
    const n = Math.floor(at / WINDOW_MS);
    while (this.index < n) {
      this.windows.push(this.current);
      if (this.windows.length > 64) this.windows.shift();
      this.current = 0;
      this.index++;
    }
  }

  last(): number {
    return this.windows.length ? this.windows[this.windows.length - 1] : 0;
  }

  /** Mean of the completed windows, skipping the first (it starts mid-warm-up). */
  mean(skip = 1): number {
    const w = this.windows.slice(skip);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
  }
}

/**
 * Draws one lane: a title, the last HISTORY windows as bars, the current window growing at the
 * right, and the dashed limit line. Bars over the limit turn red; the scale tops out at 4× the
 * limit, and taller bars are clipped with their number written on top.
 */
export function drawLane(parent: Element, top: number, title: string, log: WindowLog, height = 56): void {
  const left = 4;
  const right = 300;
  const scaleMax = 4 * LIMIT;
  const slots = HISTORY + 1;
  const gap = 4;
  const w = (right - left - gap * (slots - 1)) / slots;
  const base = top + 24 + height;
  const y = (v: number) => base - (Math.min(v, scaleMax) / scaleMax) * height;

  text(title, { x: left, y: top + 18, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, parent);
  svg('line', { x1: left, x2: right, y1: base, y2: base, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, parent);

  const shown = log.windows.slice(-HISTORY);
  const values = [...Array(HISTORY - shown.length).fill(null), ...shown, log.current];
  values.forEach((v, i) => {
    if (v === null) return;
    const x = left + i * (w + gap);
    const live = i === values.length - 1;
    const tone = v > LIMIT * 1.05 ? 'bad' : v < LIMIT * 0.8 && !live ? 'warn' : 'ok';
    const h = base - y(v);
    if (h > 0) {
      svg('rect', {
        x, y: y(v), width: w, height: h, rx: 2,
        fill: token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.5,
        'stroke-dasharray': live ? '3 2' : null,
      }, parent);
    }
    if (v > scaleMax) {
      text(String(v), { x: x + w / 2, y: y(v) + 14, 'font-size': 14, 'text-anchor': 'middle', fill: token('--viz-bad') }, parent);
    }
  });
  svg('line', {
    x1: left, x2: right, y1: y(LIMIT), y2: y(LIMIT),
    stroke: token('--viz-ink'), 'stroke-width': 1.5, 'stroke-dasharray': '6 4',
  }, parent);

  // The last full second, as a number, so the reader does not have to measure bars.
  const last = log.last();
  const tone = !log.windows.length ? 'muted' : last > LIMIT * 1.05 ? 'bad' : last < LIMIT * 0.8 ? 'warn' : 'ok';
  text(log.windows.length ? String(last) : '…', {
    x: 352, y: base - 16, 'font-size': 26, 'font-weight': 700, 'text-anchor': 'middle', fill: token(`--viz-${tone}`),
  }, parent);
  text('last 1 s', { x: 352, y: base + 2, 'font-size': 15, 'text-anchor': 'middle', fill: token('--viz-muted') }, parent);
}
