// Cache-aside writes racing with reads on one hot key, three ways at once:
//   set on write      the writer SETs the new value after its commit
//   delete on write   the writer DELs the key after its commit
//   versioned marker  the writer stores "deleted at version v"; a reader's fill is refused if
//                     the cache already knows a version at least as new
// All three lanes see the same reads and writes; only the cache commands differ. A reader that
// misses runs a SELECT (it sees the database half-way through) and then SETs what it read.
// "Stale" means the cache holds a version older than one a writer has already told it about.
// The same model as examples/caching-strategies/race.py.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';
import { createRng } from '../../sim/rng';

const COMMIT_MS = 5;
const CACHE_MS = 1;
const BUCKET_MS = 50;
const HISTORY = 100; // 5 s on the strip

type Mode = 'set' | 'delete' | 'versioned';
type Entry = { kind: 'value' | 'marker'; version: number } | null;
type Ev = [number, number, string, number]; // [time, seq, kind, version]

interface Lane {
  mode: Mode;
  title: string;
  rng: Rng;
  events: Ev[];
  seq: number;
  entry: Entry;
  told: number;
  staleMs: number;
  staleSince: number | null;
  longest: number;
  episodes: number;
  lastT: number;
  fills: number;
  staleFills: number;
  buckets: { stale: number; miss: number; ok: number }[];
}

const MODES: { mode: Mode; title: string }[] = [
  { mode: 'set', title: 'set on write' },
  { mode: 'delete', title: 'delete on write' },
  { mode: 'versioned', title: 'versioned marker' },
];

