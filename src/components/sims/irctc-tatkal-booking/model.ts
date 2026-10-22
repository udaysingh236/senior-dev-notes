// The first minute of a Tatkal booking window, with and without a waiting room.
//
// Thousands of users press "Book" within a few seconds of 10:00:00. Each booking takes three
// requests (search, pick a train and class, submit passengers and take seats), with a short pause
// between them while the user reads and types. The booking servers can do a fixed amount of work
// per second.
//
// config.mode picks the picture:
//   'no-queue'      every user talks to the booking servers directly. Requests beyond a short queue
//                   are rejected with an error, which still costs the servers a little work, and the
//                   user presses refresh and tries again. Requests that wait too long time out; the
//                   server still does the work, but nobody is waiting for the answer.
//   'waiting-room'  users land in a queue at the edge, which costs the booking servers nothing. The
//                   queue admits users in arrival order, at a rate the servers can handle, and tells
//                   everyone still waiting the moment the seats are gone.
//   'compare'       both worlds, on exactly the same arrivals and party sizes.
//
// All numbers are illustrative, chosen to show the shape of the problem, not IRCTC's real figures.
import { createRng } from '../../sim/rng';
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { ParamSpec, Rng, SimFactory } from '../../sim/types';

type Mode = 'no-queue' | 'waiting-room' | 'compare';

// User states.
const NOT_ARRIVED = 0;
const IN_ROOM = 1; // waiting room
const THINKING = 2; // will send the next request at nextAt
const IN_FLIGHT = 3; // a request is queued at, or being served by, the booking servers
const TICKET = 4;
const NO_TICKET = 5; // told the quota is gone (waitlist or "not available")

const STEPS = 3; // search, pick, book
const TIMEOUT = 8; // seconds a user waits on a spinning page before pressing refresh
const REJECT_COST = 0.06; // an error still costs the servers some work: TLS, parsing, session lookup
const QUEUE_SECONDS = 2; // the server queue holds about 2 s of work before it rejects
const RUN = 60; // simulated seconds

const INK = token('--viz-ink');
const MUTED = token('--viz-muted');
const STROKE = token('--viz-stroke');
const FLOW = token('--viz-flow');
const OK = token('--viz-ok');
const WARN = token('--viz-warn');
const BAD = token('--viz-bad');

interface Shared {
  arrival: Float64Array; // seconds after 10:00:00, sorted
  party: Uint8Array; // passengers per booking, 1–4
}

interface World {
  room: boolean;
  rng: Rng;
  state: Uint8Array;
  step: Uint8Array;
  nextAt: Float64Array;
  sentAt: Float64Array;
  attempt: Uint32Array;
  sawError: Uint8Array; // 1 while the user is looking at an error page, about to press refresh
  // Server queue as a ring buffer of (user, attempt) pairs.
  qUser: Int32Array;
  qAttempt: Uint32Array;
  qHead: number;
  qLen: number;
  budget: number;
  arrivedUpTo: number; // users with index below this have arrived
  admittedUpTo: number; // waiting room: users below this index were let through
  admitBudget: number;
  seatsLeft: number;
  soldOutAt: number | null;
  tickets: number;
  errors: number; // error pages users saw: rejections and timeouts
  timeouts: number;
  // Server work in the current one-second bucket, and in the last full second.
  work: { useful: number; wasted: number; rejecting: number };
  lastWork: { useful: number; wasted: number; rejecting: number };
  bucketStart: number;
  soldSeries: number[]; // seats sold, one sample per second
  winners: number[]; // arrival index of each user who got a ticket
}

const PARAMS: ParamSpec[] = [
  { name: 'users', label: 'Users pressing Book at 10:00', min: 2000, max: 20000, step: 1000, value: 10000 },
  { name: 'capacity', label: 'Booking server capacity', min: 200, max: 2000, step: 100, value: 600, unit: 'req/s' },
  { name: 'seats', label: 'Tatkal seats in this class', min: 60, max: 180, step: 30, value: 120 },
];

