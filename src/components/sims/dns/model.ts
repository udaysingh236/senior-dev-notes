// DNS caches after a record change: why "propagation" is many caches expiring, not a push.
//
// config.mode picks the picture:
//   'propagation'  five resolver caches and one app that pinned the address at startup. The record
//                  changes, each cache keeps the old answer until its own copy expires, and one TTL
//                  after the change the old server is switched off.
//   'compare'      the same change in two worlds, a short TTL and a long one, with the share of
//                  lookups still getting the old address drawn over time and the load each puts on
//                  the authoritative server.
//
// Each cache fetched its copy at a random moment before the run starts, so expiries are spread out
// the way they are on the real internet. Lookups reach each cache as a seeded Poisson stream.
import { clamp, clear, layer, percent, svg, text, token } from '../../sim/svg';
import type { ParamSpec, Rng, SimFactory } from '../../sim/types';

type Mode = 'propagation' | 'compare';
type Value = 'old' | 'new';

interface Cache {
  label: string;
  pinned: boolean; // caches for ever, ignoring the TTL
  value: Value;
  expires: number; // simulated seconds
  nextLookup: number;
  lastFetch: number;
}

interface World {
  ttl: number;
  caches: Cache[];
  authQueries: number;
  lookupsAfter: number; // lookups since the change
  oldAfter: number; // of those, how many got the old address
  failedAfter: number; // got the old address after the old server was switched off
  samples: { t: number; oldShare: number }[];
  bucket: { lookups: number; old: number; start: number };
}

const INK = token('--viz-ink');
const MUTED = token('--viz-muted');
const STROKE = token('--viz-stroke');
const COLOUR: Record<Value, string> = { old: token('--viz-warn'), new: token('--viz-ok') };
const ADDRESS: Record<Value, string> = { old: '203.0.113.10', new: '198.51.100.20' };

const RESOLVERS = ['Home ISP', 'Mobile ISP', 'Office DNS', '1.1.1.1', '8.8.8.8'];

/** "12 min", "1 h 05 min", "45 s". */
function clock(s: number): string {
  const total = Math.max(0, Math.round(s));
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
  return sec && m < 10 ? `${m} min ${sec} s` : `${m} min`;
}

function makeWorld(ttl: number, perMinute: number, rng: Rng, withPinned: boolean): World {
  const mean = 60 / perMinute;
  const caches: Cache[] = RESOLVERS.map((label) => {
    const fetched = -rng.range(0, ttl); // copies were fetched at different moments before t=0
    return { label, pinned: false, value: 'old', expires: fetched + ttl, nextLookup: rng.exponential(mean), lastFetch: -Infinity };
  });
  if (withPinned) {
    caches.push({ label: 'Pinned app', pinned: true, value: 'old', expires: Infinity, nextLookup: rng.exponential(mean), lastFetch: -Infinity });
  }
  return { ttl, caches, authQueries: 0, lookupsAfter: 0, oldAfter: 0, failedAfter: 0, samples: [], bucket: { lookups: 0, old: 0, start: 0 } };
}

const PROPAGATION_PARAMS: ParamSpec[] = [
  { name: 'ttl', label: 'TTL of the record', min: 60, max: 3600, step: 60, value: 300, unit: 's' },
  { name: 'rate', label: 'Lookups per resolver', min: 1, max: 60, step: 1, value: 10, unit: 'per min' },
];

const COMPARE_PARAMS: ParamSpec[] = [
  { name: 'short', label: 'Short TTL', min: 30, max: 600, step: 30, value: 60, unit: 's' },
  { name: 'long', label: 'Long TTL', min: 900, max: 7200, step: 300, value: 3600, unit: 's' },
  { name: 'rate', label: 'Lookups per resolver', min: 1, max: 60, step: 1, value: 10, unit: 'per min' },
];

