// Many booking transactions race for the same journey on one coach of 8 berths. Four ways to
// write the transaction, run on the same arrivals:
//   naive        read a free berth, do the work, then write it (no lock, no check)
//   coach lock   SELECT ... FOR UPDATE on the whole coach: one transaction at a time
//   conditional  read, do the work, then UPDATE ... WHERE mask & need = 0; 0 rows -> next berth
//   skip locked  lock one free row with FOR UPDATE SKIP LOCKED, do the work, commit
// Time runs 25x slower than real so the reader can watch a 20 ms transaction.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

type Strategy = 'naive' | 'coach' | 'conditional' | 'skip';
const STRATEGIES: { id: Strategy; title: string }[] = [
  { id: 'naive', title: 'Read, work, write' },
  { id: 'coach', title: 'Lock the coach (FOR UPDATE)' },
  { id: 'conditional', title: 'Conditional UPDATE, retry' },
  { id: 'skip', title: 'FOR UPDATE SKIP LOCKED' },
];
const BERTHS = 8;
const SLOW = 25; // sim ms per model ms
const RETRY_MS = 1; // one more UPDATE statement

type Phase = 'waiting' | 'working' | 'done' | 'failed';
interface Txn {
  id: number;
  arrive: number;
  phase: Phase;
  berth: number;
  workEnd: number;
  finished: number;
}

class Lane {
  sold: number[] = Array(BERTHS).fill(0); // how many transactions think they own the berth
  rowLock: number[] = Array(BERTHS).fill(0); // txn id holding the row, 0 = none
  coachHolder = 0;
  txns: Txn[] = [];
  retries = 0;
  strategy: Strategy;
  constructor(strategy: Strategy) {
    this.strategy = strategy;
  }

  firstFree(skipLocked: boolean): number {
    for (let k = 0; k < BERTHS; k++) {
      if (this.sold[k]) continue;
      if (skipLocked && this.rowLock[k]) continue;
      return k;
    }
    return -1;
  }

  step(now: number, hold: number): void {
    for (const tx of this.txns) {
      if (tx.arrive > now || tx.phase === 'done' || tx.phase === 'failed') continue;

      if (tx.phase === 'waiting') {
        if (this.strategy === 'coach') {
          if (this.coachHolder && this.coachHolder !== tx.id) continue; // blocked on the lock
          this.coachHolder = tx.id;
        }
        const k = this.firstFree(this.strategy === 'skip');
        if (k < 0) {
          tx.phase = 'failed';
          tx.finished = now;
          if (this.coachHolder === tx.id) this.coachHolder = 0;
          continue;
        }
        tx.berth = k;
        if (this.strategy === 'skip') this.rowLock[k] = tx.id;
        tx.phase = 'working';
        tx.workEnd = now + hold;
        continue;
      }

      if (tx.phase === 'working' && now >= tx.workEnd) {
        if (this.strategy === 'conditional') {
          // UPDATE ... WHERE mask & need = 0: matches 0 rows if someone sold it meanwhile.
          while (tx.berth >= 0 && this.sold[tx.berth]) {
            this.retries++;
            tx.workEnd += RETRY_MS;
            tx.berth = this.firstFree(false);
          }
          if (tx.berth < 0) {
            tx.phase = 'failed';
            tx.finished = now;
            continue;
          }
        }
        this.sold[tx.berth]++;
        this.rowLock[tx.berth] = 0;
        if (this.coachHolder === tx.id) this.coachHolder = 0;
        tx.phase = 'done';
        tx.finished = now;
      }
    }
  }

