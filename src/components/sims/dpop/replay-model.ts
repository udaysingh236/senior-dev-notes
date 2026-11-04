// Ten minutes of an attacker trying stolen DPoP material against an API behind a load balancer.
//
// From the first second the attacker holds three things, and tries each every 10 s:
//  - the access token alone, copied from a log (no private key, so any proof they sign has the
//    wrong key);
//  - one complete captured request: token plus the proof the real client made at t = 0;
//  - a stash of proofs that injected script signed in advance with the real key, one for each
//    10 s, each with its own jti and its iat set to the moment it will be used.
// A fourth row shows what the same token would be worth as a plain bearer token.
//
// The API checks, in this order: token expiry, server nonce, iat window, jti. The real request at
// t = 0 went to node 0, so node 0 (or the shared store) already holds the captured proof's jti.
// The real client keeps making requests too, so the cost of nonces shows up as its extra round
// trips: one whenever its last nonce is more than one rotation old.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const HORIZON = 600; // seconds of attack shown
const EVERY = 10; // seconds between tries, per row
const RATE = 12.5; // attack seconds per real second at 1× speed
const X0 = 8;
const X1 = 392;
const ROW_Y = [62, 120, 178, 236];
const ROWS = ['If it were Bearer', 'DPoP token, no key', 'Captured request', 'Pre-signed proofs'];
const JTI_MODES = ['off', 'per node', 'shared'];

type Outcome = { at: number; row: number; ok: boolean };

