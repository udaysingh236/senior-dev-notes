// Six certificates over two years, renewed by hand or by automation. Each row is one certificate's
// timeline: green while valid, a thin amber stretch while its renewal is overdue, a tall red stretch
// while it has expired and users see certificate errors.
//
// config.mode picks the picture:
//   'automated'  ACME-style renewal at two-thirds of the lifetime, retried daily. Automation can
//                break (a red cross); it stays broken until an expiry alert, or an outage, gets a
//                human to fix it, which takes "human fix time" days.
//   'manual'     a person renews when a reminder arrives, a third of the lifetime before expiry
//                (at most 30 days). Sometimes the reminder is missed, and nobody notices until expiry.
//   'compare'    manual 200-day, automated 90-day and automated 6-day certificates on exactly the
//                same breakages, CA outage days and missed reminders.
//
// Every random event is drawn in reset() from the seeded RNG, so Reset replays the same two years
// and every lane in compare mode suffers the same bad luck.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { ParamSpec, Rng, SimFactory } from '../../sim/types';

type Mode = 'automated' | 'manual' | 'compare';
type Status = 0 | 1 | 2 | 3; // not yet simulated, valid, renewal overdue, expired

interface Policy {
  kind: 'auto' | 'manual';
  lifetime: number; // days
  alertDays: number; // auto: page a human when an overdue cert has this many days left; 0 = no alert
  label: string;
}

interface Cert {
  issued: number;
  expires: number;
  cycle: number; // how many certificates this row has had; indexes the per-cycle random draws
  broken: boolean;
  fixAt: number | null;
  renewOn: number | null; // manual: the day the person will renew, or null if the reminder was missed
  status: Uint8Array; // per day
  breaks: number[]; // days the automation broke, for the red crosses
}