export const createTatkalModel: SimFactory = (config) => {
  const mode = (config.mode as Mode) ?? 'no-queue';

  let p: Record<string, number> = {};
  let t = 0;
  let shared: Shared = { arrival: new Float64Array(0), party: new Uint8Array(0) };
  let worlds: World[] = [];
  let lastLog: string | null = null;

  function makeWorld(room: boolean, seed: number): World {
    const n = p.users;
    const qSize = Math.ceil(p.capacity * QUEUE_SECONDS) + 1;
    return {
      room,
      rng: createRng(seed),
      state: new Uint8Array(n),
      step: new Uint8Array(n),
      nextAt: new Float64Array(n),
      sentAt: new Float64Array(n),
      attempt: new Uint32Array(n),
      sawError: new Uint8Array(n),
      qUser: new Int32Array(qSize),
      qAttempt: new Uint32Array(qSize),
      qHead: 0,
      qLen: 0,
      budget: 0,
      arrivedUpTo: 0,
      admittedUpTo: 0,
      admitBudget: 0,
      seatsLeft: p.seats,
      soldOutAt: null,
      tickets: 0,
      errors: 0,
      timeouts: 0,
      work: { useful: 0, wasted: 0, rejecting: 0 },
      lastWork: { useful: 0, wasted: 0, rejecting: 0 },
      bucketStart: 0,
      soldSeries: [0],
      winners: [],
    };
  }

  const single = () => worlds.length === 1;
  const clock = (s: number) => `10:00:${String(Math.floor(s)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;

  function note(w: World, message: string): void {
    if (single() || w.room === false) lastLog = `${clock(t)} ${message}`;
  }

  /** A user's next action after an error: press refresh in 0.5–2 s. */
  function retry(w: World, u: number): void {
    w.state[u] = THINKING;
    w.nextAt[u] = t + w.rng.range(0.5, 2);
    w.sawError[u] = 1;
    w.errors++;
  }

  function sellOut(w: World): void {
    w.soldOutAt = t;
    note(w, w.room
      ? 'the last seat is gone. Everyone still in the waiting room is told at once, and stops.'
      : 'the last seat is gone, but most users do not know yet: they keep refreshing until a request gets through.');
    if (w.room) {
      // Users still in the room are told "sold out" by the edge; they never reach the servers.
      for (let u = w.admittedUpTo; u < w.arrivedUpTo; u++) w.state[u] = NO_TICKET;
      w.admittedUpTo = p.users;
    }
  }

  /** The booking servers finish a request that someone is still waiting for. */
  function complete(w: World, u: number): void {
    w.sawError[u] = 0;
    if (w.soldOutAt !== null) {
      w.state[u] = NO_TICKET; // any page that loads now says "not available"
      return;
    }
    w.step[u]++;
    if (w.step[u] < STEPS) {
      w.state[u] = THINKING;
      w.nextAt[u] = t + w.rng.range(1, 2.5); // read the page, choose, type
      return;
    }
    const need = shared.party[u];
    if (w.seatsLeft >= need) {
      // Check and take in one step: the inventory can never go below zero.
      w.seatsLeft -= need;
      w.state[u] = TICKET;
      w.tickets++;
      w.winners.push(u);
      if (w.tickets === 1) note(w, `first ticket booked: ${need} seat${need > 1 ? 's' : ''} for user #${u + 1} in arrival order.`);
      if (w.seatsLeft === 0 || (w.seatsLeft < 4 && w.soldOutAt === null && w.seatsLeft < need)) sellOut(w);
    } else {
      w.state[u] = NO_TICKET;
      if (w.soldOutAt === null) sellOut(w);
    }
  }

  function tick(w: World, dt: number): void {
    const n = p.users;
    // Arrivals.
    while (w.arrivedUpTo < n && shared.arrival[w.arrivedUpTo] <= t) {
      const u = w.arrivedUpTo++;
      if (w.soldOutAt !== null && w.room) w.state[u] = NO_TICKET;
      else if (w.room) w.state[u] = IN_ROOM;
      else {
        w.state[u] = THINKING;
        w.nextAt[u] = t;
      }
    }

    // Waiting room: let users through in arrival order, at about 80% of what the servers can take.
    if (w.room && w.soldOutAt === null) {
      w.admitBudget += ((p.capacity * 0.8) / STEPS) * dt;
      while (w.admitBudget >= 1 && w.admittedUpTo < w.arrivedUpTo) {
        const u = w.admittedUpTo++;
        w.state[u] = THINKING;
        w.nextAt[u] = t;
        w.admitBudget -= 1;
      }
      if (w.admittedUpTo === w.arrivedUpTo) w.admitBudget = Math.min(w.admitBudget, 1);
    }

    // Users send requests; timed-out users give up on theirs. Start at a random user each tick,
    // so that free queue slots do not always go to the earliest arrivals.
    const qSize = w.qUser.length;
    const offset = w.arrivedUpTo ? w.rng.int(0, w.arrivedUpTo - 1) : 0;
    for (let k = 0; k < w.arrivedUpTo; k++) {
      const u = (k + offset) % w.arrivedUpTo;
      const s = w.state[u];
      if (s === THINKING && w.nextAt[u] <= t) {
        if (w.qLen >= qSize) {
          // Queue full: an instant error page. Cheap, but not free.
          w.budget -= REJECT_COST;
          w.work.rejecting += REJECT_COST;
          retry(w, u);
          continue;
        }
        w.state[u] = IN_FLIGHT;
        w.sentAt[u] = t;
        const slot = (w.qHead + w.qLen) % qSize;
        w.qUser[slot] = u;
        w.qAttempt[slot] = ++w.attempt[u];
        w.qLen++;
      } else if (s === IN_FLIGHT && t - w.sentAt[u] > TIMEOUT) {
        w.timeouts++;
        retry(w, u); // the request stays in the server's queue: it will be served for nobody
      }
    }

    // The servers work through the queue, oldest first.
    w.budget = Math.min(w.budget + p.capacity * dt, p.capacity * 0.05);
    while (w.budget >= 1 && w.qLen > 0) {
      const u = w.qUser[w.qHead];
      const a = w.qAttempt[w.qHead];
      w.qHead = (w.qHead + 1) % qSize;
      w.qLen--;
      w.budget -= 1;
      if (w.state[u] === IN_FLIGHT && w.attempt[u] === a) {
        w.work.useful++;
        complete(w, u);
      } else {
        w.work.wasted++;
      }
    }

    if (t - w.bucketStart >= 1) {
      w.lastWork = w.work;
      w.work = { useful: 0, wasted: 0, rejecting: 0 };
      w.bucketStart = Math.floor(t);
      w.soldSeries.push(p.seats - w.seatsLeft);
    }
  }

  function counts(w: World) {
    let ticket = 0, booking = 0, room = 0, retrying = 0, none = 0;
    for (let u = 0; u < w.arrivedUpTo; u++) {
      const s = w.state[u];
      if (s === TICKET) ticket++;
      else if (s === NO_TICKET) none++;
      else if (s === IN_ROOM) room++;
      else if (w.sawError[u]) retrying++;
      else booking++;
    }
    return { ticket, booking, room, retrying, none };
  }

  /** Where the winners stood in the arrival order, as "top 3%". */
  function winnersRank(w: World): string {
    if (w.winners.length === 0) return '–';
    const sorted = [...w.winners].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return `${Math.max(1, Math.round(((median + 1) / p.users) * 100))}%`;
  }

  // ---------- drawing ----------

  function seatGrid(g: SVGGElement, w: World, y: number): void {
    const cols = 20;
    const sold = p.seats - w.seatsLeft;
    for (let i = 0; i < p.seats; i++) {
      const x = 10 + (i % cols) * 19;
      const yy = y + Math.floor(i / cols) * 11;
      svg('rect', {
        x, y: yy, width: 16, height: 8, rx: 1.5,
        fill: i < sold ? OK : 'none', stroke: i < sold ? OK : STROKE, 'stroke-width': 1.2,
      }, g);
    }
  }

  function bar(g: SVGGElement, y: number, h: number, parts: [number, string][], total: number): void {
    svg('rect', { x: 10, y, width: 380, height: h, rx: 3, fill: 'none', stroke: STROKE, 'stroke-width': 1.2 }, g);
    let x = 10;
    for (const [v, colour] of parts) {
      const wPx = total > 0 ? (v / total) * 380 : 0;
      if (wPx > 0.3) svg('rect', { x, y, width: wPx, height: h, fill: colour }, g);
      x += wPx;
    }
  }

  function userBar(g: SVGGElement, w: World, y: number): void {
    const c = counts(w);
    bar(g, y, 16, [[c.ticket, OK], [c.booking, FLOW], [c.room, WARN], [c.retrying, BAD], [c.none, STROKE]], p.users);
  }

  function workBar(g: SVGGElement, w: World, y: number): number {
    const lw = t < 1 ? w.work : w.lastWork;
    const total = lw.useful + lw.wasted + lw.rejecting;
    bar(g, y, 16, [[lw.useful, OK], [lw.wasted, WARN], [lw.rejecting, BAD]], Math.max(total, p.capacity));
    return total ? Math.round((lw.useful / total) * 100) : 0;
  }

  function legend(g: SVGGElement, y: number, items: [string, string][]): void {
    let x = 10;
    for (const [label, colour] of items) {
      svg('rect', { x, y: y - 11, width: 12, height: 12, rx: 2, fill: colour }, g);
      text(label, { x: x + 17, y, fill: INK, 'font-size': 16 }, g);
      x += 17 + label.length * 8.4 + 8;
    }
  }

  const USER_KEY: [string, string][] = [['ticket', OK], ['booking', FLOW], ['queue', WARN], ['error', BAD], ['no seat', STROKE]];
  const WORK_KEY: [string, string][] = [['useful', OK], ['nobody waiting', WARN], ['turning away', BAD]];

  function chartAxes(g: SVGGElement, top: number, bottom: number): void {
    svg('line', { x1: 10, y1: bottom, x2: 390, y2: bottom, stroke: STROKE, 'stroke-width': 1.5 }, g);
    svg('line', { x1: 10, y1: top, x2: 10, y2: bottom, stroke: STROKE, 'stroke-width': 1.5 }, g);
    for (const s of [0, 30, 60]) {
      text(`${s} s`, { x: 10 + (s / RUN) * 380, y: bottom + 20, 'text-anchor': s === 0 ? 'start' : s === 60 ? 'end' : 'middle', fill: MUTED, 'font-size': 16 }, g);
    }
    text('seats sold', { x: 10, y: top - 8, fill: MUTED, 'font-size': 16 }, g);
  }

  function soldLine(g: SVGGElement, w: World, top: number, bottom: number, colour: string, dashed: boolean): void {
    const pts = [...w.soldSeries, p.seats - w.seatsLeft];
    const d = pts.map((v, i) => {
      const x = 10 + (Math.min(i === pts.length - 1 ? t : i, RUN) / RUN) * 380;
      const y = bottom - (v / p.seats) * (bottom - top);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    svg('path', { d, fill: 'none', stroke: colour, 'stroke-width': 2.5, 'stroke-dasharray': dashed ? '6 4' : null }, g);
  }

  function renderSingle(view: SVGSVGElement): void {
    const w = worlds[0];
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      text('Users', { x: 10, y: 132, fill: INK, 'font-size': 17, 'font-weight': 600 }, base);
      legend(base, 182, w.room ? USER_KEY : USER_KEY.filter(([k]) => k !== 'queue'));
      text('Server work, last second', { x: 10, y: 212, fill: INK, 'font-size': 17, 'font-weight': 600 }, base);
      legend(base, 256, WORK_KEY);
      chartAxes(base, 290, 340);
    }
    const live = layer(view, 'live');
    clear(live);
    text(clock(Math.min(t, RUN)), { x: 10, y: 22, fill: INK, 'font-size': 20, 'font-weight': 700, 'font-family': 'var(--sl-font-mono)' }, live);
    text(`${w.seatsLeft} of ${p.seats} seats left`, { x: 390, y: 22, 'text-anchor': 'end', fill: w.seatsLeft ? INK : BAD, 'font-size': 17 }, live);
    seatGrid(live, w, 36);
    const c = counts(w);
    const label = w.room ? `${c.room.toLocaleString('en-IN')} in the room` : `${c.retrying.toLocaleString('en-IN')} see an error`;
    text(label, { x: 390, y: 132, 'text-anchor': 'end', fill: w.room ? WARN : BAD, 'font-size': 16, 'font-weight': 600 }, live);
    userBar(live, w, 142);
    const useful = workBar(live, w, 222);
    text(`${useful}% useful`, { x: 390, y: 212, 'text-anchor': 'end', fill: useful > 70 ? OK : BAD, 'font-size': 16, 'font-weight': 600 }, live);
    soldLine(live, w, 290, 340, OK, false);
  }

  function renderCompare(view: SVGSVGElement): void {
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      text('No waiting room', { x: 10, y: 50, fill: INK, 'font-size': 17, 'font-weight': 700 }, base);
      text('Waiting room', { x: 10, y: 144, fill: INK, 'font-size': 17, 'font-weight': 700 }, base);
      text('Top bar: users', { x: 10, y: 238, fill: MUTED, 'font-size': 16 }, base);
      legend(base, 260, USER_KEY);
      text('Bottom bar: server work', { x: 10, y: 288, fill: MUTED, 'font-size': 16 }, base);
      legend(base, 310, WORK_KEY);
      chartAxes(base, 342, 392);
      svg('line', { x1: 196, y1: 432, x2: 224, y2: 432, stroke: BAD, 'stroke-width': 2.5, 'stroke-dasharray': '6 4' }, base);
      text('no room', { x: 230, y: 437, fill: INK, 'font-size': 16 }, base);
      svg('line', { x1: 306, y1: 432, x2: 334, y2: 432, stroke: OK, 'stroke-width': 2.5 }, base);
      text('room', { x: 340, y: 437, fill: INK, 'font-size': 16 }, base);
    }
    const live = layer(view, 'live');
    clear(live);
    text(clock(Math.min(t, RUN)), { x: 10, y: 22, fill: INK, 'font-size': 20, 'font-weight': 700, 'font-family': 'var(--sl-font-mono)' }, live);
    worlds.forEach((w, i) => {
      const top = 50 + i * 94;
      const status = w.soldOutAt !== null ? `sold out at ${w.soldOutAt.toFixed(1)} s` : `${p.seats - w.seatsLeft} of ${p.seats} sold`;
      text(status, { x: 390, y: top, 'text-anchor': 'end', fill: w.soldOutAt !== null ? OK : INK, 'font-size': 16, 'font-weight': 600 }, live);
      userBar(live, w, top + 10);
      const useful = workBar(live, w, top + 32);
      text(`${w.errors.toLocaleString('en-IN')} error pages · ${useful}% useful`, { x: 10, y: top + 70, fill: w.errors ? BAD : OK, 'font-size': 16 }, live);
    });
    soldLine(live, worlds[0], 342, 392, BAD, true);
    soldLine(live, worlds[1], 342, 392, OK, false);
  }

  return {
    params: PARAMS,

    reset(params, rng) {
      p = params;
      t = 0;
      lastLog = null;
      // Most users click within a second or two of 10:00:00; a long tail arrives later.
      const arrival = new Float64Array(p.users);
      for (let u = 0; u < p.users; u++) arrival[u] = rng.chance(0.85) ? rng.exponential(0.8) : rng.range(0, 20);
      arrival.sort();
      const party = new Uint8Array(p.users);
      for (let u = 0; u < p.users; u++) party[u] = rng.pick([1, 2, 2, 3, 4, 4]);
      shared = { arrival, party };
      const seed = rng.int(1, 1e9);
      if (mode === 'compare') worlds = [makeWorld(false, seed), makeWorld(true, seed)];
      else worlds = [makeWorld(mode === 'waiting-room', seed)];
    },

    step(dtMs) {
      if (t >= RUN) return;
      const dt = dtMs / 1000;
      t += dt;
      for (const w of worlds) tick(w, dt);
    },

    render(view) {
      if (mode === 'compare') renderCompare(view);
      else renderSingle(view);
    },

    stats() {
      if (mode === 'compare') {
        const [a, b] = worlds;
        const out = (w: World) => (w.soldOutAt !== null ? `${w.soldOutAt.toFixed(1)} s` : 'not yet');
        return {
          'no room: sold out at': out(a),
          'room: sold out at': out(b),
          'no room: error pages': a.errors,
          'room: error pages': b.errors,
          'no room: median winner arrived in the first': winnersRank(a),
          'room: median winner arrived in the first': winnersRank(b),
        };
      }
      const w = worlds[0];
      return {
        tickets: w.tickets,
        'seats sold': p.seats - w.seatsLeft,
        'error pages shown': w.errors,
        timeouts: w.timeouts,
        'median winner arrived in the first': winnersRank(w),
      };
    },

    log() {
      if (t === 0) return 'Press Play: the Tatkal window opens at 10:00:00.';
      if (t >= RUN) return 'One minute done. Change a slider, or press Reset to replay the same rush.';
      return lastLog;
    },
  };
};
