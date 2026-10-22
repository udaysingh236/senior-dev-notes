// What users see when the authoritative side of a popular name fails, through 200 resolver caches.
//
// config.kind picks the failure:
//   'unreachable'  every authoritative server times out from t=0 for `outage` minutes. A cache whose
//                  copy expires during the outage cannot refresh. Resolvers that serve stale
//                  (RFC 8767) keep answering with the expired copy; the others answer SERVFAIL.
//   'empty'        the authoritative servers stay up but publish an empty answer (NOERROR, no
//                  addresses) for `outage` minutes, as in the October 2025 DynamoDB incident. That is
//                  a valid answer, so serve-stale does not apply, and it is cached as a negative
//                  answer for the negative TTL, which outlives the fix.
//
// Each cache fetched its copy at a random moment within one TTL before the run, and users ask each
// cache as a seeded Poisson stream.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { ParamSpec, Rng, SimFactory } from '../../sim/types';

type Kind = 'unreachable' | 'empty';
type State = 'fresh' | 'stale' | 'failing';

const CACHES = 200;
const COLS = 20;
const LOOKUP_GAP = 15; // mean seconds between user lookups at one cache
const SPEED = 240; // simulated seconds per real second
const STALE_TTL = 30; // RFC 8767's suggested TTL on a stale answer
const BUCKET = 60;
const BEFORE = 5 * 60;

interface Cache {
  servesStale: boolean;
  state: State;
  expires: number; // positive copy, or negative answer, or stale re-check time
  negative: boolean;
  nextLookup: number;
}

interface Bucket {
  t: number;
  lookups: number;
  failed: number;
  stale: number;
}

export interface OutageResult {
  failed: number;
  stale: number;
  lookups: number;
  peakFailingShare: number; // highest per-minute share of failing lookups
  failingAtMinute: Record<number, number>; // minute -> share failing, for checks
  lastFailure: number; // seconds, relative to t=0 (the outage start)
}

const PARAMS: Record<Kind, ParamSpec[]> = {
  unreachable: [
    { name: 'ttl', label: 'TTL of the record', min: 60, max: 7200, step: 60, value: 300, unit: 's' },
    { name: 'outage', label: 'Outage length', min: 5, max: 180, step: 5, value: 60, unit: 'min' },
    { name: 'stale', label: 'Resolvers that serve stale', min: 0, max: 100, step: 10, value: 0, unit: '%' },
  ],
  empty: [
    { name: 'ttl', label: 'TTL of the record', min: 60, max: 7200, step: 60, value: 300, unit: 's' },
    { name: 'outage', label: 'Empty record published for', min: 5, max: 180, step: 5, value: 50, unit: 'min' },
    { name: 'negTtl', label: 'Negative TTL (SOA minimum)', min: 60, max: 3600, step: 60, value: 900, unit: 's' },
  ],
};

function rel(s: number): string {
  const sign = s < 0 ? '−' : '+';
  const a = Math.abs(Math.round(s));
  if (a < 60) return `${sign}${a} s`;
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return h ? `${sign}${h} h ${String(m).padStart(2, '0')} min` : `${sign}${m} min`;
}