export const createDnsCacheModel: SimFactory = (config) => {
  const mode = (config.mode as Mode) ?? 'propagation';
  const isCompare = mode === 'compare';

  let p: Record<string, number> = {};
  let rng: Rng;
  let worlds: World[] = [];
  let t = 0; // simulated seconds
  let speed = 60; // simulated seconds per real second
  let truth: Value = 'old'; // what the authoritative server says now
  let changedAt: number | null = null;
  let retireAt: number | null = null; // when the old server is switched off (propagation mode)
  let autoChange = 0;
  let span = 1; // compare: seconds shown on the time axis
  let lastLog: string | null = null;

  function change(): void {
    truth = truth === 'old' ? 'new' : 'old';
    changedAt = t;
    retireAt = truth === 'new' ? t + worlds[0].ttl : null;
    for (const w of worlds) {
      w.lookupsAfter = w.oldAfter = w.failedAfter = 0;
    }
    lastLog = `${clock(t)}: the record now says ${ADDRESS[truth]}. Nothing is sent to the caches.`;
  }

  function advance(w: World, until: number, mean: number): void {
    for (const c of w.caches) {
      while (c.nextLookup <= until) {
        const now = c.nextLookup;
        if (!c.pinned && now >= c.expires) {
          // The cached copy has expired: ask the authoritative server again.
          const before = c.value;
          c.value = truth;
          c.expires = now + w.ttl;
          c.lastFetch = now;
          w.authQueries++;
          if (!isCompare && before !== c.value) {
            lastLog = `${clock(now)}: ${c.label}'s copy expired; it fetched again and got the ${c.value} address`;
          }
        }
        if (changedAt !== null) {
          w.lookupsAfter++;
          if (c.value !== truth) {
            w.oldAfter++;
            if (retireAt !== null && now >= retireAt) w.failedAfter++;
          }
        }
        if (isCompare) {
          w.bucket.lookups++;
          if (c.value === 'old') w.bucket.old++;
        }
        c.nextLookup = now + rng.exponential(mean);
      }
    }
    if (isCompare) {
      const width = span / 80;
      while (until - w.bucket.start >= width) {
        const share = w.bucket.lookups ? w.bucket.old / w.bucket.lookups : (w.samples.at(-1)?.oldShare ?? 1);
        w.samples.push({ t: w.bucket.start + width, oldShare: share });
        w.bucket = { lookups: 0, old: 0, start: w.bucket.start + width };
      }
    }
  }

  // ---------- drawing: propagation ----------

  const ROW0 = 84;
  const ROW_H = 38;
  const BAR_X = 128;
  const BAR_W = 206;

  function renderPropagation(view: SVGSVGElement): void {
    const w = worlds[0];
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      w.caches.forEach((c, i) => {
        const y = ROW0 + i * ROW_H;
        text(c.label, { x: 4, y: y + 15, fill: INK, 'font-size': 19, 'font-weight': c.pinned ? 600 : 400 }, base);
        svg('rect', { x: BAR_X, y: y, width: BAR_W, height: 20, rx: 4, fill: 'none', stroke: STROKE, 'stroke-width': 1.5 }, base);
      });
      text('time left on each cached copy', { x: BAR_X + BAR_W / 2, y: ROW0 - 8, 'text-anchor': 'middle', fill: MUTED, 'font-size': 17 }, base);
    }

    const live = layer(view, 'live');
    clear(live);

    // The authoritative server: the truth, which changes in one place.
    const retired = retireAt !== null && t >= retireAt;
    svg('rect', { x: 64, y: 6, width: 272, height: 52, rx: 6, fill: token('--viz-server-soft'), stroke: token('--viz-server'), 'stroke-width': 2 }, live);
    text('Authoritative server', { x: 200, y: 27, 'text-anchor': 'middle', fill: INK, 'font-size': 18, 'font-weight': 700 }, live);
    text(`api = ${ADDRESS[truth]} (${truth})`, { x: 200, y: 50, 'text-anchor': 'middle', fill: COLOUR[truth], 'font-size': 18, 'font-weight': 600 }, live);

    w.caches.forEach((c, i) => {
      const y = ROW0 + i * ROW_H;
      const failing = retired && c.value === 'old';
      const colour = failing ? token('--viz-bad') : COLOUR[c.value];
      if (c.pinned) {
        svg('rect', { x: BAR_X, y, width: BAR_W, height: 20, rx: 4, fill: colour, opacity: 0.85 }, live);
        text('kept for ever', { x: BAR_X + BAR_W / 2, y: y + 16, 'text-anchor': 'middle', fill: token('--viz-surface'), 'font-size': 16, 'font-weight': 700 }, live);
      } else {
        const left = clamp((c.expires - t) / w.ttl, 0, 1);
        if (left > 0) svg('rect', { x: BAR_X, y, width: BAR_W * left, height: 20, rx: 4, fill: colour, opacity: 0.85 }, live);
      }
      // A query to the authoritative server just happened: a blue dot by the bar.
      if (t - c.lastFetch < speed * 0.35) svg('circle', { cx: BAR_X - 10, cy: y + 10, r: 6, fill: token('--viz-flow') }, live);
      text(failing ? 'fail' : c.value, { x: 396, y: y + 16, 'text-anchor': 'end', fill: colour, 'font-size': 18, 'font-weight': 700 }, live);
    });

    const yText = ROW0 + w.caches.length * ROW_H + 14;
    const stillOld = w.caches.filter((c) => c.value !== truth).length;
    let message: string;
    if (changedAt === null) message = `${clock(t)}: every cache agrees. Change coming…`;
    else if (retired && stillOld) message = `Old server off. ${stillOld} cache${stillOld > 1 ? 's' : ''} still send users to it.`;
    else if (stillOld) message = `${clock(t - changedAt)} after the change: ${stillOld} of ${w.caches.length} still old`;
    else message = `${clock(t - changedAt)} after the change: every cache has the new address`;
    text(message, { x: 4, y: yText, fill: retired && stillOld ? token('--viz-bad') : INK, 'font-size': 18, 'font-weight': 600 }, live);
  }

  // ---------- drawing: compare ----------

  const PANEL_H = 140;
  const CHART_X = 112;
  const CHART_W = 280;
  const CHART_H = 64;

  function renderCompare(view: SVGSVGElement): void {
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      worlds.forEach((w, i) => {
        const y = 8 + i * PANEL_H;
        text(`TTL ${clock(w.ttl)}`, { x: 4, y: y + 18, fill: INK, 'font-size': 19, 'font-weight': 700 }, base);
        const cy = y + 32;
        svg('line', { x1: CHART_X, y1: cy + CHART_H, x2: CHART_X + CHART_W, y2: cy + CHART_H, stroke: STROKE, 'stroke-width': 1.5 }, base);
        svg('line', { x1: CHART_X, y1: cy, x2: CHART_X, y2: cy + CHART_H, stroke: STROKE, 'stroke-width': 1.5 }, base);
        text('100% old', { x: CHART_X + CHART_W - 2, y: cy + 14, 'text-anchor': 'end', fill: MUTED, 'font-size': 16 }, base);
        text('0%', { x: CHART_X + CHART_W - 2, y: cy + CHART_H - 4, 'text-anchor': 'end', fill: MUTED, 'font-size': 16 }, base);
        const xc = CHART_X + ((changedAt ?? autoChange) / span) * CHART_W;
        svg('line', { x1: xc, y1: cy - 4, x2: xc, y2: cy + CHART_H, stroke: INK, 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, base);
        if (i === 0) text('change', { x: xc + 4, y: y + 18, fill: MUTED, 'font-size': 16 }, base);
      });
    }

    const live = layer(view, 'live');
    clear(live);
    worlds.forEach((w, i) => {
      const y = 8 + i * PANEL_H;
      const cy = y + 32;
      // Five little caches, coloured by what they hold now.
      w.caches.forEach((c, k) => {
        svg('rect', { x: 4 + k * 20, y: cy + 4, width: 15, height: 15, rx: 3, fill: COLOUR[c.value] }, live);
      });
      // Share of lookups that got the old address, over time.
      if (w.samples.length) {
        const pts = w.samples.map((s) => `${CHART_X + (s.t / span) * CHART_W},${cy + CHART_H - s.oldShare * CHART_H}`);
        svg('polyline', { points: `${CHART_X},${cy} ${pts.join(' ')}`, fill: 'none', stroke: COLOUR.old, 'stroke-width': 2.5 }, live);
      }
      const hours = Math.max(t, 1) / 3600;
      text(`${w.authQueries} queries`, { x: 4, y: cy + 42, fill: token('--viz-flow'), 'font-size': 17, 'font-weight': 700 }, live);
      text(`${Math.round(w.authQueries / hours)}/h`, { x: 4, y: cy + 62, fill: token('--viz-flow'), 'font-size': 17 }, live);
      const after = changedAt === null ? 'before the change' : `${percent(w.oldAfter, w.lookupsAfter)} old answers since the change`;
      text(after, { x: CHART_X, y: cy + CHART_H + 24, fill: INK, 'font-size': 16 }, live);
    });
    const cursor = CHART_X + (Math.min(t, span) / span) * CHART_W;
    svg('line', { x1: cursor, y1: 36, x2: cursor, y2: 8 + PANEL_H + 32 + CHART_H, stroke: MUTED, 'stroke-width': 1 }, live);
  }

  return {
    params: isCompare ? COMPARE_PARAMS : PROPAGATION_PARAMS,

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      truth = 'old';
      changedAt = retireAt = null;
      lastLog = null;
      if (isCompare) {
        worlds = [makeWorld(p.short, p.rate, rng, false), makeWorld(p.long, p.rate, rng, false)];
        autoChange = 900; // 15 minutes in
        span = autoChange + p.long * 1.25;
        speed = span / 24; // the whole picture plays in about 24 seconds
      } else {
        worlds = [makeWorld(p.ttl, p.rate, rng, true)];
        autoChange = p.ttl * 0.6;
        speed = p.ttl / 5; // one TTL every 5 seconds
      }
    },

    step(dtMs) {
      const until = t + (dtMs / 1000) * speed;
      if (changedAt === null && until >= autoChange) {
        for (const w of worlds) advance(w, autoChange, 60 / p.rate);
        t = autoChange;
        change();
      }
      for (const w of worlds) advance(w, until, 60 / p.rate);
      t = until;
      if (isCompare && t > span) {
        t = span; // hold the finished picture; Reset replays
      }
    },

    render(view) {
      const base = layer(view, 'base');
      const key = JSON.stringify(p) + (changedAt ?? '');
      if (base.dataset.key !== key) {
        clear(base);
        base.dataset.key = key;
      }
      if (isCompare) renderCompare(view);
      else renderPropagation(view);
    },

    stats() {
      if (isCompare) {
        const [a, b] = worlds;
        return {
          time: clock(t),
          [`queries, TTL ${clock(a.ttl)}`]: a.authQueries,
          [`queries, TTL ${clock(b.ttl)}`]: b.authQueries,
          [`old answers, TTL ${clock(a.ttl)}`]: changedAt === null ? '…' : percent(a.oldAfter, a.lookupsAfter),
          [`old answers, TTL ${clock(b.ttl)}`]: changedAt === null ? '…' : percent(b.oldAfter, b.lookupsAfter),
        };
      }
      const w = worlds[0];
      return {
        time: clock(t),
        'since change': changedAt === null ? '…' : clock(t - changedAt),
        'caches still old': w.caches.filter((c) => c.value !== truth).length,
        'old answers since change': changedAt === null ? '…' : percent(w.oldAfter, w.lookupsAfter),
        'failed lookups': w.failedAfter,
        'authoritative queries': w.authQueries,
      };
    },

    log() {
      if (t === 0) return 'Press Play. The record changes partway through the run.';
      if (!isCompare && retireAt !== null && t >= retireAt && worlds[0].failedAfter > 0) {
        return `${clock(retireAt)}: one TTL after the change, the old server was switched off. Only the pinned app still uses it.`;
      }
      return lastLog;
    },

    actions: [
      {
        label: 'Change the record now',
        run() {
          if (isCompare) return; // compare mode changes once, at a fixed time, so both worlds match
          change();
        },
      },
    ].filter(() => !isCompare),
  };
};
