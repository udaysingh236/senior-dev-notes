// Segment-wise berth inventory. Each berth keeps a bitmask with one bit per segment (the stretch
// between two consecutive stations). A journey from station a to station b needs bits a..b-1; a
// berth can take it when (mask & need) === 0. Short journeys arrive first, then end-to-end ones.
// "pack" puts each journey on the berth where it leaves the smallest free gap; "spread" picks any
// berth that fits at random, which is what lock-avoiding tricks tend to do.
import { clear, layer, svg, text, token, stamp } from '../../sim/svg';
import { createRng } from '../../sim/rng';
import type { Rng, SimFactory } from '../../sim/types';

type Policy = 'pack' | 'spread';
type Mode = Policy | 'compare';

export const STATIONS = ['NDLS', 'MTJ', 'AGC', 'GWL', 'VGLJ', 'BPL', 'ET', 'NGP'];
const SEGMENTS = STATIONS.length - 1; // 7
const BERTHS = 8;
const GAP_MS = 450; // one request every 450 ms of sim time

interface Journey {
  id: number;
  from: number;
  to: number;
  long: boolean;
}

interface Placed extends Journey {
  berth: number;
}

const need = (j: { from: number; to: number }) => ((1 << (j.to - j.from)) - 1) << j.from;
const bits = (mask: number) =>
  Array.from({ length: SEGMENTS }, (_, s) => ((mask >> s) & 1 ? '1' : '0')).join('');

class Lane {
  masks: number[] = Array(BERTHS).fill(0);
  placed: Placed[] = [];
  shortOk = 0;
  longOk = 0;
  longTurnedAway = 0;
  lastId = -1;
  rejected: Journey | null = null;
  policy: Policy;
  pick: () => number;
  constructor(policy: Policy, pick: () => number) {
    this.policy = policy;
    this.pick = pick;
  }

