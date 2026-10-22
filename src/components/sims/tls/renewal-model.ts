// Six certificates over two years, renewed by automation at two-thirds of their lifetime and retried
// daily. Each row is one certificate's timeline: green while valid, a thin amber stretch while its
// renewal is overdue, a tall red stretch while it has expired and every client refuses it.
//
// Automation breaks now and then (a red cross: a firewall change, an expired DNS API token, a
// rebuilt server). A broken renewal stays broken until a human fixes it, which takes `fix` days and
// starts only when the expiry alert fires, or, with no alert, when the certificate has expired and
// users complain. The CA itself is sometimes unreachable for a day, and renewals due that day retry.
//
// Every random event is drawn in reset() from the seeded RNG, so Reset replays the same two years.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

type Status = 0 | 1 | 2 | 3; // not yet simulated, valid, renewal overdue, expired

interface Cert {
  expires: number;
  broken: boolean;
  fixAt: number | null;
  status: Uint8Array; // per day
  breaks: number[]; // days the automation broke, for the red crosses
}

const DAYS = 730;
const NAMES = ['api', 'www', 'admin', 'payments', 'auth', 'partner'];
const BREAK_REASONS = [
  'a firewall change blocks the HTTP challenge',
  'the DNS API token expired',
  'the server was rebuilt without the renewal job',
  'the new cert is on disk but the proxy was never reloaded',
  'a deploy loop hit the CA rate limit',
];

const INK = token('--viz-ink');
const MUTED = token('--viz-muted');
const STROKE = token('--viz-stroke');
const OK = token('--viz-ok');
const WARN = token('--viz-warn');
const BAD = token('--viz-bad');

