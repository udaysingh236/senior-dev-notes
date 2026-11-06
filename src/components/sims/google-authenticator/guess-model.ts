// A year of an attacker who has the password guessing TOTP codes against an attempt limit.
//
// The attacker makes up to 10 guesses a minute and never trips the lock: it stops one short of the
// limit and waits. Two counters, as a verifier would keep them:
//   consecutive: failures since the user's last successful login (reset by each user login)
//   budget:      failures in the current 30-day block (only with "+ per 30 days")
// The run is precomputed minute by minute at reset, so Reset replays exactly. Each guess succeeds
// with probability p = (2w + 1) / 1,000,000; the chance the attacker is in after n guesses is
// 1 − (1 − p)^n. One seeded draw decides whether, and when, this run's attacker gets in.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const DAYS = 365;
const MIN_PER_DAY = 1440;
const MINUTES = DAYS * MIN_PER_DAY;
const RATE_PER_MIN = 10;
const BLOCK = 30 * MIN_PER_DAY;
const SPEED = 6; // days per real second at 1×
const X0 = 46;
const X1 = 392;
const A0 = 30; // counter strip, top
const A1 = 92; // counter strip, bottom
const B0 = 128; // probability chart, top
const B1 = 252; // probability chart, bottom
const NICE = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1];
const BUDGETS = ['consecutive only', '+ per 30 days'];

const pct = (v: number) => {
  const x = v * 100;
  if (x === 0) return '0%';
  if (x < 0.01) return '<0.01%';
  if (x < 1) return `${x.toFixed(2)}%`;
  return `${x.toFixed(x < 10 ? 1 : 0)}%`;
};

