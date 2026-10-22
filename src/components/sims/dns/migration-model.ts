// A record moves to a new address. 200 resolver caches each hold a copy that they fetched at a
// different moment, and each refreshes only when its own copy has expired and a user asks again.
//
// Timeline (simulated seconds, 0 = the moment the address changes):
//   -lead      the TTL is lowered from oldTtl to NEW_TTL (the address is still the old one)
//   0          the address changes to the new server
//   offAfter   the old server is switched off; any lookup still answered with the old address fails
//
// A share of caches is "pinned": they fetched the address once and never ask again (a process
// that resolved at startup, a connection pool that never reconnects).
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const CACHES = 200;
const COLS = 20;
const NEW_TTL = 60; // seconds: the short TTL used for the move
const LOOKUP_GAP = 20; // mean seconds between user lookups at one cache
const SPEED = 240; // simulated seconds per real second (4 minutes a second)
const AFTER = 90 * 60; // the run ends 90 minutes after the change
const BUCKET = 60; // chart resolution, seconds

type Value = 'old' | 'new';

interface Cache {
  pinned: boolean;
  value: Value;
  expires: number;
  nextLookup: number;
}

interface Bucket {
  t: number;
  lookups: number;
  old: number;
  failed: number;
}

export interface MigrationResult {
  failed: number;
  lookupsAfterOff: number;
  oldAtOff: number; // caches still holding the old address when the old server went off
  lastSwitch: number; // time the last unpinned cache switched to the new address
  authPerMinBefore: number;
  authPerMinAfter: number;
}

/** "−12 min", "+1 h 05 min", "+45 s" relative to the change. */
function rel(s: number): string {
  const sign = s < 0 ? '−' : '+';
  const a = Math.abs(Math.round(s));
  if (a < 60) return `${sign}${a} s`;
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return h ? `${sign}${h} h ${String(m).padStart(2, '0')} min` : `${sign}${m} min`;
}

