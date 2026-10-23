// Several clients edit one product through an HTTP API. Each edit is read-modify-write: GET the
// product, think, then write one field as "what I read + 1". Three ways to write it back:
//   blind PUT      send the whole document as I read it, with my one change
//   PUT + If-Match the same, but only if the ETag still matches; 412 -> GET again and retry
//   merge PATCH    send only the field I changed, with no precondition
// The product has one shared field (stock) plus one field per editor (say, each editor owns one
// language's description). "Lost" counts edits that got a 2xx but whose effect is no longer in the product.
import { clear, layer, svg, text, token } from '../../sim/svg';
import { createRng } from '../../sim/rng';
import type { Rng, SimFactory } from '../../sim/types';

type Kind = 'put' | 'ifmatch' | 'patch';
const LANES: { id: Kind; title: string }[] = [
  { id: 'put', title: 'Blind PUT of the whole product' },
  { id: 'ifmatch', title: 'PUT with If-Match' },
  { id: 'patch', title: 'Merge PATCH of one field' },
];
const IDLE_MS = 400;

type Phase = 'idle' | 'thinking';
interface Client {
  phase: Phase;
  until: number;
  field: number;
  snap: number[];
  snapVersion: number;
}

class Lane {
  kind: Kind;
  rng: Rng;
  doc: number[];
  version = 1;
  acked = 0;
  conflicts = 0;
  clients: Client[];
  constructor(kind: Kind, clients: number, seed: number) {
    this.kind = kind;
    this.rng = createRng(seed);
    this.doc = Array(clients + 1).fill(0);
    this.clients = Array.from({ length: clients }, () => ({ phase: 'idle', until: 0, field: 0, snap: [], snapVersion: 0 }));
    this.clients.forEach((c) => (c.until = this.rng.exponential(IDLE_MS)));
  }

  read(c: Client, now: number, think: number): void {
    c.snap = [...this.doc];
    c.snapVersion = this.version;
    c.phase = 'thinking';
    c.until = now + this.rng.exponential(think);
  }

  step(now: number, think: number, same: number): void {
    this.clients.forEach((c, k) => {
      if (now < c.until) return;
      if (c.phase === 'idle') {
        c.field = this.rng.chance(same) ? 0 : k + 1; // the shared field, or this editor's own
        this.read(c, now, think);
        return;
      }
      // Thinking is over: write.
      if (this.kind === 'ifmatch' && c.snapVersion !== this.version) {
        this.conflicts++; // 412 Precondition Failed: read again, redo the edit
        this.read(c, now, think / 4);
        return;
      }
      if (this.kind === 'patch') this.doc[c.field] = c.snap[c.field] + 1;
      else {
        this.doc = [...c.snap];
        this.doc[c.field] = c.snap[c.field] + 1;
      }
      this.version++;
      this.acked++;
      c.phase = 'idle';
      c.until = now + this.rng.exponential(IDLE_MS);
    });
  }

  applied(): number {
    return this.doc.reduce((a, b) => a + b, 0);
  }
  lost(): number {
    return this.acked - this.applied();
  }
}

export const createLostUpdateModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let t = 0;
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'clients', label: 'Editors', min: 2, max: 10, step: 1, value: 4 },
      { name: 'think', label: 'Time between GET and write', min: 20, max: 1000, step: 20, value: 300, unit: 'ms' },
      { name: 'same', label: 'Edits to the shared field', min: 0, max: 100, step: 5, value: 25, unit: '%' },
    ],

    reset(params, r) {
      p = params;
      t = 0;
      const seed = Math.floor(r.next() * 1e9);
      lanes = LANES.map((l) => new Lane(l.id, p.clients, seed));
      lastEvent = `${p.clients} editors; each edit sets one field to what it read plus one.`;
    },

    step(dt) {
      t += dt;
      for (const lane of lanes) lane.step(t, p.think, p.same / 100);
      const put = lanes[0];
      if (put.lost() > 0) lastEvent = `Blind PUT: ${put.lost()} of ${put.acked} edits answered 200 OK are gone.`;
    },

    render(view) {
      const laneH = 96;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        LANES.forEach((l, i) => text(l.title, { x: 4, y: i * laneH + 20, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, base));
      }
      const live = layer(view, 'live');
      clear(live);
      const maxAcked = Math.max(10, ...lanes.map((l) => l.acked));
      lanes.forEach((lane, i) => {
        const y = i * laneH + 32;
        const scale = 392 / maxAcked;
        const kept = lane.applied();
        svg('rect', { x: 4, y, width: Math.max(0, kept * scale), height: 22, rx: 4, fill: token('--viz-ok-soft'), stroke: token('--viz-ok'), 'stroke-width': 1.5 }, live);
        if (lane.lost() > 0) {
          svg('rect', { x: 4 + kept * scale, y, width: lane.lost() * scale, height: 22, rx: 4, fill: token('--viz-bad-soft'), stroke: token('--viz-bad'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, live);
        }
        const parts = [`200 OK: ${lane.acked}`, `kept: ${kept}`, `lost: ${lane.lost()}`];
        if (lane.kind === 'ifmatch') parts.push(`412s: ${lane.conflicts}`);
        text(parts.join(' · '), { x: 4, y: y + 46, 'font-size': 16, fill: lane.lost() > 0 ? token('--viz-bad') : token('--viz-muted') }, live);
        lane.clients.forEach((c, k) => {
          svg('circle', { cx: 10 + k * 22, cy: y + 62, r: 6, fill: c.phase === 'thinking' ? token('--viz-flow') : 'none', stroke: c.phase === 'thinking' ? token('--viz-flow') : token('--viz-stroke'), 'stroke-width': 1.5 }, live);
        });
      });
    },

    stats() {
      const out: Record<string, string | number> = { time: `${(t / 1000).toFixed(1)} s` };
      const names: Record<Kind, string> = { put: 'blind PUT', ifmatch: 'If-Match', patch: 'merge PATCH' };
      for (const lane of lanes) {
        const pct = lane.acked ? Math.round((lane.lost() / lane.acked) * 100) : 0;
        out[`${names[lane.kind]} lost`] = `${lane.lost()} (${pct}%)`;
      }
      out['If-Match 412 retries'] = lanes[1]?.conflicts ?? 0;
      return out;
    },

    log: () => lastEvent,
  };
};