const x = (t: number) => X0 + ((X1 - X0) * t) / HORIZON;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export const createReplayModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextTry = EVERY;
  let outcomes: Outcome[] = [];
  let drawn = 0;
  let fresh = true; // reset since the last render: clear the marks layer
  let seen: boolean[] = []; // per node: holds the captured proof's jti
  let reasons: Record<string, number> = {};
  let stashStopped = false;
  let lastEvent: string | null = null;
  let legitNext = 0;
  let legitRequests = 0;
  let legitRetries = 0;
  let legitBucket = 0;

  const bucket = (at: number) => (p.nonce ? Math.floor(at / p.nonce) : 0);
  // The server accepts its current nonce and the one before it.
  const nonceStale = (issuedAt: number, at: number) => p.nonce > 0 && bucket(at) > bucket(issuedAt) + 1;

  function block(row: number, at: number, reason: string): Outcome {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    return { at, row, ok: false };
  }

  function tryRow(row: number, at: number): Outcome {
    if (at >= p.lifetime) return block(row, at, 'token expired');
    if (row === 0) return { at, row, ok: true };
    if (row === 1) return block(row, at, 'key does not match cnf.jkt');
    if (nonceStale(0, at)) return block(row, at, 'nonce no longer accepted');
    if (row === 3) return { at, row, ok: true }; // its own jti, iat = now: nothing else catches it
    if (at > p.window) return block(row, at, 'iat outside the window');
    if (p.jti === 0) return { at, row, ok: true };
    if (p.jti === 2) return block(row, at, 'jti already used');
    const node = rng.int(0, p.nodes - 1);
    if (seen[node]) return block(row, at, 'jti already used');
    seen[node] = true;
    lastEvent = `t=${clock(at)} the captured request reached node ${node + 1}, whose cache had not seen its jti: accepted`;
    return { at, row, ok: true };
  }

  function advance(to: number): void {
    while (legitNext <= to) {
      legitRequests++;
      if (nonceStale(legitBucket * p.nonce, legitNext)) legitRetries++; // a 401, then a retry
      legitBucket = bucket(legitNext);
      legitNext += rng.exponential(20);
    }
    while (nextTry <= Math.min(to, HORIZON)) {
      for (let row = 0; row < ROWS.length; row++) outcomes.push(tryRow(row, nextTry));
      const stash = outcomes[outcomes.length - 1];
      if (!stash.ok && !stashStopped) {
        stashStopped = true;
        const why = stash.at >= p.lifetime ? 'the access token expired, and each proof carries its hash (ath)' : 'the nonce they carry is no longer accepted';
        lastEvent = `t=${clock(stash.at)} pre-signed proofs stop working: ${why}`;
      }
      nextTry += EVERY;
    }
    t = Math.min(to, HORIZON);
  }

  const got = (row: number) => outcomes.filter((o) => o.row === row && o.ok).length;

  return {
    params: [
      { name: 'window', label: 'Proof window (iat)', min: 10, max: 300, step: 10, value: 60, unit: 's' },
      { name: 'jti', label: 'jti replay store', min: 0, max: 2, step: 1, value: 1, format: (v) => JTI_MODES[v] },
      { name: 'nodes', label: 'API instances', min: 1, max: 8, step: 1, value: 4 },
      { name: 'nonce', label: 'Server nonce rotation', min: 0, max: 600, step: 30, value: 0, format: (v) => (v ? `every ${v} s` : 'off') },
      { name: 'lifetime', label: 'Access token lifetime', min: 60, max: 900, step: 60, value: 300, format: (v) => `${v / 60} min` },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      nextTry = EVERY;
      outcomes = [];
      drawn = 0;
      fresh = true;
      seen = Array.from({ length: p.nodes }, (_, i) => i === 0);
      reasons = {};
      stashStopped = false;
      legitNext = 0;
      legitRequests = 0;
      legitRetries = 0;
      legitBucket = 0;
      lastEvent = `t=0:00 the real client's request reached node 1. The attacker now holds the token, that request, and ${HORIZON / EVERY} proofs signed in advance.`;
    },

    step(dt) {
      advance(t + (dt / 1000) * RATE);
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        svg('line', { x1: X0, y1: 30, x2: X1, y2: 30, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
        for (const m of [0, 5, 10]) {
          svg('line', { x1: x(m * 60), y1: 26, x2: x(m * 60), y2: 34, stroke: token('--viz-muted'), 'stroke-width': 1.5 }, base);
          text(m === 0 ? '0' : `${m} min`, { x: x(m * 60), y: 20, 'font-size': 17, 'text-anchor': m === 0 ? 'start' : m === 10 ? 'end' : 'middle', fill: token('--viz-muted') }, base);
        }
        ROWS.forEach((label, row) => {
          text(label, { x: X0, y: ROW_Y[row], 'font-size': 19, 'font-weight': 600, fill: token('--viz-ink') }, base);
          svg('rect', { x: X0, y: ROW_Y[row] + 8, width: X1 - X0, height: 28, rx: 4, fill: token('--viz-surface'), stroke: token('--viz-stroke'), 'stroke-width': 1 }, base);
        });
        // Legend: shape carries the meaning as well as colour.
        svg('rect', { x: X0, y: 288, width: 6, height: 20, rx: 1, fill: token('--viz-bad') }, base);
        text('got in', { x: X0 + 12, y: 305, 'font-size': 17, fill: token('--viz-ink') }, base);
        svg('rect', { x: 92, y: 300, width: 5, height: 8, rx: 1, fill: token('--viz-ok') }, base);
        text('blocked', { x: 103, y: 305, 'font-size': 17, fill: token('--viz-ink') }, base);
        svg('line', { x1: 192, y1: 288, x2: 192, y2: 308, stroke: token('--viz-warn'), 'stroke-width': 2, 'stroke-dasharray': '4 3' }, base);
        text('token expires', { x: 200, y: 305, 'font-size': 17, fill: token('--viz-ink') }, base);
        text('jti caches', { x: X0, y: 344, 'font-size': 17, fill: token('--viz-muted') }, base);
      }

      // Lines that depend on the settings: token expiry and nonce rotations.
      const marks = layer(view, 'marks');
      const settings = layer(view, 'settings');
      if (fresh) {
        clear(marks);
        clear(settings);
        fresh = false;
        if (p.lifetime < HORIZON) {
          svg('line', { x1: x(p.lifetime), y1: 34, x2: x(p.lifetime), y2: ROW_Y[3] + 40, stroke: token('--viz-warn'), 'stroke-width': 2, 'stroke-dasharray': '5 4' }, settings);
        }
        for (let s = p.nonce; p.nonce && s < HORIZON; s += p.nonce) {
          svg('circle', { cx: x(s), cy: 30, r: 3.5, fill: token('--viz-flow') }, settings);
        }
      }
      for (; drawn < outcomes.length; drawn++) {
        const o = outcomes[drawn];
        const y = ROW_Y[o.row] + 8;
        svg('rect', o.ok
          ? { x: x(o.at) - 2.5, y: y + 2, width: 5, height: 24, rx: 1, fill: token('--viz-bad') }
          : { x: x(o.at) - 2, y: y + 18, width: 4, height: 8, rx: 1, fill: token('--viz-ok') }, marks);
      }

      const live = layer(view, 'live');
      clear(live);
      svg('line', { x1: x(t), y1: 26, x2: x(t), y2: ROW_Y[3] + 40, stroke: token('--viz-ink'), 'stroke-width': 1, opacity: 0.5 }, live);
      ROWS.forEach((_, row) => {
        const n = got(row);
        text(n ? `${n} in` : '0', { x: X1, y: ROW_Y[row], 'font-size': 19, 'font-weight': 600, 'text-anchor': 'end', fill: n ? token('--viz-bad') : token('--viz-ok') }, live);
      });

      const bx = 100;
      if (p.jti === 0) {
        text('none: nothing remembers', { x: bx, y: 344, 'font-size': 17, fill: token('--viz-warn') }, live);
      } else if (p.jti === 2) {
        const held = t <= p.window;
        svg('rect', { x: bx, y: 324, width: X1 - bx, height: 28, rx: 4, fill: held ? token('--viz-ok-soft') : token('--viz-surface'), stroke: held ? token('--viz-ok') : token('--viz-stroke'), 'stroke-width': 1.5 }, live);
        text(held ? 'one shared store: seen' : 'one shared store: expired', { x: bx + 10, y: 344, 'font-size': 17, fill: token('--viz-ink') }, live);
      } else {
        const w = Math.min(44, (X1 - bx - 4 * (p.nodes - 1)) / p.nodes);
        seen.forEach((s, i) => {
          const held = s && t <= p.window;
          svg('rect', { x: bx + i * (w + 4), y: 324, width: w, height: 28, rx: 4, fill: held ? token('--viz-ok-soft') : token('--viz-surface'), stroke: held ? token('--viz-ok') : token('--viz-stroke'), 'stroke-width': 1.5 }, live);
          text(held ? 'seen' : String(i + 1), { x: bx + i * (w + 4) + w / 2, y: 344, 'font-size': held ? 13 : 17, 'text-anchor': 'middle', fill: held ? token('--viz-ok') : token('--viz-muted') }, live);
        });
      }
    },

    stats() {
      const blocked = Object.entries(reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([why, n]) => `${n} ${why}`)
        .join(', ');
      return {
        'attack time': clock(t),
        'captured request got in': got(2),
        'pre-signed proofs got in': got(3),
        'blocked because': blocked || '–',
        'real client: requests, extra round trips for a nonce': `${legitRequests}, ${legitRetries}`,
      };
    },

    log: () => lastEvent,
  };
};
