// One client, one limit of 100 requests per second, many gateway nodes. Four lanes run the same
// arrivals through four ways of enforcing that limit across the fleet:
//   local       each node counts alone and allows the full 100
//   split       each node counts alone and allows 100 / N
//   shared      every node asks one shared counter, atomically (fails open when it is down)
//   synced      each node counts locally and adds its count to the shared counter every S ms
// The client's requests land on `spread` of the N nodes (one keep-alive connection per node).
// All lanes count in fixed one-second windows, so "admitted per window" is the number to compare.
import { clear, layer, stamp, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';
import { LIMIT, WINDOW_MS, WindowLog, drawLane } from './history';

type Kind = 'local' | 'split' | 'shared' | 'synced';

const LANES: { id: Kind; title: string; short: string }[] = [
  { id: 'local', title: 'Local: each node allows 100', short: 'local 100' },
  { id: 'split', title: 'Local: each node allows 100 ÷ N', short: 'local 100 ÷ N' },
  { id: 'shared', title: 'One shared counter (fails open)', short: 'shared' },
  { id: 'synced', title: 'Local, synced every S ms', short: 'synced' },
];

const OUTAGE_MS = 3000;

interface SyncNode {
  window: number; // the window its numbers belong to
  unsynced: number; // admitted here since the last successful sync
  seen: number; // the shared total it read at the last sync
  nextSync: number; // ms
}

export class FleetLane {
  kind: Kind;
  log = new WindowLog();
  nodeCounts: number[]; // local and split: per-node count in the current window
  nodeWindow: number[];
  shared = new Map<number, number>(); // shared and synced: window number -> total
  sync: SyncNode[];
  admitted = 0;
  rejected = 0;

  constructor(kind: Kind, nodes: number, syncMs: number, rng: Rng) {
    this.kind = kind;
    this.nodeCounts = new Array(nodes).fill(0);
    this.nodeWindow = new Array(nodes).fill(0);
    // Nodes start their sync timers at different moments, as real ones do.
    this.sync = Array.from({ length: nodes }, () => ({ window: 0, unsynced: 0, seen: 0, nextSync: rng.range(0, syncMs) }));
  }

  /** Runs every sync that is due before `now`. The store being down makes syncs fail. */
  syncUpTo(now: number, syncMs: number, storeUp: (at: number) => boolean): void {
    if (this.kind !== 'synced') return;
    for (const node of this.sync) {
      while (node.nextSync <= now) {
        const at = node.nextSync;
        const w = Math.floor(at / WINDOW_MS);
        if (w !== node.window) this.newWindow(node, w);
        if (storeUp(at)) {
          // INCRBY the shared counter with what we admitted, and read back the total.
          const total = (this.shared.get(w) ?? 0) + node.unsynced;
          this.shared.set(w, total);
          node.seen = total;
          node.unsynced = 0;
        }
        node.nextSync += syncMs;
      }
    }
  }

  newWindow(node: SyncNode, w: number): void {
    // Whatever was not synced belonged to the old window; it no longer matters.
    node.window = w;
    node.unsynced = 0;
    node.seen = 0;
  }

  /** One request reaching node `k` at time `at`. Returns whether it was admitted. */
  arrive(k: number, at: number, nodes: number, storeUp: boolean): boolean {
    const w = Math.floor(at / WINDOW_MS);
    let ok: boolean;
    if (this.kind === 'local' || this.kind === 'split') {
      if (this.nodeWindow[k] !== w) {
        this.nodeWindow[k] = w;
        this.nodeCounts[k] = 0;
      }
      const cap = this.kind === 'local' ? LIMIT : Math.floor(LIMIT / nodes);
      ok = this.nodeCounts[k] < cap;
      if (ok) this.nodeCounts[k]++;
    } else if (this.kind === 'shared') {
      if (!storeUp) {
        ok = true; // fail open: the limiter cannot decide, so the request goes through
      } else {
        const next = (this.shared.get(w) ?? 0) + 1; // INCR, atomic
        this.shared.set(w, next);
        this.shared.delete(w - 2); // old windows expire
        ok = next <= LIMIT;
      }
    } else {
      const node = this.sync[k];
      if (node.window !== w) this.newWindow(node, w);
      // The node's view: the total at its last sync, plus what it admitted itself since.
      ok = node.seen + node.unsynced < LIMIT;
      if (ok) node.unsynced++;
    }
    if (ok) {
      this.admitted++;
      this.log.add(at);
    } else {
      this.rejected++;
      this.log.roll(at);
    }
    return ok;
  }
}

/** The whole simulation without drawing, so it can be tested headlessly. */
export class FleetRun {
  p: Record<string, number>;
  rng: Rng;
  t = 0;
  nextArrival: number;
  lanes: FleetLane[];
  spread: number;
  downFrom = -1;
  downUntil = -1;

  constructor(p: Record<string, number>, rng: Rng) {
    this.p = p;
    this.rng = rng;
    this.spread = Math.min(p.spread, p.nodes);
    this.lanes = LANES.map((l) => new FleetLane(l.id, p.nodes, p.sync, rng));
    this.nextArrival = rng.exponential(1000 / p.rate);
  }

  storeUp(at: number): boolean {
    return !(at >= this.downFrom && at < this.downUntil);
  }

  step(dt: number): void {
    this.t += dt;
    const up = (at: number) => this.storeUp(at);
    while (this.nextArrival <= this.t) {
      const at = this.nextArrival;
      const k = this.rng.int(0, this.spread - 1); // the client's connections land on `spread` nodes
      for (const lane of this.lanes) {
        lane.syncUpTo(at, this.p.sync, up);
        lane.arrive(k, at, this.p.nodes, up(at));
      }
      this.nextArrival += this.rng.exponential(1000 / this.p.rate);
    }
    for (const lane of this.lanes) {
      lane.syncUpTo(this.t, this.p.sync, up);
      lane.log.roll(this.t);
    }
  }

  outage(): void {
    this.downFrom = this.t;
    this.downUntil = this.t + OUTAGE_MS;
  }
}

export const createFleetModel: SimFactory = () => {
  let run: FleetRun;
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'nodes', label: 'Gateway nodes (N)', min: 2, max: 12, step: 1, value: 10 },
      { name: 'spread', label: 'Nodes the client reaches', min: 1, max: 12, step: 1, value: 10 },
      { name: 'rate', label: 'Client sends', min: 50, max: 1000, step: 50, value: 300, unit: 'req/s' },
      { name: 'sync', label: 'Sync every (S)', min: 20, max: 1000, step: 20, value: 200, unit: 'ms' },
    ],

    reset(params, rng) {
      run = new FleetRun(params, rng);
      lastEvent = `Limit 100 req/s. The client sends ${params.rate} req/s over ${run.spread} of ${params.nodes} nodes.`;
    },

    step(dt) {
      const wasDown = !run.storeUp(run.t);
      run.step(dt);
      if (wasDown && run.storeUp(run.t)) lastEvent = `${stamp(run.t)} the store is back`;
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const down = !run.storeUp(run.t);
      const pill = down ? `store down: ${((run.downUntil - run.t) / 1000).toFixed(1)} s` : 'store up';
      svg('rect', { x: 246, y: 4, width: 150, height: 26, rx: 13, fill: token(down ? '--viz-bad-soft' : '--viz-ok-soft'), stroke: token(down ? '--viz-bad' : '--viz-ok'), 'stroke-width': 1.5 }, live);
      text(pill, { x: 321, y: 22, 'font-size': 15, 'font-weight': 600, 'text-anchor': 'middle', fill: token('--viz-ink') }, live);
      text('admitted per second', { x: 4, y: 22, 'font-size': 15, fill: token('--viz-muted') }, live);
      run.lanes.forEach((lane, i) => drawLane(live, 36 + i * 92, LANES[i].title, lane.log));
    },

    stats() {
      const out: Record<string, string | number> = { time: `${(run.t / 1000).toFixed(1)} s` };
      run.lanes.forEach((lane, i) => {
        out[`${LANES[i].short}: avg per s`] = Math.round(lane.log.mean());
      });
      return out;
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Take the store down for 3 s',
        run() {
          run.outage();
          lastEvent = `${stamp(run.t)} the shared store stops answering. The shared lane fails open; synced nodes keep counting locally.`;
        },
      },
    ],
  };
};
