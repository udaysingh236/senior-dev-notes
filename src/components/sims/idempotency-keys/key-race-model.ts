// Four ways to store an idempotency key, fed exactly the same payments, server times and crashes.
//
// Each payment is one charge a user meant to make once. The client sends it with a key, waits
// up to the client timeout, and on a timeout, a 409 or a dropped connection retries with the same
// key, up to 4 times, waiting 0.5, 1, 2, 4 s. The server takes a random time per attempt
// (lognormal around the median) and calls the bank halfway through. Some attempts crash: the
// process dies at a random point, before or after the bank call.
//
//   check    look the key up; if absent, charge, then record the key. No lock.
//   lock     insert the key first (unique), 409 while it exists unfinished. No lease.
//   rerun    as lock, but the lock is a lease: after it ends, a retry takes over and runs the
//            whole operation again. The original's late finish is fenced off.
//   resume   as rerun, but the bank call carries a downstream key derived from the payment, so
//            the takeover's call returns the first charge instead of making a second one.
//
// What the reader controls: server time, client timeout, crash rate, lease. What they watch:
// which designs charge twice (races, crash windows, short leases) and which leave payments stuck.
import { clear, layer, svg, text, token } from '../../sim/svg';
import { createRng } from '../../sim/rng';
import type { Rng, SimFactory } from '../../sim/types';

type Design = 'check' | 'lock' | 'rerun' | 'resume';
const LANES: { id: Design; title: string }[] = [
  { id: 'check', title: 'Check the key, then charge' },
  { id: 'lock', title: 'Lock the key, no lease' },
  { id: 'rerun', title: 'Lease, rerun everything on takeover' },
  { id: 'resume', title: 'Lease + downstream key to the bank' },
];
const EVERY_MS = 250; // a new payment every 250 ms of sim time
const RETRIES = 4;
const BACKOFF_S = [0.5, 1, 2, 4];
const SIGMA = 0.6; // spread of server time: p99 is about 4× the median
const SHOW = 40; // squares per lane

type Outcome = 'ok' | 'double' | 'unknown' | 'failed';
const TONE: Record<Outcome, string> = { ok: 'ok', double: 'bad', unknown: 'warn', failed: 'stroke' };

/** One payment's random draws, shared by every lane so they see the same world. */
interface Draws {
  work: number[]; // server time per attempt, s
  crash: boolean[];
  crashAt: number[]; // fraction of the server time at which the process dies
}