  /** Returns the chosen berth, or -1. Also returns a one-line explanation for the log. */
  book(j: Journey): [number, string] {
    const n = need(j);
    let best = -1;
    let bestScore = Infinity;
    for (let k = 0; k < BERTHS; k++) {
      if (this.masks[k] & n) continue;
      let score: number;
      if (this.policy === 'spread') score = this.pick();
      else {
        // Free run around the journey on this berth: smaller leftover means a tighter fit.
        let lo = j.from;
        let hi = j.to;
        while (lo > 0 && !((this.masks[k] >> (lo - 1)) & 1)) lo--;
        while (hi < SEGMENTS && !((this.masks[k] >> hi) & 1)) hi++;
        score = j.from - lo + (hi - j.to) + k * 0.001;
      }
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    const route = `${STATIONS[j.from]}→${STATIONS[j.to]}`;
    if (best < 0) {
      this.rejected = j;
      if (j.long) this.longTurnedAway++;
      return [-1, `${route} need ${bits(n)}: every berth has a 1 in that range, turned away`];
    }
    const before = this.masks[best];
    this.masks[best] |= n;
    this.placed.push({ ...j, berth: best });
    this.lastId = j.id;
    this.rejected = null;
    if (j.long) this.longOk++;
    else this.shortOk++;
    return [best, `${route} need ${bits(n)} & B${best + 1} ${bits(before)} = 0 → B${best + 1}`];
  }

  cancel(id: number): string | null {
    const i = this.placed.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const [p] = this.placed.splice(i, 1);
    this.masks[p.berth] &= ~need(p);
    if (p.long) this.longOk--;
    else this.shortOk--;
    return `cancelled ${STATIONS[p.from]}→${STATIONS[p.to]} on B${p.berth + 1}: bits cleared`;
  }

  freeCells(): number {
    return this.masks.reduce((sum, m) => sum + bits(m).split('').filter((c) => c === '0').length, 0);
  }
}

export const createInventoryModel: SimFactory = (config) => {
  const mode = (config.mode as Mode) ?? 'pack';
  const policies: Policy[] = mode === 'compare' ? ['pack', 'spread'] : [mode];
  let rng: Rng;
  let spreadRng: Rng;
  let p: Record<string, number> = {};
  let t = 0;
  let queue: Journey[] = [];
  let next = 0;
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;

  function makeJourneys(): Journey[] {
    const list: Journey[] = [];
    let id = 1;
    for (let i = 0; i < p.short; i++) {
      const from = rng.int(0, SEGMENTS - 1);
      const to = Math.min(SEGMENTS, from + rng.int(1, 2));
      list.push({ id: id++, from, to, long: false });
    }
    for (let i = 0; i < 8; i++) {
      const from = rng.int(0, 1);
      const to = SEGMENTS - rng.int(0, 1);
      list.push({ id: id++, from, to, long: true });
    }
    return list;
  }

  function serve(j: Journey): void {
    const notes = lanes.map((lane) => lane.book(j)[1]);
    lastEvent = `${stamp(t)} #${j.id} ` + (lanes.length > 1 ? `pack: ${notes[0]}` : notes[0]);
  }

  return {
    params: [
      { name: 'short', label: 'Short journeys first', min: 0, max: 18, step: 1, value: 10 },
    ],

    reset(params, r) {
      rng = r;
      p = params;
      t = 0;
      next = GAP_MS;
      queue = makeJourneys();
      // A separate stream for "spread", so its random choices never change the journeys.
      spreadRng = createRng(7);
      lanes = policies.map((pol) => new Lane(pol, () => spreadRng.next()));
      lastEvent = `${p.short} short journeys, then 8 end-to-end ones. Press Play.`;
    },

    step(dt) {
      t += dt;
      while (queue.length && t >= next) {
        serve(queue.shift()!);
        next += GAP_MS;
      }
    },

    render(view) {
      const laneH = 280;
      const rowsTop = (top: number) => top + 38;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        lanes.forEach((lane, li) => {
          const y0 = li * laneH;
          if (lanes.length > 1) {
            text(lane.policy === 'pack' ? 'Pack: tightest fit' : 'Spread: any berth that fits', {
              x: 4, y: y0 + 20, 'font-size': 19, 'font-weight': 700, fill: token('--viz-ink'),
            }, base);
          }
          const top = y0 + (lanes.length > 1 ? 30 : 4);
          STATIONS.forEach((s, i) => {
            const x = 44 + i * 50;
            // Alternate rows so neighbouring station codes never overlap on a phone.
            text(s, {
              x, y: top + (i % 2 ? 30 : 14), 'font-size': 15, fill: token('--viz-muted'),
              'text-anchor': i === 0 ? 'start' : i === STATIONS.length - 1 ? 'end' : 'middle',
            }, base);
            svg('line', { x1: x, y1: top + 34, x2: x, y2: rowsTop(top) + BERTHS * 20, stroke: token('--viz-stroke'), 'stroke-width': 1 }, base);
          });
          for (let k = 0; k < BERTHS; k++) {
            text(`B${k + 1}`, { x: 4, y: rowsTop(top) + 14 + k * 20, 'font-size': 15, fill: token('--viz-muted') }, base);
          }
        });
      }

      const live = layer(view, 'live');
      clear(live);
      lanes.forEach((lane, li) => {
        const y0 = li * laneH;
        const top = y0 + (lanes.length > 1 ? 30 : 4);
        for (const b of lane.placed) {
          const isLast = b.id === lane.lastId;
          svg('rect', {
            x: 44 + b.from * 50 + 2, y: rowsTop(top) + 2 + b.berth * 20, width: (b.to - b.from) * 50 - 4, height: 16, rx: 4,
            fill: isLast ? token('--viz-flow') : b.long ? token('--viz-ok') : token('--viz-ok-soft'),
            stroke: b.long ? token('--viz-ok') : token('--viz-stroke'), 'stroke-width': 1.5,
          }, live);
        }
        const y = rowsTop(top) + 4 + BERTHS * 20;
        if (lane.rejected) {
          const j = lane.rejected;
          svg('rect', {
            x: 44 + j.from * 50 + 2, y, width: (j.to - j.from) * 50 - 4, height: 14, rx: 4,
            fill: 'none', stroke: token('--viz-bad'), 'stroke-width': 2, 'stroke-dasharray': '5 3',
          }, live);
        }
        text(`end-to-end: ${lane.longOk} booked, ${lane.longTurnedAway} turned away`, {
          x: 4, y: y + 38, 'font-size': 17, fill: lane.longTurnedAway ? token('--viz-bad') : token('--viz-ink'),
        }, live);
      });
    },

    stats() {
      const s: Record<string, string | number> = { time: `${(t / 1000).toFixed(1)} s` };
      for (const lane of lanes) {
        const tag = lanes.length > 1 ? `${lane.policy} ` : '';
        s[`${tag}short booked`] = lane.shortOk;
        s[`${tag}end-to-end turned away`] = lane.longTurnedAway;
        s[`${tag}free berth-segments`] = lane.freeCells();
      }
      return s;
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Cancel a random booking',
        run() {
          const booked = lanes[0].placed;
          if (!booked.length) {
            lastEvent = 'Nothing booked yet.';
            return;
          }
          const id = booked[rng.int(0, booked.length - 1)].id;
          const notes = lanes.map((lane) => lane.cancel(id));
          lastEvent = `${stamp(t)} #${id} ${notes[0]}`;
        },
      },
    ],
  };
};