export const createRaceModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let arrivals: Rng;
  let t = 0;
  let db = 0;
  let nextRead = 0;
  let nextWrite = 0;
  let lanes: Lane[] = [];
  let lastEvent: string | null = null;
  let commits: [number, number][] = []; // [commit time, delay before its cache command]

  const value = (l: Lane) => (l.entry && l.entry.kind === 'value' ? l.entry.version : null);

  function push(l: Lane, at: number, kind: string, v = 0): void {
    l.seq += 1;
    const ev: Ev = [at, l.seq, kind, v];
    let i = l.events.length;
    while (i > 0 && (l.events[i - 1][0] > at || (l.events[i - 1][0] === at && l.events[i - 1][1] > l.seq))) i--;
    l.events.splice(i, 0, ev);
  }

  function track(l: Lane, now: number): void {
    const v = value(l);
    const stale = v !== null && v < l.told;
    const b = Math.floor(now / BUCKET_MS);
    while (l.buckets.length <= b) l.buckets.push({ stale: 0, miss: 0, ok: 0 });
    const span = now - l.lastT;
    if (stale) l.staleMs += span;
    const bucket = l.buckets[b];
    if (stale) bucket.stale += span;
    else if (v === null) bucket.miss += span;
    else bucket.ok += span;
    l.lastT = now;
  }

  function settle(l: Lane, now: number): void {
    if (stale(l) && l.staleSince === null) {
      l.staleSince = now;
      l.episodes += 1;
    }
    else if (!stale(l) && l.staleSince !== null) {
      l.longest = Math.max(l.longest, now - l.staleSince);
      l.staleSince = null;
    }
  }
  const stale = (l: Lane) => {
    const v = value(l);
    return v !== null && v < l.told;
  };

  function handle(l: Lane, [at, , kind, v]: Ev): void {
    track(l, at);
    if (kind === 'snapshot') {
      push(l, at + l.rng.exponential(p.dbRead / 2) + l.rng.exponential(CACHE_MS), 'fill', db);
    } else if (kind === 'fill') {
      if (l.mode === 'versioned' && l.entry) {
        const known = l.entry.version;
        if (v < known || (l.entry.kind === 'value' && v === known)) return;
      }
      l.fills += 1;
      if (v < l.told) {
        l.staleFills += 1;
        lastEvent = `t=${(at / 1000).toFixed(2)}s ${l.title}: a reader filled v${v} after the cache was told about v${l.told}`;
      }
      l.entry = { kind: 'value', version: v };
    } else if (kind === 'commit-op') {
      if (l.mode === 'set') {
        if (v < l.told) lastEvent = `t=${(at / 1000).toFixed(2)}s set on write: the SET for v${v} arrived after v${l.told}`;
        l.entry = { kind: 'value', version: v };
      } else if (l.mode === 'delete') l.entry = null;
      else l.entry = { kind: 'marker', version: Math.max(v, l.entry?.version ?? 0) };
      l.told = Math.max(l.told, v);
    }
    settle(l, at);
  }

  function runUntil(until: number): void {
    for (const l of lanes) {
      while (l.events.length && l.events[0][0] <= until) handle(l, l.events.shift()!);
    }
  }

  return {
    params: [
      { name: 'writes', label: 'Writes', min: 1, max: 40, step: 1, value: 10, unit: '/s' },
      { name: 'reads', label: 'Reads', min: 50, max: 1000, step: 50, value: 500, unit: '/s' },
      { name: 'dbRead', label: 'DB read time', min: 2, max: 50, step: 2, value: 10, unit: 'ms' },
    ],

    reset(params, r) {
      p = params;
      arrivals = r;
      t = 0;
      db = 0;
      commits = [];
      nextRead = arrivals.exponential(1000 / p.reads);
      nextWrite = arrivals.exponential(1000 / p.writes);
      lanes = MODES.map(({ mode, title }) => ({
        mode, title, rng: createRng(7), events: [], seq: 0,
        entry: { kind: 'value', version: 0 }, told: 0, staleMs: 0, staleSince: null, longest: 0, episodes: 0,
        lastT: 0, fills: 0, staleFills: 0, buckets: [],
      }));
      lastEvent = `${p.reads} reads/s and ${p.writes} writes/s on one key. A commit takes about ${COMMIT_MS} ms, a DB read about ${p.dbRead} ms.`;
    },

    step(dt) {
      const end = t + dt;
      for (;;) {
        const at = Math.min(nextRead, nextWrite, commits.length ? commits[0][0] : Infinity);
        if (at > end) break;
        runUntil(at);
        if (commits.length && commits[0][0] === at) {
          // The database is shared, so every lane sees the same commits at the same moments.
          const [, opDelay] = commits.shift()!;
          db += 1;
          for (const l of lanes) push(l, at + opDelay, 'commit-op', db);
        } else if (nextRead === at) {
          for (const l of lanes) {
            if (value(l) === null) push(l, at + l.rng.exponential(p.dbRead / 2), 'snapshot');
          }
          nextRead = at + arrivals.exponential(1000 / p.reads);
        } else {
          const commitAt = at + arrivals.exponential(COMMIT_MS);
          commits.push([commitAt, arrivals.exponential(CACHE_MS)]);
          commits.sort((a, b) => a[0] - b[0]);
          nextWrite = at + arrivals.exponential(1000 / p.writes);
        }
      }
      runUntil(end);
      for (const l of lanes) track(l, end);
      t = end;
    },

    render(view) {
      const laneH = 76;
      const left = 4;
      const right = 396;
      const stripH = 26;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        MODES.forEach((m, li) => text(m.title, { x: left, y: li * laneH + 18, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base));
        text('last 5 s: green fresh, grey empty, red outdated', { x: 200, y: 3 * laneH + 10, 'font-size': 14, 'text-anchor': 'middle', fill: token('--viz-muted') }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      const current = Math.floor(t / BUCKET_MS);
      const w = (right - left) / HISTORY;
      lanes.forEach((l, li) => {
        const y0 = li * laneH + 26;
        const share = t > 0 ? l.staleMs / t : 0;
        text(`${(100 * share).toFixed(2)}% stale`, {
          x: right, y: li * laneH + 18, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'end',
          fill: token(share > 0.005 ? '--viz-bad' : share > 0 ? '--viz-warn' : '--viz-ok'),
        }, live);
        for (let i = 0; i < HISTORY; i++) {
          const b = l.buckets[current - HISTORY + 1 + i];
          if (!b) continue;
          const tone = b.stale > 0 ? 'bad' : b.ok >= b.miss ? 'ok' : 'muted';
          svg('rect', {
            x: left + i * w, y: y0, width: w + 0.2, height: stripH,
            fill: tone === 'muted' ? token('--viz-stroke') : token(`--viz-${tone}${tone === 'ok' ? '-soft' : ''}`),
          }, live);
        }
        svg('rect', { x: left, y: y0, width: right - left, height: stripH, rx: 3, fill: 'none', stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, live);
        const v = value(l);
        const shown = l.entry === null ? 'empty' : l.entry.kind === 'marker' ? `marker v${l.entry.version}` : `v${v}`;
        text(`cache ${shown} · database v${db}`, { x: left, y: y0 + stripH + 18, 'font-size': 15, fill: token('--viz-muted') }, live);
      });
    },

    stats() {
      const out: Record<string, string> = { time: `${(t / 1000).toFixed(1)} s` };
      for (const l of lanes) {
        const longest = Math.round(Math.max(l.longest, l.staleSince !== null ? t - l.staleSince : 0));
        out[`${l.title}: outdated`] = l.episodes ? `${l.episodes}×, longest ${longest} ms` : 'never';
      }
      return out;
    },

    log: () => lastEvent,
  };
};
