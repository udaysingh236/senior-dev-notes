// Four months of logins from a phone whose clock drifts, against three kinds of TOTP verifier.
//
// At each login the user reads the code at a random moment in the phone's current step and types
// it, which takes between 2 s and the "typing time" setting. The phone's clock runs ahead (or
// behind) by `drift` seconds a day since it was last corrected. For each login we compute
//   k = (step of the code) − (server's step when it arrives)
// and the verifier accepts it if k is inside its window:
//   fixed:            |k| ≤ w
//   tracking:         |k − learned| ≤ w, and on success learned = k
//   tracking+fallback: either of the two windows above, and on success learned = k
// The chart shows k for every login (dots), the accepted band at each login, and the phone's
// clock offset in steps (dashed). The action "Phone corrects its clock" resets the phone's offset
// to zero, which is what happens when it goes back online with automatic time on.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const HORIZON = 120; // days shown
const RATE = 2; // days per real second at 1×
const STEP = 30;
const X0 = 40;
const X1 = 392;
const Y0 = 16;
const Y1 = 226;
const MODES = ['fixed window', 'drift tracking', 'tracking + fallback'];

type Login = { day: number; k: number; lo: number; hi: number; lo2: number | null; hi2: number | null; ok: boolean };

export const createDriftModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextLogin = 0;
  let syncedAt = 0;
  let learned = 0;
  let logins: Login[] = [];
  let syncs: number[] = [];
  let drawn = 0;
  let fresh = true;
  let yMin = -3;
  let yMax = 3;
  let lastEvent: string | null = null;

  const x = (day: number) => X0 + ((X1 - X0) * day) / HORIZON;
  const y = (k: number) => Y1 - ((k - yMin) / (yMax - yMin)) * (Y1 - Y0);
  const offsetSeconds = (day: number) => p.drift * (day - syncedAt);

  function login(day: number): void {
    const offset = offsetSeconds(day);
    const serverRead = rng.range(0, STEP * 1000); // any moment; only its position in a step matters
    const typing = rng.range(2, Math.max(2, p.delay));
    const codeStep = Math.floor((serverRead + offset) / STEP);
    const arriveStep = Math.floor((serverRead + typing) / STEP);
    const k = codeStep - arriveStep;
    const w = p.window;
    const centre = p.mode === 0 ? 0 : learned;
    let ok = Math.abs(k - centre) <= w;
    const withFallback = p.mode === 2 && centre !== 0;
    if (!ok && withFallback) ok = Math.abs(k) <= w;
    logins.push({
      day,
      k,
      lo: centre - w,
      hi: centre + w,
      lo2: withFallback ? -w : null,
      hi2: withFallback ? w : null,
      ok,
    });
    const when = `day ${Math.floor(day)}`;
    const ahead = `phone ${offset >= 0 ? 'ahead' : 'behind'} ${Math.abs(Math.round(offset))} s, typed in ${Math.round(typing)} s`;
    if (ok) {
      if (p.mode !== 0 && k !== learned) lastEvent = `${when}: ${ahead}; code ${k >= 0 ? '+' : ''}${k} steps, accepted; drift ${learned >= 0 ? '+' : ''}${learned} → ${k >= 0 ? '+' : ''}${k}`;
      else lastEvent = `${when}: ${ahead}; code ${k >= 0 ? '+' : ''}${k} steps, accepted`;
      if (p.mode !== 0) learned = k;
    } else {
      lastEvent = `${when}: ${ahead}; code ${k >= 0 ? '+' : ''}${k} steps, outside ${centre - w}..${centre + w}: REJECTED`;
    }
  }

  function advance(to: number): void {
    while (nextLogin <= Math.min(to, HORIZON)) {
      login(nextLogin);
      nextLogin += rng.exponential(1.5);
    }
    t = Math.min(to, HORIZON);
  }

  const rejected = () => logins.filter((l) => !l.ok).length;

  return {
    params: [
      { name: 'drift', label: 'Phone clock drift', min: -3, max: 3, step: 0.5, value: 2, format: (v) => `${v > 0 ? '+' : ''}${v} s/day` },
      { name: 'delay', label: 'Longest typing time', min: 2, max: 60, step: 1, value: 12, unit: 's' },
      { name: 'window', label: 'Window', min: 0, max: 3, step: 1, value: 1, format: (v) => (v ? `±${v} step${v > 1 ? 's' : ''}` : 'current step only') },
      { name: 'mode', label: 'Server', min: 0, max: 2, step: 1, value: 0, format: (v) => MODES[v] },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      nextLogin = rng.range(0.2, 1);
      syncedAt = 0;
      learned = 0;
      logins = [];
      syncs = [];
      drawn = 0;
      fresh = true;
      const reach = Math.ceil((Math.abs(p.drift) * HORIZON) / STEP);
      yMin = p.drift < 0 ? -reach - 2 : -3;
      yMax = p.drift > 0 ? reach + 2 : 3;
      lastEvent = `day 0: enrolled; ${MODES[p.mode]}, ${p.window ? `±${p.window}` : 'no'} window`;
    },

    step(dt) {
      advance(t + (dt / 1000) * RATE);
    },

    render(view) {
      const base = layer(view, 'base');
      const marks = layer(view, 'marks');
      if (fresh) {
        clear(base);
        clear(marks);
        drawn = 0;
        fresh = false;
        const tick = yMax - yMin > 12 ? 4 : yMax - yMin > 6 ? 2 : 1;
        for (let k = Math.ceil(yMin / tick) * tick; k <= yMax; k += tick) {
          svg('line', { x1: X0, y1: y(k), x2: X1, y2: y(k), stroke: token('--viz-stroke'), 'stroke-width': k === 0 ? 1.5 : 0.6, opacity: k === 0 ? 1 : 0.6 }, base);
          text(k > 0 ? `+${k}` : String(k), { x: X0 - 6, y: y(k) + 5, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-muted') }, base);
        }
        for (const d of [0, 30, 60, 90, 120]) {
          text(d === 0 ? 'day 0' : String(d), { x: x(d), y: Y1 + 22, 'font-size': 15, 'text-anchor': d === 0 ? 'start' : d === HORIZON ? 'end' : 'middle', fill: token('--viz-muted') }, base);
        }
        text('code step − server step', { x: X0 + 4, y: Y0 + 2, 'font-size': 15, fill: token('--viz-muted') }, base);
        // Legend: shape as well as colour.
        svg('circle', { cx: X0 + 6, cy: 270, r: 5, fill: token('--viz-ok') }, base);
        text('accepted', { x: X0 + 16, y: 275, 'font-size': 16, fill: token('--viz-ink') }, base);
        svg('path', { d: `M${X0 + 120} 265 l10 10 m0 -10 l-10 10`, stroke: token('--viz-bad'), 'stroke-width': 2.5 }, base);
        text('rejected', { x: X0 + 138, y: 275, 'font-size': 16, fill: token('--viz-ink') }, base);
        svg('line', { x1: X0 + 228, y1: 270, x2: X0 + 252, y2: 270, stroke: token('--viz-flow'), 'stroke-width': 2, 'stroke-dasharray': '5 4' }, base);
        text('phone clock', { x: X0 + 258, y: 275, 'font-size': 16, fill: token('--viz-ink') }, base);
      }

      for (; drawn < logins.length; drawn++) {
        const l = logins[drawn];
        const cx = x(l.day);
        const band = (lo: number, hi: number) =>
          svg('rect', { x: cx - 2, y: y(hi + 0.5), width: 4, height: y(lo - 0.5) - y(hi + 0.5), fill: token('--viz-ok-soft') }, marks);
        band(l.lo, l.hi);
        if (l.lo2 !== null && l.hi2 !== null) band(l.lo2, l.hi2);
      }
      // Dots go on top of every band, so redraw them in their own layer.
      const dots = layer(view, 'dots');
      clear(dots);
      for (const l of logins) {
        const cx = x(l.day);
        const cy = y(l.k);
        if (l.ok) svg('circle', { cx, cy, r: 3.5, fill: token('--viz-ok') }, dots);
        else svg('path', { d: `M${cx - 4} ${cy - 4} l8 8 m0 -8 l-8 8`, stroke: token('--viz-bad'), 'stroke-width': 2.2 }, dots);
      }

      const live = layer(view, 'live');
      clear(live);
      // The phone's clock offset, in steps, as a dashed line (piecewise: it resets on each sync).
      const points: string[] = [];
      let from = 0;
      for (const s of [...syncs, t]) {
        const d0 = from;
        const d1 = Math.min(s, t);
        points.push(`M${x(d0)} ${y(0)} L${x(d1)} ${y((p.drift * (d1 - d0)) / STEP)}`);
        from = s;
      }
      svg('path', { d: points.join(' '), fill: 'none', stroke: token('--viz-flow'), 'stroke-width': 2, 'stroke-dasharray': '5 4' }, live);
      svg('line', { x1: x(t), y1: Y0, x2: x(t), y2: Y1, stroke: token('--viz-ink'), 'stroke-width': 1, opacity: 0.4 }, live);
    },

    stats() {
      const offset = offsetSeconds(t);
      return {
        day: Math.floor(t),
        logins: logins.length,
        rejected: rejected(),
        'phone clock off by': `${offset >= 0 ? '+' : '−'}${Math.abs(Math.round(offset))} s`,
        'learned drift': p.mode === 0 ? 'not tracked' : `${learned >= 0 ? '+' : ''}${learned} steps`,
        'codes valid per attempt': p.mode === 2 && learned !== 0 ? 2 * (2 * p.window + 1) : 2 * p.window + 1,
      };
    },

    log() {
      return lastEvent;
    },

    actions: [
      {
        label: 'Phone corrects its clock',
        run() {
          if (t >= HORIZON) return;
          syncs.push(t);
          syncedAt = t;
          lastEvent = `day ${Math.floor(t)}: the phone went online and corrected its clock; learned drift is still ${p.mode === 0 ? 'not tracked' : `${learned >= 0 ? '+' : ''}${learned}`}`;
        },
      },
    ],
  };
};