function normal(rng: Rng): number {
  const u = Math.max(1e-12, rng.next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

interface Result {
  outcome: Outcome;
  overlap: boolean; // a retry reached the server while an earlier attempt was still running
  stuck: boolean; // the key is locked forever by an attempt that died
}

/** Plays one payment through one design as a small discrete-event simulation. */
function simulate(design: Design, d: Draws, p: Record<string, number>): Result {
  type Ev = { t: number; kind: 'start' | 'charge' | 'finish' | 'crash' | 'timeout'; k: number };
  const events: Ev[] = [];
  const at = (t: number, kind: Ev['kind'], k: number) => events.push({ t, kind, k });

  let committed = false;
  let record: { owner: number; until: number } | null = null; // the unfinished key row
  let charges = 0;
  let bankCharged = false;
  let told = false;
  let done = false;
  let current = 0;
  const answered: boolean[] = [];
  const running = new Set<number>();
  let overlap = false;

  const retry = (t: number) => {
    if (current >= RETRIES) {
      done = true; // the client gives up and shows an error
      return;
    }
    current += 1;
    at(t + BACKOFF_S[current - 1], 'start', current);
  };
  const respond = (k: number, ok: boolean, t: number) => {
    if (done || k !== current || answered[k]) return; // nobody is waiting for this answer
    answered[k] = true;
    if (ok) {
      told = true;
      done = true;
    } else retry(t);
  };
  const run = (k: number, t: number) => {
    running.add(k);
    const w = d.work[k];
    if (d.crash[k]) {
      at(t + d.crashAt[k] * w, 'crash', k);
      if (d.crashAt[k] > 0.5) at(t + 0.5 * w, 'charge', k);
    } else {
      at(t + 0.5 * w, 'charge', k);
      at(t + w, 'finish', k);
    }
  };

  at(0, 'start', 0);
  for (let guard = 0; events.length && guard < 200; guard++) {
    events.sort((a, b) => a.t - b.t);
    const e = events.shift()!;
    switch (e.kind) {
      case 'start': {
        if (running.size) overlap = true;
        at(e.t + p.timeout, 'timeout', e.k);
        if (committed) respond(e.k, true, e.t); // replay the stored response
        else if (design === 'check') run(e.k, e.t);
        else if (design === 'lock') {
          if (record) respond(e.k, false, e.t); // 409, and nothing ever releases it
          else {
            record = { owner: e.k, until: Infinity };
            run(e.k, e.t);
          }
        } else if (record && e.t < record.until) respond(e.k, false, e.t); // 409 inside the lease
        else {
          record = { owner: e.k, until: e.t + p.lease }; // claim, or take over an expired lease
          run(e.k, e.t);
        }
        break;
      }
      case 'charge':
        if (design === 'resume') {
          if (!bankCharged) charges += 1; // the bank recognises its own key on a repeat
          bankCharged = true;
        } else charges += 1;
        break;
      case 'finish': {
        running.delete(e.k);
        const fenced = (design === 'rerun' || design === 'resume') && record?.owner !== e.k;
        if (!fenced) {
          committed = true;
          record = null;
        }
        respond(e.k, committed && !fenced, e.t);
        break;
      }
      case 'crash':
        running.delete(e.k);
        respond(e.k, false, e.t); // the connection drops; the key row stays as it was
        break;
      case 'timeout':
        respond(e.k, false, e.t);
        break;
    }
  }
  const outcome: Outcome = charges > 1 ? 'double' : charges === 1 ? (told ? 'ok' : 'unknown') : 'failed';
  return { outcome, overlap, stuck: design === 'lock' && record !== null && !committed };
}

class Lane {
  outcomes: Outcome[] = [];
  counts: Record<Outcome, number> = { ok: 0, double: 0, unknown: 0, failed: 0 };
  stuck = 0;
  constructor(public design: Design) {}
  add(r: Result): void {
    this.counts[r.outcome]++;
    if (r.stuck) this.stuck++;
    this.outcomes.push(r.outcome);
    if (this.outcomes.length > SHOW) this.outcomes.shift();
  }
}

export const createKeyRaceModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let next = 0;
  let lanes: Lane[] = [];
  let payments = 0;
  let overlaps = 0;
  let lastEvent: string | null = null;

  function draw(): Draws {
    const d: Draws = { work: [], crash: [], crashAt: [] };
    for (let k = 0; k <= RETRIES; k++) {
      d.work.push(p.work * Math.exp(SIGMA * normal(rng)));
      d.crash.push(rng.chance(p.crash / 100));
      d.crashAt.push(rng.next());
    }
    return d;
  }

  return {
    params: [
      { name: 'work', label: 'Server time (median)', min: 0.2, max: 3, step: 0.1, value: 0.8, unit: 's' },
      { name: 'timeout', label: 'Client timeout', min: 0.5, max: 5, step: 0.25, value: 2, unit: 's' },
      { name: 'crash', label: 'Attempts that crash', min: 0, max: 10, step: 1, value: 3, unit: '%' },
      { name: 'lease', label: 'Lease', min: 0.5, max: 10, step: 0.5, value: 5, unit: 's' },
    ],

    reset(params, r) {
      p = params;
      rng = createRng(Math.floor(r.next() * 1e9));
      t = 0;
      next = 0;
      payments = 0;
      overlaps = 0;
      lanes = LANES.map((l) => new Lane(l.id));
      lastEvent = 'Each square is one payment a user meant to make once.';
    },

    step(dt) {
      t += dt;
      while (next <= t) {
        const d = draw();
        payments++;
        lanes.forEach((lane, i) => {
          const r = simulate(lane.design, d, p);
          if (i === 0 && r.overlap) overlaps++;
          lane.add(r);
          if (r.outcome === 'double') lastEvent = `Payment #${payments}: "${LANES[i].title}" charged twice.`;
        });
        next += EVERY_MS;
      }
    },

    render(view) {
      const laneH = 92;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        LANES.forEach((l, i) =>
          text(l.title, { x: 4, y: i * laneH + 18, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base),
        );
      }
      const live = layer(view, 'live');
      clear(live);
      lanes.forEach((lane, i) => {
        const y = i * laneH + 26;
        lane.outcomes.forEach((o, k) => {
          const x = 4 + (k % 20) * 19.6;
          const yy = y + Math.floor(k / 20) * 20;
          svg('rect', {
            x, y: yy, width: 16, height: 16, rx: 3,
            fill: o === 'failed' ? 'none' : token(`--viz-${TONE[o]}-soft`),
            stroke: token(`--viz-${TONE[o]}`), 'stroke-width': 1.5,
          }, live);
          if (o === 'double') {
            text('×2', { x: x + 8, y: yy + 12.5, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'middle', fill: token('--viz-bad') }, live);
          }
        });
        const c = lane.counts;
        const parts = [`charged twice ${c.double}`, `paid, told error ${c.unknown}`, `unpaid ${c.failed}`];
        text(parts.join(' · '), {
          x: 4, y: y + 58, 'font-size': 15, fill: c.double ? token('--viz-bad') : token('--viz-muted'),
        }, live);
      });
    },

    stats() {
      const out: Record<string, string | number> = {
        payments,
        'a retry overlapped a running attempt': overlaps,
      };
      const names: Record<Design, string> = { check: 'check', lock: 'lock', rerun: 'lease + rerun', resume: 'lease + bank key' };
      for (const lane of lanes) out[`${names[lane.design]}: charged twice`] = lane.counts.double;
      out['lock: keys stuck forever'] = lanes[1]?.stuck ?? 0;
      return out;
    },

    log: () => lastEvent,
  };
};