export const createRenewalModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let day = 0; // next day to simulate
  let acc = 0;
  let certs: Cert[] = [];
  let breakDays: Set<number>[] = [];
  let caDown = new Uint8Array(DAYS);
  let reasonOf = new Map<string, string>();
  let issued = 0;
  let breakages = 0;
  let failedDays = 0;
  let pages = 0;
  let outageDays = 0;
  let lastLog: string | null = null;

  /** Renewal starts when a third of the lifetime is left. */
  const renewWindow = () => Math.max(1, Math.round(p.lifetime / 3));

  function simulateDay(d: number): void {
    const outage = caDown[d] === 1;
    certs.forEach((c, i) => {
      const name = NAMES[i];
      if (breakDays[i].has(d) && !c.broken) {
        c.broken = true;
        c.breaks.push(d);
        breakages++;
        lastLog = `Day ${d}: renewal automation for "${name}" broke: ${reasonOf.get(`${i}:${d}`)}. Nobody notices yet.`;
      }
      if (c.fixAt !== null && d >= c.fixAt) {
        c.broken = false;
        c.fixAt = null;
        lastLog = `Day ${d}: a human fixed the renewal for "${name}".`;
      }
      const overdue = d >= c.expires - renewWindow();
      if (overdue) {
        if (!c.broken && !outage) {
          c.expires = d + p.lifetime; // renewed: a fresh certificate from today
          issued++;
        } else failedDays++;
      }
      const left = c.expires - d;
      const stillOverdue = d >= c.expires - renewWindow();
      const alerted = p.alert > 0 && stillOverdue && left <= p.alert;
      if (c.broken && c.fixAt === null && (alerted || left <= 0)) {
        c.fixAt = d + p.fix;
        pages++;
        lastLog = left <= 0
          ? `Day ${d}: "${name}" EXPIRED with no alert. Users report certificate errors; a fix takes ${p.fix} days.`
          : `Day ${d}: "${name}" is overdue with ${left} days left: the expiry alert pages someone.`;
      }
      const status: Status = left <= 0 ? 3 : stillOverdue ? 2 : 1;
      c.status[d] = status;
      if (status === 3) outageDays++;
    });
    if (outage) {
      const waiting = certs.filter((c) => d >= c.expires - renewWindow()).length;
      if (waiting) lastLog = `Day ${d}: the CA is unreachable. ${waiting} renewal${waiting > 1 ? 's' : ''} due today fail and will retry tomorrow.`;
    }
  }

  // ---------- drawing ----------

  const X0 = 86; // room for row names
  const X1 = 396;
  const xAt = (d: number) => X0 + (d / DAYS) * (X1 - X0);

  function drawRow(g: SVGGElement, c: Cert, y: number, h: number): void {
    // Merge days with the same status into runs, so a row is a handful of rectangles.
    const runs: [number, number, Status][] = [];
    let start = 0;
    for (let d = 1; d <= day; d++) {
      if (d < day && c.status[d] === c.status[start]) continue;
      if (c.status[start]) runs.push([start, d, c.status[start] as Status]);
      start = d;
    }
    // Expired runs last and at least 3 units wide: a one-day outage on a two-year axis would
    // otherwise be thinner than a pixel.
    runs.sort((a, b) => Number(a[2] === 3) - Number(b[2] === 3));
    for (const [from, to, s] of runs) {
      const hh = s === 1 ? h : s === 2 ? h * 0.45 : h * 1.5; // shape, not only colour, carries meaning
      const w = Math.max(s === 3 ? 3 : s === 2 ? 2 : 0.8, xAt(to) - xAt(from));
      svg('rect', { x: xAt(from), y: y + (h - hh) / 2, width: w, height: hh, fill: s === 1 ? OK : s === 2 ? WARN : BAD, rx: 1 }, g);
    }
    for (const b of c.breaks) {
      const x = xAt(b);
      svg('path', { d: `M${x - 4} ${y - 9} l8 8 M${x + 4} ${y - 9} l-8 8`, stroke: BAD, 'stroke-width': 2.2 }, g);
    }
  }

  function drawStatic(g: SVGGElement): void {
    text('Two years of automated renewal', { x: 4, y: 20, fill: MUTED, 'font-size': 17 }, g);
    NAMES.forEach((n, i) => text(n, { x: 4, y: 58 + i * 34, fill: INK, 'font-size': 17, 'font-weight': 600 }, g));
    const y = 248;
    svg('line', { x1: X0, y1: y, x2: X1, y2: y, stroke: STROKE, 'stroke-width': 1.5 }, g);
    for (const [d, label] of [[0, '0'], [365, '1 year'], [730, '2 years']] as const) {
      svg('line', { x1: xAt(d), y1: y, x2: xAt(d), y2: y + 5, stroke: STROKE, 'stroke-width': 1.5 }, g);
      text(label, { x: xAt(d), y: y + 22, 'text-anchor': d === 0 ? 'start' : d === 730 ? 'end' : 'middle', fill: MUTED, 'font-size': 16 }, g);
    }
    const items: [string, string, number][] = [['valid', OK, 14], ['renewal overdue', WARN, 6], ['expired', BAD, 20]];
    let x = 4;
    for (const [label, colour, hh] of items) {
      svg('rect', { x, y: 293 - hh / 2, width: 18, height: hh, rx: 1, fill: colour }, g);
      text(label, { x: x + 24, y: 299, fill: INK, 'font-size': 16 }, g);
      x += 30 + label.length * 8.4;
    }
  }

  return {
    params: [
      { name: 'lifetime', label: 'Certificate lifetime', min: 6, max: 200, step: 1, value: 47, unit: 'days' },
      { name: 'breaks', label: 'Automation breakages per cert per year', min: 0, max: 6, step: 0.5, value: 1 },
      { name: 'alert', label: 'Expiry alert when this many days are left (0 = none)', min: 0, max: 30, step: 1, value: 14 },
      { name: 'fix', label: 'Days for a human to fix it', min: 1, max: 10, step: 1, value: 3 },
      { name: 'outage', label: 'Chance the CA is unreachable on a given day', min: 0, max: 20, step: 1, value: 2, unit: '%' },
    ],

    reset(params, rng: Rng) {
      p = params;
      day = 0;
      acc = 0;
      lastLog = null;
      issued = breakages = failedDays = pages = outageDays = 0;
      reasonOf = new Map();
      breakDays = NAMES.map((_, i) => {
        const days = new Set<number>();
        if (p.breaks > 0) {
          for (let d = rng.exponential(365 / p.breaks); d < DAYS; d += rng.exponential(365 / p.breaks)) {
            const whole = Math.floor(d);
            days.add(whole);
            reasonOf.set(`${i}:${whole}`, rng.pick(BREAK_REASONS));
          }
        }
        return days;
      });
      caDown = new Uint8Array(DAYS);
      for (let d = 0; d < DAYS; d++) caDown[d] = rng.chance(p.outage / 100) ? 1 : 0;
      // Each row starts part-way through a certificate's life, so renewals are spread out.
      certs = NAMES.map(() => ({
        expires: p.lifetime - Math.floor(rng.next() * p.lifetime * 0.6),
        broken: false, fixAt: null, status: new Uint8Array(DAYS), breaks: [],
      }));
    },

    step(dtMs) {
      // About 20 simulated days per real second: two years in a little over half a minute.
      acc += dtMs * 0.02;
      while (acc >= 1 && day < DAYS) {
        simulateDay(day++);
        acc -= 1;
      }
      if (day >= DAYS) acc = 0;
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.childElementCount) drawStatic(base);
      const live = layer(view, 'live');
      clear(live);
      certs.forEach((c, i) => drawRow(live, c, 44 + i * 34, 18));
      if (day > 0 && day < DAYS) svg('line', { x1: xAt(day), y1: 34, x2: xAt(day), y2: 248, stroke: INK, 'stroke-width': 1.2, 'stroke-dasharray': '3 3' }, live);
    },

    stats() {
      return {
        day: Math.min(day, DAYS),
        'certificates issued': issued,
        breakages,
        'failed renewal days': failedDays,
        'pages to humans': pages,
        'days with an expired cert': outageDays,
      };
    },

    log() {
      if (day === 0) return 'Press Play to run two years. The buttons below cause trouble on demand.';
      if (day >= DAYS) return 'Two years done. Change a slider or press Reset to replay the same luck.';
      return lastLog;
    },

    actions: [
      {
        label: 'Break one renewal now',
        run() {
          const i = (day * 7 + 3) % NAMES.length;
          breakDays[i].add(day);
          reasonOf.set(`${i}:${day}`, BREAK_REASONS[day % BREAK_REASONS.length]);
        },
      },
      {
        label: 'CA unreachable for 3 days',
        run() {
          for (let d = day; d < Math.min(DAYS, day + 3); d++) caDown[d] = 1;
          lastLog = `Day ${day}: the CA is unreachable for the next 3 days. Renewals due now will fail and retry.`;
        },
      },
    ],
  };
};
