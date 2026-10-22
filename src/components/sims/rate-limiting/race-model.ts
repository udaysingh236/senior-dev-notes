// Check-then-act against a shared counter across the network. Requests from one client arrive
// at many app servers; each server checks a shared counter (limit 100 per one-second window).
//   two-step   GET the count, decide, then SET count + 1: two round trips, with a gap between
//              the store reading the value and the store receiving the write
//   atomic     INCR (or a Lua script): the store reads, decides and writes in one step
// Every request that reaches the store while another request's write is still on its way reads
// a count that is already out of date. How many do is roughly rate × round trip.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';
import { LIMIT, WINDOW_MS, WindowLog, drawLane } from './history';

export class RaceLane {
  atomic: boolean;
  log = new WindowLog();
  counts = new Map<number, number>(); // window -> stored count
  pendingSets: { at: number; w: number; value: number }[] = []; // writes still on the wire, in time order
  inFlight = 0; // reads whose write has not landed yet
  staleReads = 0;
  reads = 0;

  constructor(atomic: boolean) {
    this.atomic = atomic;
  }

  /** Applies every SET that reaches the store before `now`. */
  land(now: number): void {
    while (this.pendingSets.length && this.pendingSets[0].at <= now) {
      const s = this.pendingSets.shift()!;
      this.counts.set(s.w, s.value); // overwrite: whatever was there is lost
      this.inFlight--;
    }
  }

  /** A request whose command reaches the store at `atStore`. `rtt` is one full round trip. */
  arrive(atStore: number, rtt: number): void {
    this.land(atStore);
    const w = Math.floor(atStore / WINDOW_MS);
    this.counts.delete(w - 2);
    const count = this.counts.get(w) ?? 0;
    this.reads++;
    if (this.atomic) {
      const next = count + 1; // INCR: read and write are one step inside the store
      this.counts.set(w, next);
      if (next <= LIMIT) this.log.add(atStore);
      else this.log.roll(atStore);
      return;
    }
    if (this.inFlight > 0) this.staleReads++; // someone else's write has not landed yet
    if (count < LIMIT) {
      // Allowed. The reply takes half a round trip to reach the app server, and the SET takes
      // another half to come back, so the write lands one full round trip after the read.
      this.pendingSets.push({ at: atStore + rtt, w, value: count + 1 });
      this.inFlight++;
      this.log.add(atStore);
    } else {
      this.log.roll(atStore);
    }
  }
}

export const createRaceModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let lanes: RaceLane[] = [];
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'rate', label: 'Requests from one client', min: 100, max: 3000, step: 100, value: 1000, unit: 'req/s' },
      { name: 'rtt', label: 'Round trip to the store', min: 0.2, max: 10, step: 0.2, value: 1, unit: 'ms' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      lanes = [new RaceLane(false), new RaceLane(true)];
      nextArrival = rng.exponential(1000 / p.rate);
      lastEvent = `Limit 100 per second. ${p.rate} req/s × ${p.rtt} ms round trip = ${((p.rate * p.rtt) / 1000).toFixed(1)} requests in each read-to-write gap, on average.`;
    },

    step(dt) {
      t += dt;
      while (nextArrival <= t) {
        for (const lane of lanes) lane.arrive(nextArrival, p.rtt);
        nextArrival += rng.exponential(1000 / p.rate);
      }
      for (const lane of lanes) {
        lane.land(t);
        lane.log.roll(t);
      }
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      text('per 1 s window, dashed = 100', { x: 4, y: 22, 'font-size': 15, fill: token('--viz-muted') }, live);
      drawLane(live, 32, 'GET, check, then SET', lanes[0].log);
      drawLane(live, 124, 'Atomic: INCR or one Lua script', lanes[1].log);
      // The rule of thumb the lane follows: every write hides the requests that arrive in its gap.
      const inGap = (p.rate * p.rtt) / 1000;
      const predicted = Math.round(Math.min(p.rate, LIMIT * (1 + inGap)));
      svg('line', { x1: 4, x2: 396, y1: 222, y2: 222, stroke: token('--viz-stroke'), 'stroke-width': 1 }, live);
      text(`rate × round trip = ${inGap.toFixed(1)} requests per gap`, { x: 4, y: 246, 'font-size': 17, fill: token('--viz-muted') }, live);
      text(`100 × (1 + ${inGap.toFixed(1)}) ≈ ${predicted} admitted per second`, {
        x: 4, y: 270, 'font-size': 17, 'font-weight': 600, fill: token(predicted > LIMIT * 1.05 ? '--viz-bad' : '--viz-ok'),
      }, live);
    },

    stats() {
      const two = lanes[0];
      const one = lanes[1];
      return {
        time: `${(t / 1000).toFixed(1)} s`,
        'GET then SET: avg per s': Math.round(two.log.mean()),
        'atomic: avg per s': Math.round(one.log.mean()),
        'GETs that read a stale count': `${two.reads ? Math.round((100 * two.staleReads) / two.reads) : 0}%`,
      };
    },

    log: () => lastEvent,
  };
};