export const createGuessModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let pGuess = 3e-6;
  let total = new Float64Array(0); // cumulative guesses at the end of each minute
  let counter = new Float64Array(0); // consecutive-failure counter at the end of each minute
  let loginMinutes: number[] = [];
  let brokenAt = -1; // minute the attacker gets in, or −1
  let t = 0; // days
  let fresh = true;
  let lastEvent: string | null = null;
  let announced = false;

  const limitOn = () => p.limit > 0;
  const chance = (n: number) => 1 - Math.pow(1 - pGuess, n);
  const xDay = (d: number) => X0 + ((X1 - X0) * d) / DAYS;
  const minuteAt = (d: number) => Math.max(0, Math.min(MINUTES - 1, Math.floor(d * MIN_PER_DAY)));

  function precompute(rng: Rng): void {
    // Draw this run's luck first, so every setting replays against the same attacker.
    const u = rng.next();
    total = new Float64Array(MINUTES);
    counter = new Float64Array(MINUTES);
    loginMinutes = [];
    if (p.logins > 0) {
      const gap = MIN_PER_DAY / p.logins;
      for (let m = rng.range(0, gap); m < MINUTES; m += gap * rng.range(0.8, 1.2)) loginMinutes.push(Math.floor(m));
    }
    const cap = limitOn() ? p.limit - 1 : Infinity; // the attacker stops one short of the lock
    let c = 0;
    let b = 0;
    let n = 0;
    let li = 0;
    for (let m = 0; m < MINUTES; m++) {
      if (li < loginMinutes.length && loginMinutes[li] === m) {
        c = 0; // the real user logged in: the consecutive counter resets
        li++;
      }
      if (m % BLOCK === 0) b = 0;
      let g = RATE_PER_MIN;
      g = Math.min(g, cap - c);
      if (p.budget === 1) g = Math.min(g, cap - b);
      g = Math.max(0, g);
      c += g;
      b += g;
      n += g;
      total[m] = n;
      counter[m] = c;
    }
    const need = Math.log(1 - u) / Math.log(1 - pGuess); // guesses until this run's attacker gets in
    brokenAt = -1;
    for (let m = 0; m < MINUTES; m++) {
      if (total[m] >= need) {
        brokenAt = m;
        break;
      }
    }
  }

  function scaleMax(): number {
    const end = chance(total[MINUTES - 1]);
    return NICE.find((v) => v >= end) ?? 1;
  }

  return {
    params: [
      { name: 'window', label: 'Window', min: 0, max: 3, step: 1, value: 1, format: (v) => (v ? `±${v}: ${2 * v + 1} valid codes` : '1 valid code') },
      { name: 'limit', label: 'Lock after', min: 0, max: 200, step: 10, value: 100, format: (v) => (v ? `${v} failures` : 'no limit') },
      { name: 'logins', label: 'User logs in', min: 0, max: 6, step: 1, value: 3, format: (v) => (v ? `${v}× a day` : 'never') },
      { name: 'budget', label: 'Failures counted', min: 0, max: 1, step: 1, value: 0, format: (v) => BUDGETS[v] },
    ],

    reset(params, rng) {
      p = params;
      pGuess = (2 * p.window + 1) / 1_000_000;
      precompute(rng);
      t = 0;
      fresh = true;
      announced = false;
      lastEvent = `day 0: the attacker has the password and guesses ${RATE_PER_MIN} codes a minute${limitOn() ? `, stopping at ${p.limit - 1} failures` : ''}`;
    },

    step(dt) {
      const before = t;
      t = Math.min(DAYS, t + (dt / 1000) * SPEED);
      if (!announced && brokenAt >= 0 && brokenAt <= minuteAt(t)) {
        announced = true;
        lastEvent = `day ${Math.floor(brokenAt / MIN_PER_DAY)}: a guess matched. The attacker is in after ${Math.round(total[brokenAt]).toLocaleString('en-US')} guesses`;
      } else if (Math.floor(before) !== Math.floor(t) && !announced) {
        const m = minuteAt(t);
        lastEvent = `day ${Math.floor(t)}: ${Math.round(total[m]).toLocaleString('en-US')} guesses so far, ${pct(chance(total[m]))} chance of being in`;
      }
    },

    render(view) {
      const base = layer(view, 'base');
      const curve = layer(view, 'curve');
      const top = scaleMax();
      const yB = (v: number) => B1 - (Math.min(v, top) / top) * (B1 - B0);
      if (fresh) {
        fresh = false;
        clear(base);
        clear(curve);
        text('failure counter, last 48 hours', { x: X0, y: A0 - 10, 'font-size': 15, fill: token('--viz-muted') }, base);
        svg('rect', { x: X0, y: A0, width: X1 - X0, height: A1 - A0, rx: 3, fill: token('--viz-surface'), stroke: token('--viz-stroke'), 'stroke-width': 1 }, base);
        if (limitOn()) {
          svg('line', { x1: X0, y1: A0 + 4, x2: X1, y2: A0 + 4, stroke: token('--viz-bad'), 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, base);
          text(`lock at ${p.limit}`, { x: X1 - 6, y: A0 + 22, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-bad') }, base);
        }
        text('0', { x: X0 - 4, y: A1, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, base);

        text('chance the attacker is in', { x: X0, y: B0 - 10, 'font-size': 15, fill: token('--viz-muted') }, base);
        for (const f of [0, 0.5, 1]) {
          svg('line', { x1: X0, y1: yB(top * f), x2: X1, y2: yB(top * f), stroke: token('--viz-stroke'), 'stroke-width': f === 0 ? 1.5 : 0.6 }, base);
          text(pct(top * f), { x: X0 - 4, y: yB(top * f) + 5, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, base);
        }
        for (const d of [0, 90, 180, 270, 365]) {
          text(d === 0 ? 'day 0' : String(d), { x: xDay(d), y: B1 + 20, 'font-size': 15, 'text-anchor': d === 0 ? 'start' : d === DAYS ? 'end' : 'middle', fill: token('--viz-muted') }, base);
        }
        // The whole year's curve, faint: where this policy is heading.
        const pts: string[] = [];
        for (let d = 0; d <= DAYS; d += 1) pts.push(`${xDay(d)},${yB(chance(total[minuteAt(d)]))}`);
        svg('polyline', { points: pts.join(' '), fill: 'none', stroke: token('--viz-muted'), 'stroke-width': 1.5, 'stroke-dasharray': '3 4' }, curve);
        // Legend
        svg('line', { x1: X0, y1: 290, x2: X0 + 22, y2: 290, stroke: token('--viz-bad'), 'stroke-width': 2.5 }, base);
        text('so far', { x: X0 + 28, y: 295, 'font-size': 15, fill: token('--viz-ink') }, base);
        svg('line', { x1: X0 + 90, y1: 290, x2: X0 + 112, y2: 290, stroke: token('--viz-muted'), 'stroke-width': 1.5, 'stroke-dasharray': '3 4' }, base);
        text('rest of the year', { x: X0 + 118, y: 295, 'font-size': 15, fill: token('--viz-ink') }, base);
        svg('path', { d: `M${X0 + 252} 285 v10 m-5 -5 h10`, stroke: token('--viz-flow'), 'stroke-width': 2 }, base);
        text('user login', { x: X0 + 266, y: 295, 'font-size': 15, fill: token('--viz-ink') }, base);
      }

      const live = layer(view, 'live');
      clear(live);

      // Counter strip: the last 48 hours, sampled every 10 minutes.
      const mNow = minuteAt(t);
      const mFrom = Math.max(0, mNow - 2 * MIN_PER_DAY);
      const scale = limitOn() ? p.limit : 1000;
      const xs = (m: number) => X1 - ((mNow - m) / (2 * MIN_PER_DAY)) * (X1 - X0);
      const ys = (c: number) => A1 - (Math.min(c, scale) / scale) * (A1 - A0 - 4);
      const strip: string[] = [];
      for (let m = mFrom; m <= mNow; m += 10) strip.push(`${xs(m)},${ys(counter[m])}`);
      strip.push(`${xs(mNow)},${ys(counter[mNow])}`);
      svg('polyline', { points: strip.join(' '), fill: 'none', stroke: token('--viz-warn'), 'stroke-width': 2 }, live);
      for (const lm of loginMinutes) {
        if (lm < mFrom || lm > mNow) continue;
        svg('path', { d: `M${xs(lm)} ${A1 - 10} v10 m-5 -5 h10`, stroke: token('--viz-flow'), 'stroke-width': 2 }, live);
      }

      // Probability so far.
      const pts: string[] = [];
      for (let d = 0; d <= t; d += 1) pts.push(`${xDay(d)},${yB(chance(total[minuteAt(d)]))}`);
      pts.push(`${xDay(t)},${yB(chance(total[mNow]))}`);
      svg('polyline', { points: pts.join(' '), fill: 'none', stroke: token('--viz-bad'), 'stroke-width': 2.5 }, live);
      if (brokenAt >= 0 && brokenAt <= mNow) {
        const d = brokenAt / MIN_PER_DAY;
        const cx = xDay(d);
        const cy = yB(chance(total[brokenAt]));
        svg('path', { d: `M${cx - 6} ${cy - 6} l12 12 m0 -12 l-12 12`, stroke: token('--viz-bad'), 'stroke-width': 3 }, live);
        text(`in on day ${Math.floor(d)}`, { x: Math.min(cx + 10, X1 - 110), y: Math.max(cy - 10, B0 + 14), 'font-size': 15, 'font-weight': 600, fill: token('--viz-bad') }, live);
      }
    },

    stats() {
      const m = minuteAt(t);
      return {
        day: Math.floor(t),
        'guesses so far': Math.round(total[m]).toLocaleString('en-US'),
        'chance attacker is in': pct(chance(total[m])),
        'after a year': pct(chance(total[MINUTES - 1])),
        'this run': brokenAt >= 0 && brokenAt <= m ? `in on day ${Math.floor(brokenAt / MIN_PER_DAY)}` : 'not in yet',
      };
    },

    log() {
      return lastEvent;
    },
  };
};