  summary() {
    const done = this.txns.filter((x) => x.phase === 'done');
    const finished = this.txns.filter((x) => x.phase === 'done' || x.phase === 'failed');
    const waits = finished.map((x) => x.finished - x.arrive);
    return {
      tickets: done.length,
      berthsSold: this.sold.filter((n) => n > 0).length,
      doubles: this.sold.reduce((s, n) => s + Math.max(0, n - 1), 0),
      failed: this.txns.filter((x) => x.phase === 'failed').length,
      waiting: this.txns.filter((x) => x.phase === 'waiting').length,
      slowest: waits.length ? Math.max(...waits) : 0,
    };
  }
}

export const createLockModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0; // model ms
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;

  function arrivals(): number[] {
    // A Tatkal burst: every request lands within the first 4 ms.
    return Array.from({ length: p.requests }, () => rng.range(0, 4)).sort((a, b) => a - b);
  }

  return {
    params: [
      { name: 'requests', label: 'Requests', min: 2, max: 24, step: 1, value: 12 },
      { name: 'hold', label: 'Work inside the transaction', min: 2, max: 40, step: 1, value: 15, unit: 'ms' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      const times = arrivals();
      lanes = STRATEGIES.map(({ id }) => {
        const lane = new Lane(id);
        lane.txns = times.map((arrive, i) => ({ id: i + 1, arrive, phase: 'waiting', berth: -1, workEnd: 0, finished: 0 }));
        return lane;
      });
      lastEvent = `${p.requests} requests for one coach of 8 berths arrive in the same 4 ms.`;
    },

    step(dt) {
      t += dt / SLOW;
      for (const lane of lanes) lane.step(t, p.hold);
      const naive = lanes[0].summary();
      if (naive.doubles) lastEvent = `Read, work, write has sold ${naive.doubles} berth${naive.doubles > 1 ? 's' : ''} twice.`;
    },

    render(view) {
      const laneH = 100;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        STRATEGIES.forEach((s, li) => {
          text(s.title, { x: 4, y: li * laneH + 20, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, base);
        });
      }
      const live = layer(view, 'live');
      clear(live);
      lanes.forEach((lane, li) => {
        const y = li * laneH + 30;
        for (let k = 0; k < BERTHS; k++) {
          const n = lane.sold[k];
          const locked = lane.rowLock[k] || (lane.coachHolder !== 0);
          const fill = n > 1 ? token('--viz-bad-soft') : n === 1 ? token('--viz-ok-soft') : locked ? token('--viz-warn-soft') : 'none';
          const stroke = n > 1 ? token('--viz-bad') : n === 1 ? token('--viz-ok') : locked ? token('--viz-warn') : token('--viz-stroke');
          svg('rect', { x: 4 + k * 49, y, width: 44, height: 30, rx: 5, fill, stroke, 'stroke-width': 2, 'stroke-dasharray': locked && !n ? '4 3' : null }, live);
          const label = n > 1 ? `×${n}` : n === 1 ? '✓' : locked ? 'lock' : `${k + 1}`;
          text(label, { x: 26 + k * 49, y: y + 21, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle', fill: n > 1 ? token('--viz-bad') : token('--viz-ink') }, live);
        }
        const s = lane.summary();
        const parts = [`waiting ${s.waiting}`, `slowest ${formatMs(s.slowest)}`];
        if (lane.strategy === 'conditional') parts.push(`retries ${lane.retries}`);
        if (s.doubles) parts.unshift(`sold twice ${s.doubles}`);
        text(parts.join(' · '), { x: 4, y: y + 54, 'font-size': 16, fill: s.doubles ? token('--viz-bad') : token('--viz-muted') }, live);
      });
    },

    stats() {
      const out: Record<string, string | number> = { 'model time': formatMs(t) };
      const names: Record<Strategy, string> = { naive: 'read-work-write', coach: 'coach lock', conditional: 'conditional', skip: 'skip locked' };
      for (const lane of lanes) {
        const s = lane.summary();
        out[names[lane.strategy]] = `${s.tickets} tickets, ${s.doubles} doubled, slowest ${formatMs(s.slowest)}`;
      }
      return out;
    },

    log: () => lastEvent,
  };
};