export const createOutageModel: SimFactory = (config) => {
  const kind: Kind = config.kind === 'empty' ? 'empty' : 'unreachable';
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let end = 0;
  let caches: Cache[] = [];
  let buckets: Bucket[] = [];
  let failed = 0;
  let stale = 0;
  let lookups = 0;
  let lastFailure = -Infinity;
  let lastEvent: string | null = null;
  let done = false;

  const fixAt = () => p.outage * 60;
  const broken = (now: number) => now >= 0 && now < fixAt();

  function bucketAt(time: number): Bucket {
    const i = Math.floor((time + BEFORE) / BUCKET);
    while (buckets.length <= i) buckets.push({ t: -BEFORE + buckets.length * BUCKET, lookups: 0, failed: 0, stale: 0 });
    return buckets[i];
  }

  function lookup(c: Cache, now: number): void {
    if (now >= c.expires) {
      if (!broken(now)) {
        c.state = 'fresh';
        c.negative = false;
        c.expires = now + p.ttl;
      } else if (kind === 'empty') {
        // A valid, empty answer: cached as negative for the negative TTL.
        c.state = 'failing';
        c.negative = true;
        c.expires = now + p.negTtl;
      } else if (c.servesStale) {
        c.state = 'stale';
        c.expires = now + STALE_TTL; // try the authoritative servers again after this
      } else {
        c.state = 'failing';
        c.expires = now + 5; // a short failure cache (RFC 9520 asks for 1 s to 5 min); illustrative
      }
    }
    const b = bucketAt(now);
    b.lookups++;
    lookups++;
    if (c.state === 'failing') {
      b.failed++;
      failed++;
      lastFailure = now;
    } else if (c.state === 'stale') {
      b.stale++;
      stale++;
    }
  }

  function advanceTo(target: number): void {
    while (true) {
      let next: Cache | null = null;
      for (const c of caches) if (c.nextLookup <= target && (!next || c.nextLookup < next.nextLookup)) next = c;
      if (!next) break;
      lookup(next, next.nextLookup);
      next.nextLookup += rng.exponential(LOOKUP_GAP);
    }
  }

  const model = {
    params: PARAMS[kind],

    reset(params: Record<string, number>, r: Rng) {
      p = params;
      rng = r;
      t = -BEFORE;
      const lag = kind === 'empty' ? p.negTtl : 0;
      end = fixAt() + Math.max(20 * 60, lag + 10 * 60);
      buckets = [];
      failed = 0;
      stale = 0;
      lookups = 0;
      lastFailure = -Infinity;
      done = false;
      const staleCount = kind === 'unreachable' ? Math.round((CACHES * p.stale) / 100) : 0;
      const order = Array.from({ length: CACHES }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j], order[i]];
      }
      const staleSet = new Set(order.slice(0, staleCount));
      caches = Array.from({ length: CACHES }, (_, i) => ({
        servesStale: staleSet.has(i),
        state: 'fresh' as State,
        expires: -BEFORE - rng.range(0, p.ttl) + p.ttl,
        negative: false,
        nextLookup: -BEFORE + rng.exponential(LOOKUP_GAP),
      }));
      lastEvent = kind === 'empty'
        ? `At 0 the record is published empty; it is fixed at ${rel(fixAt())}.`
        : `At 0 every authoritative server stops answering; they are back at ${rel(fixAt())}.`;
    },

    step(dtMs: number) {
      if (done) return;
      const target = Math.min(t + (dtMs / 1000) * SPEED, end);
      const crossedStart = t < 0 && target >= 0;
      const crossedFix = t < fixAt() && target >= fixAt();
      advanceTo(target);
      t = target;
      if (crossedStart) lastEvent = kind === 'empty' ? '0: the record is now empty. Caches find out as their copies expire.' : '0: the authoritative servers are down. Caches find out as their copies expire.';
      if (crossedFix) lastEvent = `${rel(fixAt())}: fixed at the source. ${caches.filter((c) => c.state === 'failing').length} caches are still failing.`;
      if (t >= end) {
        done = true;
        lastEvent = `Run finished: ${failed} of ${lookups} lookups failed${lastFailure > -Infinity ? `, the last at ${rel(lastFailure)}` : ''}.`;
      }
    },

    render(view: SVGSVGElement) {
      const cell = 392 / COLS;
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        text('200 resolver caches', { x: 4, y: 18, 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') }, base);
        const legend: [string, string][] = kind === 'empty'
          ? [['answering', '--viz-ok'], ['cached "no address"', '--viz-bad']]
          : [['fresh', '--viz-ok'], ['stale', '--viz-warn'], ['SERVFAIL', '--viz-bad']];
        let lx = 4;
        legend.forEach(([label, tone]) => {
          svg('rect', { x: lx, y: 206, width: 14, height: 14, rx: 3, fill: token(`${tone}-soft` as `--viz-${string}`), stroke: token(tone as `--viz-${string}`), 'stroke-width': 1.5 }, base);
          text(label, { x: lx + 19, y: 218, 'font-size': 15, fill: token('--viz-muted') }, base);
          lx += label.length * 8 + 40;
        });
        text('share of lookups failing', { x: 4, y: 250, 'font-size': 15, fill: token('--viz-muted') }, base);
        svg('line', { x1: 4, y1: 340, x2: 396, y2: 340, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      caches.forEach((c, i) => {
        const x = 4 + (i % COLS) * cell;
        const y = 28 + Math.floor(i / COLS) * 17;
        const tone = c.state === 'fresh' ? '--viz-ok' : c.state === 'stale' ? '--viz-warn' : '--viz-bad';
        svg('rect', { x: x + 1, y, width: cell - 3, height: 14, rx: 3, fill: token(`${tone}-soft` as `--viz-${string}`), stroke: token(tone as `--viz-${string}`), 'stroke-width': 1.5 }, live);
      });
      text(rel(t), { x: 396, y: 18, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'end', fill: token('--viz-ink'), style: 'font-family: var(--sl-font-mono)' }, live);

      const top = 262;
      const h = 76;
      const span = end + BEFORE;
      const xOf = (time: number) => 4 + ((time + BEFORE) / span) * 392;
      svg('rect', { x: xOf(0), y: top - 4, width: xOf(fixAt()) - xOf(0), height: h + 4, fill: token('--viz-stroke'), opacity: 0.18 }, live);
      text(kind === 'empty' ? 'record empty' : 'servers down', { x: xOf(0), y: top + h + 20, 'font-size': 14, fill: token('--viz-muted') }, live);
      const fail: string[] = [];
      const st: string[] = [];
      buckets.forEach((b) => {
        if (!b.lookups || b.t > t) return;
        const x = (xOf(b.t + BUCKET / 2)).toFixed(1);
        fail.push(`${x},${(top + h - (b.failed / b.lookups) * h).toFixed(1)}`);
        st.push(`${x},${(top + h - (b.stale / b.lookups) * h).toFixed(1)}`);
      });
      if (kind === 'unreachable' && st.length > 1) svg('polyline', { points: st.join(' '), fill: 'none', stroke: token('--viz-warn'), 'stroke-width': 2, 'stroke-dasharray': '5 3' }, live);
      if (fail.length > 1) svg('polyline', { points: fail.join(' '), fill: 'none', stroke: token('--viz-bad'), 'stroke-width': 2.5 }, live);
    },

    stats() {
      const failing = caches.filter((c) => c.state === 'failing').length;
      const out: Record<string, string | number> = {
        'caches failing now': `${failing} of ${CACHES}`,
        'lookups failed': lookups ? `${failed} (${Math.round((failed / lookups) * 100)}%)` : '0',
      };
      if (kind === 'unreachable') out['answered from stale copies'] = stale;
      out['last failure, from the outage start'] = lastFailure > -Infinity ? rel(lastFailure) : 'none';
      return out;
    },

    log: () => lastEvent,

    /** For headless tests: run to the end and report. */
    result(): OutageResult {
      while (!done) model.step(20);
      const failingAtMinute: Record<number, number> = {};
      let peak = 0;
      buckets.forEach((b) => {
        if (!b.lookups) return;
        const share = b.failed / b.lookups;
        failingAtMinute[Math.round(b.t / 60)] = Math.round(share * 100);
        peak = Math.max(peak, share);
      });
      return { failed, stale, lookups, peakFailingShare: Math.round(peak * 100), failingAtMinute, lastFailure };
    },
  };
  return model;
};
