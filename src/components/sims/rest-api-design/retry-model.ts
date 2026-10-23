// A client sends POST /payments over a network that loses some requests and some responses. A
// lost request never reaches the server; a lost response means the server charged but the client
// only sees a timeout. Three clients on the same network:
//   never retry       a timeout is shown to the user as a failure
//   retry, no key     a timeout is retried; the server treats each arrival as a new payment
//   retry with key    the same Idempotency-Key on every attempt; the server charges once and
//                     replays the stored response
import { clear, layer, svg, text, token } from '../../sim/svg';
import { createRng } from '../../sim/rng';
import type { Rng, SimFactory } from '../../sim/types';

type Kind = 'never' | 'nokey' | 'key';
const LANES: { id: Kind; title: string }[] = [
  { id: 'never', title: 'Never retry' },
  { id: 'nokey', title: 'Retry on timeout, no key' },
  { id: 'key', title: 'Retry with an Idempotency-Key' },
];
const EVERY_MS = 250; // one payment attempt by a user every 250 ms of sim time
const SHOW = 40;

type Outcome = 'ok' | 'double' | 'unknown' | 'failed';

class Lane {
  kind: Kind;
  rng: Rng;
  outcomes: Outcome[] = [];
  counts: Record<Outcome, number> = { ok: 0, double: 0, unknown: 0, failed: 0 };
  extraCharges = 0;
  constructor(kind: Kind, seed: number) {
    this.kind = kind;
    this.rng = createRng(seed);
  }

  pay(p: Record<string, number>): void {
    const attempts = this.kind === 'never' ? 1 : 1 + p.retries;
    let charges = 0;
    let told = false;
    for (let a = 0; a < attempts && !told; a++) {
      const requestLost = this.rng.chance(p.reqLoss / 100);
      const responseLost = this.rng.chance(p.respLoss / 100);
      if (requestLost) continue; // the server never saw it; the client times out
      if (this.kind !== 'key' || charges === 0) charges++; // with a key, a repeat is replayed
      if (!responseLost) told = true;
    }
    const o: Outcome = charges > 1 ? 'double' : charges === 1 ? (told ? 'ok' : 'unknown') : 'failed';
    this.extraCharges += Math.max(0, charges - 1);
    this.counts[o]++;
    this.outcomes.push(o);
    if (this.outcomes.length > SHOW) this.outcomes.shift();
  }
}

const TONE: Record<Outcome, string> = { ok: 'ok', double: 'bad', unknown: 'warn', failed: 'stroke' };

export const createRetryModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let t = 0;
  let next = 0;
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'reqLoss', label: 'Requests lost', min: 0, max: 40, step: 5, value: 10, unit: '%' },
      { name: 'respLoss', label: 'Responses lost', min: 0, max: 40, step: 5, value: 15, unit: '%' },
      { name: 'retries', label: 'Retries after a timeout', min: 1, max: 3, step: 1, value: 2 },
    ],

    reset(params, r) {
      p = params;
      t = 0;
      next = 0;
      const seed = Math.floor(r.next() * 1e9);
      lanes = LANES.map((l) => new Lane(l.id, seed)); // same losses in every lane
      lastEvent = 'Each square is one payment a user meant to make once.';
    },

    step(dt) {
      t += dt;
      while (next <= t) {
        for (const lane of lanes) lane.pay(p);
        next += EVERY_MS;
      }
      const nk = lanes[1];
      if (nk.counts.double) lastEvent = `Without a key, ${nk.counts.double} customers were charged more than once.`;
    },

    render(view) {
      const laneH = 104;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        LANES.forEach((l, i) => text(l.title, { x: 4, y: i * laneH + 20, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, base));
      }
      const live = layer(view, 'live');
      clear(live);
      lanes.forEach((lane, i) => {
        const y = i * laneH + 30;
        lane.outcomes.forEach((o, k) => {
          const x = 4 + (k % 20) * 19.6;
          const yy = y + Math.floor(k / 20) * 20;
          svg('rect', {
            x, y: yy, width: 16, height: 16, rx: 3,
            fill: o === 'failed' ? 'none' : token(`--viz-${TONE[o]}-soft`),
            stroke: token(`--viz-${TONE[o]}`), 'stroke-width': 1.5,
          }, live);
          if (o === 'double') text('×2', { x: x + 8, y: yy + 12.5, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'middle', fill: token('--viz-bad') }, live);
        });
        const c = lane.counts;
        text(`charged twice: ${c.double} · paid, user saw error: ${c.unknown} · not paid: ${c.failed}`, {
          x: 4, y: y + 62, 'font-size': 15, fill: c.double ? token('--viz-bad') : token('--viz-muted'),
        }, live);
      });
    },

    stats() {
      const c0 = lanes[0].counts;
      const out: Record<string, string | number> = { payments: c0.ok + c0.double + c0.unknown + c0.failed };
      const names: Record<Kind, string> = { never: 'never retry', nokey: 'no key', key: 'with key' };
      for (const lane of lanes) {
        out[`${names[lane.kind]}: charged twice`] = lane.counts.double;
        out[`${names[lane.kind]}: paid but user saw error`] = lane.counts.unknown;
      }
      return out;
    },

    log: () => lastEvent,
  };
};