interface Lane {
  policy: Policy;
  certs: Cert[];
  issued: number;
  failedDays: number;
  breakages: number;
  pages: number;
  missed: number;
  outageDays: number;
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

const PARAMS: Record<Mode, ParamSpec[]> = {
  automated: [
    { name: 'lifetime', label: 'Certificate lifetime', min: 6, max: 200, step: 1, value: 90, unit: 'days' },
    { name: 'breaks', label: 'Automation breakages per cert per year', min: 0, max: 6, step: 0.5, value: 1 },
    { name: 'alert', label: 'Expiry alert when this many days are left (0 = none)', min: 0, max: 30, step: 1, value: 14 },
    { name: 'fix', label: 'Days for a human to fix it', min: 1, max: 10, step: 1, value: 3 },
    { name: 'outage', label: 'Chance the CA is unreachable on a given day', min: 0, max: 20, step: 1, value: 2, unit: '%' },
  ],
  manual: [
    { name: 'lifetime', label: 'Certificate lifetime', min: 30, max: 398, step: 1, value: 200, unit: 'days' },
    { name: 'miss', label: 'Chance a renewal reminder is missed', min: 0, max: 30, step: 1, value: 10, unit: '%' },
    { name: 'fix', label: 'Days to renew once users report errors', min: 1, max: 10, step: 1, value: 2 },
  ],
  compare: [
    { name: 'breaks', label: 'Automation breakages per cert per year', min: 0, max: 6, step: 0.5, value: 1.5 },
    { name: 'miss', label: 'Chance a manual renewal reminder is missed', min: 0, max: 30, step: 1, value: 10, unit: '%' },
    { name: 'fix', label: 'Days for a human to fix a problem', min: 1, max: 10, step: 1, value: 3 },
    { name: 'outage', label: 'Chance the CA is unreachable on a given day', min: 0, max: 20, step: 1, value: 3, unit: '%' },
  ],
};

export const createCertModel: SimFactory = (config) => {
  const mode = (config.mode as Mode) ?? 'automated';

  let p: Record<string, number> = {};
  let day = 0; // next day to simulate
  let acc = 0;
  let lanes: Lane[] = [];
  // Shared bad luck, drawn once per reset.
  let breakDays: Set<number>[] = [];
  let caDown: Uint8Array = new Uint8Array(DAYS);
  let missDraws: number[][] = []; // per cert, per cycle: < miss% means the reminder is missed
  let delayDraws: number[][] = []; // per cert, per cycle: 0..1, how long the person takes
  let reasonOf = new Map<string, string>();
  let lastLog: string | null = null;

  function policies(): Policy[] {
    if (mode === 'automated') return [{ kind: 'auto', lifetime: p.lifetime, alertDays: p.alert, label: '' }];
    if (mode === 'manual') return [{ kind: 'manual', lifetime: p.lifetime, alertDays: 0, label: '' }];
    return [
      { kind: 'manual', lifetime: 200, alertDays: 0, label: 'Manual, 200 days' },
      { kind: 'auto', lifetime: 90, alertDays: 14, label: 'Automated, 90 days' },
      { kind: 'auto', lifetime: 6, alertDays: 2, label: 'Automated, 6 days' },
    ];
  }

  /** Renewal starts at two-thirds of the lifetime (automation) or at the reminder (manual). */
  function renewWindow(pol: Policy): number {
    return pol.kind === 'auto' ? Math.max(1, Math.round(pol.lifetime / 3)) : Math.min(30, Math.round(pol.lifetime / 3));
  }

  function newCert(pol: Policy, i: number, issued: number, cycle: number, status?: Uint8Array, breaks?: number[]): Cert {
    // Stagger the first certificates so the rows do not all renew on the same day.
    const c: Cert = {
      issued, expires: issued + pol.lifetime, cycle, broken: false, fixAt: null, renewOn: null,
      status: status ?? new Uint8Array(DAYS), breaks: breaks ?? [],
    };
    if (pol.kind === 'manual') planManual(pol, c, i);
    return c;
  }

  function planManual(pol: Policy, c: Cert, i: number): void {
    const reminder = c.expires - renewWindow(pol);
    const missed = missDraws[i][c.cycle % missDraws[i].length] < p.miss / 100;
    // People renew some days after the reminder, never on the last day by choice.
    c.renewOn = missed ? null : reminder + Math.floor(delayDraws[i][c.cycle % delayDraws[i].length] * (renewWindow(pol) - 1));
  }

  function renew(lane: Lane, i: number, d: number): void {
    const c = lane.certs[i];
    const next = newCert(lane.policy, i, d, c.cycle + 1, c.status, c.breaks);
    next.broken = c.broken;
    lane.certs[i] = next;
    lane.issued++;
  }

  function simulateDay(d: number): void {
    const outage = caDown[d] === 1;
    for (const lane of lanes) {
      const pol = lane.policy;
      lane.certs.forEach((c, i) => {
        const name = NAMES[i];
        if (pol.kind === 'auto') {
          if (breakDays[i].has(d) && !c.broken) {
            c.broken = true;
            c.breaks.push(d);
            lane.breakages++;
            if (lanes.length === 1) lastLog = `Day ${d}: renewal automation for "${name}" broke: ${reasonOf.get(`${i}:${d}`)}. Nobody notices yet.`;
          }
          if (c.fixAt !== null && d >= c.fixAt) {
            c.broken = false;
            c.fixAt = null;
            if (lanes.length === 1) lastLog = `Day ${d}: a human fixed the renewal for "${name}".`;
          }
          const renewAt = c.expires - renewWindow(pol);
          if (d >= renewAt) {
            if (!c.broken && !outage) renew(lane, i, d);
            else lane.failedDays++;
          }
          const cur = lane.certs[i];
          const left = cur.expires - d;
          const overdue = d >= cur.expires - renewWindow(pol);
          const alerted = pol.alertDays > 0 && overdue && left <= pol.alertDays;
          if (cur.broken && cur.fixAt === null && (alerted || left <= 0)) {
            cur.fixAt = d + p.fix;
            lane.pages++;
            if (lanes.length === 1) {
              lastLog = left <= 0
                ? `Day ${d}: "${name}" EXPIRED with no alert. Users report certificate errors; a fix takes ${p.fix} days.`
                : `Day ${d}: "${name}" is overdue with ${left} days left: the expiry alert pages someone.`;
            }
          }
        } else {
          if (c.renewOn !== null && d >= c.renewOn) renew(lane, i, d);
          else if (c.renewOn === null && d >= c.expires) {
            c.renewOn = d + p.fix; // users noticed; someone renews in a hurry
            lane.missed++;
            if (lanes.length === 1) lastLog = `Day ${d}: "${name}" EXPIRED. The reminder went to someone who has left. It takes ${p.fix} days to sort out.`;
          } else if (c.renewOn === null && d === c.expires - renewWindow(pol) && lanes.length === 1) {
            lastLog = `Day ${d}: the renewal reminder for "${name}" was missed. It still has ${c.expires - d} days left.`;
          }
        }
        const cur = lane.certs[i];
        const left = cur.expires - d;
        const status: Status = left <= 0 ? 3 : d >= cur.expires - renewWindow(pol) ? 2 : 1;
        cur.status[d] = status;
        if (status === 3) lane.outageDays++;
      });
    }
    if (outage && lanes.length === 1 && lanes[0].policy.kind === 'auto') {
      const waiting = lanes[0].certs.filter((c) => d >= c.expires - renewWindow(lanes[0].policy)).length;
      if (waiting) lastLog = `Day ${d}: the CA is unreachable. ${waiting} renewal${waiting > 1 ? 's' : ''} due today fail and will retry tomorrow.`;
    }
  }

  // ---------- drawing ----------

  const X0 = mode === 'compare' ? 4 : 86; // single mode leaves room for row names
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

  function drawAxis(g: SVGGElement, y: number): void {
    svg('line', { x1: X0, y1: y, x2: X1, y2: y, stroke: STROKE, 'stroke-width': 1.5 }, g);
    for (const [d, label] of [[0, '0'], [365, '1 year'], [730, '2 years']] as const) {
      svg('line', { x1: xAt(d), y1: y, x2: xAt(d), y2: y + 5, stroke: STROKE, 'stroke-width': 1.5 }, g);
      text(label, { x: xAt(d), y: y + 22, 'text-anchor': d === 0 ? 'start' : d === 730 ? 'end' : 'middle', fill: MUTED, 'font-size': 16 }, g);
    }
  }

  function drawLegend(g: SVGGElement, y: number): void {
    const items: [string, string, number][] = [['valid', OK, 14], ['renewal overdue', WARN, 6], ['expired', BAD, 20]];
    let x = 4;
    for (const [label, colour, hh] of items) {
      svg('rect', { x, y: y - 7 - hh / 2, width: 18, height: hh, rx: 1, fill: colour }, g);
      text(label, { x: x + 24, y: y - 1, fill: INK, 'font-size': 16 }, g);
      x += 30 + label.length * 8.4;
    }
  }

  function renderSingle(view: SVGSVGElement): void {
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      text(mode === 'automated' ? 'Two years of automated renewal' : 'Two years of renewal by hand', { x: 4, y: 20, fill: MUTED, 'font-size': 17 }, base);
      NAMES.forEach((n, i) => text(n, { x: 4, y: 58 + i * 34, fill: INK, 'font-size': 17, 'font-weight': 600 }, base));
      drawAxis(base, 248);
      drawLegend(base, 300);
    }
    const live = layer(view, 'live');
    clear(live);
    lanes[0].certs.forEach((c, i) => drawRow(live, c, 44 + i * 34, 18));
    if (day > 0 && day < DAYS) svg('line', { x1: xAt(day), y1: 34, x2: xAt(day), y2: 248, stroke: INK, 'stroke-width': 1.2, 'stroke-dasharray': '3 3' }, live);
  }