export const createMigrationModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let start = 0;
  let caches: Cache[] = [];
  let buckets: Bucket[] = [];
  let failed = 0;
  let lookupsAfterOff = 0;
  let oldAtOff = -1;
  let lastSwitch = -Infinity;
  let authQueries: number[] = []; // fetch times, for the per-minute rate
  let lastEvent: string | null = null;
  let done = false;

  const offAt = () => p.offAfter * 60;
  const lowerAt = () => -p.lead * 60;

  function bucketAt(time: number): Bucket {
    const i = Math.floor((time - start) / BUCKET);
    while (buckets.length <= i) buckets.push({ t: start + buckets.length * BUCKET, lookups: 0, old: 0, failed: 0 });
    return buckets[i];
  }

  function fetch(c: Cache, now: number): void {
    const value: Value = now >= 0 ? 'new' : 'old';
    const ttl = now >= lowerAt() ? NEW_TTL : p.oldTtl;
    if (c.value === 'old' && value === 'new' && !c.pinned) lastSwitch = Math.max(lastSwitch, now);
    c.value = value;
    c.expires = now + ttl;
    authQueries.push(now);
  }

  function lookup(c: Cache, now: number): void {
    if (!c.pinned && now >= c.expires) fetch(c, now);
    const b = bucketAt(now);
    b.lookups++;
    if (c.value === 'old') b.old++;
    if (now >= offAt()) {
      lookupsAfterOff++;
      if (c.value === 'old') {
        failed++;
        b.failed++;
      }
    }
  }

  function advanceTo(target: number): void {
    // Process lookups in time order across all caches.
    while (true) {
      let next: Cache | null = null;
      for (const c of caches) if (c.nextLookup <= target && (!next || c.nextLookup < next.nextLookup)) next = c;
      if (!next) break;
      const now = next.nextLookup;
      if (oldAtOff < 0 && now >= offAt()) oldAtOff = caches.filter((c) => c.value === 'old').length;
      lookup(next, now);
      next.nextLookup = now + rng.exponential(LOOKUP_GAP);
    }
    if (oldAtOff < 0 && target >= offAt()) oldAtOff = caches.filter((c) => c.value === 'old').length;
  }

  function authRate(from: number, to: number): number {
    const n = authQueries.filter((q) => q >= from && q < to).length;
    return n / ((to - from) / 60);
  }

  const model = {
    params: [
      { name: 'oldTtl', label: 'TTL before the move', min: 300, max: 7200, step: 300, value: 3600, unit: 's' },
      { name: 'lead', label: 'TTL lowered to 60 s this early', min: 0, max: 180, step: 10, value: 0, unit: 'min' },
      { name: 'offAfter', label: 'Old server off after', min: 1, max: 60, step: 1, value: 10, unit: 'min' },
      { name: 'pinned', label: 'Clients that never re-resolve', min: 0, max: 10, step: 1, value: 2, unit: '%' },
    ],

    reset(params: Record<string, number>, r: Rng) {
      p = params;
      rng = r;
      start = lowerAt() - 5 * 60;
      t = start;
      buckets = [];
      failed = 0;
      lookupsAfterOff = 0;
      oldAtOff = -1;
      lastSwitch = -Infinity;
      authQueries = [];
      done = false;
      const pinnedCount = Math.round((CACHES * p.pinned) / 100);
      const pinnedSet = new Set<number>();
      while (pinnedSet.size < pinnedCount) pinnedSet.add(rng.int(0, CACHES - 1));
      caches = Array.from({ length: CACHES }, (_, i) => {
        // Each copy was fetched at a random moment within one old TTL before the run starts.
        const fetched = start - rng.range(0, p.oldTtl);
        return {
          pinned: pinnedSet.has(i),
          value: 'old' as Value,
          expires: pinnedSet.has(i) ? Infinity : fetched + p.oldTtl,
          nextLookup: start + rng.exponential(LOOKUP_GAP),
        };
      });
      lastEvent = p.lead > 0
        ? `TTL lowered from ${p.oldTtl} s to ${NEW_TTL} s at ${rel(lowerAt())}; the address changes at 0; old server off at ${rel(offAt())}.`
        : `TTL (${p.oldTtl} s) lowered to ${NEW_TTL} s in the same edit as the address change; old server off at ${rel(offAt())}.`;
    },

    step(dtMs: number) {
      if (done) return;
      const target = Math.min(t + (dtMs / 1000) * SPEED, AFTER);
      const crossedChange = t < 0 && target >= 0;
      const crossedOff = t < offAt() && target >= offAt();
      advanceTo(target);
      t = target;
      if (crossedChange) lastEvent = `${rel(0)}: the record now points at the new server. No cache has been told.`;
      if (crossedOff) lastEvent = `${rel(offAt())}: old server switched off with ${oldAtOff} of ${CACHES} caches still sending users to it.`;
      if (t >= AFTER) {
        done = true;
        lastEvent = `Run finished: ${failed} lookups failed after the switch-off. Change a slider or press Reset.`;
      }
    },

    render(view: SVGSVGElement) {
      const cell = 392 / COLS;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        text('200 resolver caches', { x: 4, y: 18, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base);
        const legend: [string, string][] = [['old', '--viz-warn'], ['new', '--viz-ok'], ['old, server gone', '--viz-bad']];
        let lx = 4;
        legend.forEach(([label, tone]) => {
          svg('rect', { x: lx, y: 206, width: 14, height: 14, rx: 3, fill: token(`${tone}-soft` as `--viz-${string}`), stroke: token(tone as `--viz-${string}`), 'stroke-width': 1.5 }, base);
          text(label, { x: lx + 19, y: 218, 'font-size': 15, fill: token('--viz-muted') }, base);
          lx += label.length * 8 + 40;
        });
        text('share of lookups getting the old address', { x: 4, y: 250, 'font-size': 15, fill: token('--viz-muted') }, base);
        svg('line', { x1: 4, y1: 340, x2: 396, y2: 340, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
      }
      const live = layer(view, 'live');
      clear(live);

      caches.forEach((c, i) => {
        const x = 4 + (i % COLS) * cell;
        const y = 28 + Math.floor(i / COLS) * 17;
        const tone = c.value === 'new' ? '--viz-ok' : t >= offAt() ? '--viz-bad' : '--viz-warn';
        svg('rect', { x: x + 1, y, width: cell - 3, height: 14, rx: 3, fill: token(`${tone}-soft` as `--viz-${string}`), stroke: token(tone as `--viz-${string}`), 'stroke-width': 1.5 }, live);
        if (c.pinned) svg('circle', { cx: x + cell / 2 - 0.5, cy: y + 7, r: 3, fill: token(tone as `--viz-${string}`) }, live);
      });
      text(rel(t), { x: 396, y: 18, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'end', fill: token('--viz-ink'), style: 'font-family: var(--sl-font-mono)' }, live);

      // Chart: x from start to AFTER, y = share of lookups that got the old address.
      const x0 = 4;
      const w = 392;
      const top = 262;
      const h = 76;
      const span = AFTER - start;
      const xOf = (time: number) => x0 + ((time - start) / span) * w;
      const marks: [number, string][] = [[0, 'change'], [offAt(), 'old off']];
      if (p.lead > 0) marks.unshift([lowerAt(), 'TTL lowered']);
      let labelEnd = -Infinity;
      marks.forEach(([time, label]) => {
        const x = xOf(time);
        svg('line', { x1: x, y1: top - 4, x2: x, y2: top + h + 4, stroke: token('--viz-muted'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, live);
        // Labels sit under the axis; push a label right if it would overlap the previous one.
        const lx = Math.max(x, labelEnd + 6);
        const anchor = lx > 340 ? 'end' : 'start';
        text(label, { x: anchor === 'end' ? 396 : lx, y: top + h + 20, 'font-size': 14, 'text-anchor': anchor, fill: token('--viz-muted') }, live);
        labelEnd = lx + label.length * 7;
      });
      const pts: string[] = [];
      buckets.forEach((b) => {
        if (!b.lookups || b.t > t) return;
        const x = xOf(b.t + BUCKET / 2);
        const y = top + h - (b.old / b.lookups) * h;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        if (b.failed) svg('rect', { x: xOf(b.t), y, width: Math.max(1, (BUCKET / span) * w), height: top + h - y, fill: token('--viz-bad-soft') }, live);
      });
      if (pts.length > 1) svg('polyline', { points: pts.join(' '), fill: 'none', stroke: token('--viz-warn'), 'stroke-width': 2 }, live);
    },

    stats() {
      const onOld = caches.filter((c) => c.value === 'old').length;
      const now = Math.min(t, AFTER);
      return {
        'caches on old address': `${onOld} of ${CACHES}`,
        'lookups failed after switch-off': lookupsAfterOff ? `${failed} (${Math.round((failed / lookupsAfterOff) * 100)}%)` : '0',
        'last cache switched': caches.some((c) => !c.pinned && c.value === 'old') ? 'not yet' : rel(lastSwitch),
        'queries to your DNS, last 5 min': `${Math.round(authRate(now - 300, now))} / min`,
      };
    },

    log: () => lastEvent,

    /** For headless tests: run to the end and report. */
    result(): MigrationResult {
      while (!done) model.step(20);
      return {
        failed,
        lookupsAfterOff,
        oldAtOff,
        lastSwitch,
        authPerMinBefore: authRate(start, Math.min(lowerAt(), 0)),
        authPerMinAfter: authRate(AFTER - 30 * 60, AFTER),
      };
    },
  };
  return model;
};