  function renderCompare(view: SVGSVGElement): void {
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      lanes.forEach((lane, li) => text(lane.policy.label, { x: 4, y: 18 + li * 112, fill: INK, 'font-size': 17, 'font-weight': 700 }, base));
      drawAxis(base, 342);
      drawLegend(base, 392);
    }
    const live = layer(view, 'live');
    clear(live);
    lanes.forEach((lane, li) => {
      const top = 30 + li * 112;
      const extra = lane.policy.kind === 'manual' ? `${lane.issued} by hand` : `${lane.pages} pages`;
      text(`${lane.outageDays} days down · ${extra}`, {
        x: 396, y: top - 12, 'text-anchor': 'end', fill: lane.outageDays ? BAD : OK, 'font-size': 17, 'font-weight': 700,
      }, live);
      lane.certs.forEach((c, i) => drawRow(live, c, top + 4 + i * 14, 8));
    });
    if (day > 0 && day < DAYS) svg('line', { x1: xAt(day), y1: 24, x2: xAt(day), y2: 342, stroke: INK, 'stroke-width': 1.2, 'stroke-dasharray': '3 3' }, live);
  }

  return {
    params: PARAMS[mode],

    reset(params, rng: Rng) {
      p = params;
      day = 0;
      acc = 0;
      lastLog = null;
      reasonOf = new Map();
      const rate = p.breaks ?? 0;
      breakDays = NAMES.map((_, i) => {
        const days = new Set<number>();
        if (rate > 0) {
          for (let d = rng.exponential(365 / rate); d < DAYS; d += rng.exponential(365 / rate)) {
            const whole = Math.floor(d);
            days.add(whole);
            reasonOf.set(`${i}:${whole}`, rng.pick(BREAK_REASONS));
          }
        }
        return days;
      });
      caDown = new Uint8Array(DAYS);
      const outage = (p.outage ?? 0) / 100;
      for (let d = 0; d < DAYS; d++) caDown[d] = rng.chance(outage) ? 1 : 0;
      missDraws = NAMES.map(() => Array.from({ length: 40 }, () => rng.next()));
      delayDraws = NAMES.map(() => Array.from({ length: 40 }, () => rng.next()));
      const stagger = NAMES.map(() => rng.next());
      lanes = policies().map((policy) => ({
        policy,
        // Each row starts part-way through a certificate's life, so renewals are spread out.
        certs: NAMES.map((_, i) => newCert(policy, i, -Math.floor(stagger[i] * policy.lifetime * 0.6), 0)),
        issued: 0, failedDays: 0, breakages: 0, pages: 0, missed: 0, outageDays: 0,
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
      if (mode === 'compare') renderCompare(view);
      else renderSingle(view);
    },

    stats() {
      if (mode === 'compare') {
        const [m, a90, a6] = lanes;
        return {
          'manual: days down': m.outageDays,
          'manual: renewals by hand': m.issued,
          '90-day: days down': a90.outageDays,
          '6-day: days down': a6.outageDays,
          'CA outage days so far': caDown.slice(0, day).reduce((s, v) => s + v, 0),
        };
      }
      const lane = lanes[0];
      if (mode === 'manual') {
        return {
          day: Math.min(day, DAYS),
          'renewals by hand': lane.issued,
          'missed reminders': lane.missed,
          'days with an expired cert': lane.outageDays,
        };
      }
      return {
        day: Math.min(day, DAYS),
        'certificates issued': lane.issued,
        breakages: lane.breakages,
        'failed renewal days': lane.failedDays,
        'pages to humans': lane.pages,
        'days with an expired cert': lane.outageDays,
      };
    },

    log() {
      if (day === 0) return 'Press Play to run two years. The buttons below cause trouble on demand.';
      if (day >= DAYS) return 'Two years done. Change a slider or press Reset to replay the same luck.';
      return lastLog;
    },

    actions: [
      {
        label: mode === 'manual' ? 'Miss the next reminder' : 'Break one renewal now',
        run() {
          const i = (day * 7 + 3) % NAMES.length;
          if (mode === 'manual') {
            lanes[0].certs[i].renewOn = null; // the current certificate will not be renewed in time
            lastLog = `Day ${day}: whoever owned "${NAMES[i]}" has left. Its next reminder will go nowhere.`;
            return;
          }
          breakDays[i].add(day);
          reasonOf.set(`${i}:${day}`, BREAK_REASONS[day % BREAK_REASONS.length]);
        },
      },
      ...(mode === 'manual'
        ? []
        : [{
            label: 'CA unreachable for 3 days',
            run() {
              for (let d = day; d < Math.min(DAYS, day + 3); d++) caDown[d] = 1;
              lastLog = `Day ${day}: the CA is unreachable for the next 3 days. Renewals due now will fail and retry.`;
            },
          }]),
    ],
  };
};
