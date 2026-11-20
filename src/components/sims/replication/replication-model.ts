// A leader and two followers. Orders arrive at the leader at random (Poisson) and each one becomes
// the next entry in the leader's log. The leader streams every entry to both followers; an entry
// reaches a follower after that follower's one-way delay, the follower applies it at once (unless
// its replay is paused), and its "applied up to #n" reply takes the same delay to come back.
//
// The leader tells the customer "saved" (commits) when as many followers as the reader chose have
// replied for that entry: none (asynchronous), the first one to reply, or both.
//
// Buttons: cut follower A off for 5 s (nothing travels either way), pause follower B's replay for
// 5 s (a long query on it), and crash the leader. The crash is a power cut in the leader's rack: the
// leader and its network go down together, so changes still on their way never arrive. Then the
// follower that received the most is promoted, and the sim counts the orders customers were told
// were saved that it never received.
//
// What the reader controls: orders per second, each follower's distance, how many replies a commit
// waits for. What they watch: how far behind each follower is, how long a commit waits, how many
// customers are waiting, and how many saved orders a crash would lose.
import { layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const SUB = 1; // ms per internal step
const EVENT_MS = 5000; // how long a cut or a paused replay lasts
const PROMOTE_AFTER_MS = 400; // time between the crash and the promotion
const WINDOW_MS = 1000; // commit wait is averaged over the last second

interface Follower {
  name: string;
  delay: number; // one-way, ms
  sent: number; // highest position sent to it
  inFlight: { pos: number; sentAt: number; arrive: number }[];
  received: number;
  applied: number;
  acks: { pos: number; arrive: number }[];
  acked: number; // highest position whose reply has reached the leader
  cutUntil: number;
  pauseUntil: number;
}

const WAIT_LABELS = ['none (asynchronous)', 'first follower to reply', 'both followers'];

export const createReplicationModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let writeTimes: number[] = []; // writeTimes[pos - 1] = when entry #pos was written
  let committed = 0;
  let recentCommits: { at: number; wait: number }[] = [];
  let followers: Follower[] = [];
  let crashedAt = -1;
  let promoted: Follower | null = null;
  let lost = 0;
  let neverAnswered = 0;
  let lastEvent: string | null = null;

  const note = (msg: string) => (lastEvent = `t=${(t / 1000).toFixed(1)}s ${msg}`);
  const leaderPos = () => writeTimes.length;
  const cut = (f: Follower) => t < f.cutUntil;
  const paused = (f: Follower) => t < f.pauseUntil;

  function makeFollower(name: string, delay: number): Follower {
    return { name, delay, sent: 0, inFlight: [], received: 0, applied: 0, acks: [], acked: 0, cutUntil: -1, pauseUntil: -1 };
  }

  function behindMs(f: Follower): number {
    if (f.applied >= leaderPos()) return 0;
    return t - writeTimes[f.applied]; // age of the oldest change it has not applied
  }

  /** Average commit wait over the last second, or the age of the oldest order still waiting. */
  function waitText(): string {
    const waiting = leaderPos() - committed;
    if (crashedAt < 0 && waiting > 0 && !recentCommits.length) return `stuck ${Math.round(t - writeTimes[committed])} ms`;
    const avg = recentCommits.length ? recentCommits.reduce((s, c) => s + c.wait, 0) / recentCommits.length : 0;
    return `${avg.toFixed(avg < 10 ? 1 : 0)} ms`;
  }

  function commitUpTo(pos: number): void {
    for (let i = committed + 1; i <= pos; i++) recentCommits.push({ at: t, wait: t - writeTimes[i - 1] });
    if (pos > committed) committed = pos;
  }

  function subStep(): void {
    const alive = crashedAt < 0;

    // New orders arrive at the leader.
    while (alive && t >= nextArrival) {
      writeTimes.push(t);
      if (p.waitFor === 0) commitUpTo(leaderPos());
      nextArrival += rng.exponential(1000 / p.rate);
    }

    for (const f of followers) {
      // The leader streams new entries, unless the link is cut or the leader is dead.
      if (alive && !cut(f) && f.sent < leaderPos()) {
        for (let pos = f.sent + 1; pos <= leaderPos(); pos++) f.inFlight.push({ pos, sentAt: t, arrive: t + f.delay });
        f.sent = leaderPos();
      }
      // Entries on the wire arrive (they were sent before any cut began).
      while (f.inFlight.length && f.inFlight[0].arrive <= t) f.received = f.inFlight.shift()!.pos;
      // Apply what arrived, unless replay is paused, and send "applied up to #n" back.
      if (!paused(f) && f.applied < f.received) {
        f.applied = f.received;
        f.acks.push({ pos: f.applied, arrive: t + f.delay });
      }
      // Replies reach the leader, unless the link is cut (they wait) or the leader is dead.
      if (alive && !cut(f)) {
        while (f.acks.length && f.acks[0].arrive <= t) f.acked = f.acks.shift()!.pos;
      }
    }

    // Commit what enough followers have confirmed.
    if (alive && p.waitFor > 0) {
      const acked = followers.map((f) => f.acked).sort((a, b) => b - a);
      commitUpTo(acked[p.waitFor - 1]);
    }

    // Failover: promote the follower that received the most.
    if (!alive && !promoted && t >= crashedAt + PROMOTE_AFTER_MS) {
      promoted = followers.reduce((best, f) => (f.received > best.received ? f : best));
      lost = Math.max(0, committed - promoted.received);
      neverAnswered = leaderPos() - committed;
      note(`follower ${promoted.name} promoted with ${promoted.received} of ${leaderPos()} entries:`
        + ` ${lost} saved order${lost === 1 ? '' : 's'} lost`);
    }
    t += SUB;
  }

  return {
    params: [
      { name: 'rate', label: 'Orders per second', min: 10, max: 300, step: 10, value: 100 },
      { name: 'delayA', label: 'Follower A: one-way delay', min: 1, max: 100, step: 1, value: 1, unit: 'ms' },
      { name: 'delayB', label: 'Follower B: one-way delay', min: 5, max: 200, step: 5, value: 40, unit: 'ms' },
      {
        name: 'waitFor', label: 'Commit waits for', min: 0, max: 2, step: 1, value: 0,
        format: (v) => WAIT_LABELS[v],
      },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      nextArrival = rng.exponential(1000 / p.rate);
      writeTimes = [];
      committed = 0;
      recentCommits = [];
      followers = [makeFollower('A', p.delayA), makeFollower('B', p.delayB)];
      crashedAt = -1;
      promoted = null;
      lost = 0;
      neverAnswered = 0;
      lastEvent = null;
    },

    step(dt) {
      const end = t + dt;
      while (t < end) subStep();
      recentCommits = recentCommits.filter((c) => c.at > t - WINDOW_MS);
    },

    render(view) {
      const live = layer(view, 'live');
      live.replaceChildren();
      const ink = token('--viz-ink');
      const muted = token('--viz-muted');
      const bold = { 'font-size': 17, 'font-weight': 700, fill: ink };
      const crashed = crashedAt >= 0;

      // App
      svg('rect', { x: 2, y: 14, width: 104, height: 56, rx: 6, fill: token('--viz-client-soft'), stroke: token('--viz-client'), 'stroke-width': 1.5 }, live);
      text('App', { x: 54, y: 37, 'text-anchor': 'middle', ...bold }, live);
      text(crashed ? 'stopped' : `${p.rate} orders/s`, { x: 54, y: 59, 'text-anchor': 'middle', 'font-size': 14, fill: muted }, live);
      svg('line', { x1: 108, y1: 42, x2: 150, y2: 42, stroke: token('--viz-flow'), 'stroke-width': 2 }, live);
      svg('path', { d: 'M150 36 L158 42 L150 48 z', fill: token('--viz-flow') }, live);

      // Leader (a cylinder)
      const lx = 160, lw = 150;
      const lTone = crashed ? '--viz-bad' : '--viz-store';
      cylinder(live, lx, 8, lw, 74, lTone);
      text(crashed ? 'Leader: crashed' : 'Leader', { x: lx + lw / 2, y: 44, 'text-anchor': 'middle', ...bold }, live);
      text(`log at #${leaderPos()}`, { x: lx + lw / 2, y: 66, 'text-anchor': 'middle', 'font-size': 14, fill: muted, 'font-family': 'var(--sl-font-mono)' }, live);
      const waiting = leaderPos() - committed;
      const wt = waitText();
      const slow = wt.startsWith('stuck') || parseFloat(wt) > 50;
      text(`commit: ${wt}`, { x: 2, y: 100, 'font-size': 15, 'font-weight': 700, fill: token(slow ? '--viz-warn' : '--viz-ok') }, live);
      text(`${crashed ? neverAnswered : waiting} waiting`, { x: 398, y: 100, 'text-anchor': 'end', 'font-size': 15, fill: waiting > 20 ? token('--viz-warn') : muted }, live);

      // Pipes and followers
      const fx = [8, 208];
      followers.forEach((f, i) => {
        const x = fx[i];
        const top = 196;
        const startX = lx + lw / 2 + (i === 0 ? -30 : 30);
        const endX = x + 92;
        const isCut = cut(f);
        svg('line', {
          x1: startX, y1: 112, x2: endX, y2: top - 6,
          stroke: token(isCut ? '--viz-bad' : '--viz-stroke'), 'stroke-width': 2, 'stroke-dasharray': isCut ? '6 5' : null,
        }, live);
        if (isCut) text('cut', { x: (startX + endX) / 2 + (i === 0 ? -16 : 16), y: 156, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: token('--viz-bad') }, live);
        // Changes on the wire, as dots (at most 16 drawn)
        f.inFlight.slice(-16).forEach((m) => {
          const k = Math.min(1, (t - m.sentAt) / Math.max(1, m.arrive - m.sentAt));
          svg('circle', { cx: startX + (endX - startX) * k, cy: 112 + (top - 6 - 112) * k, r: 4, fill: token('--viz-flow') }, live);
        });

        const isPaused = paused(f);
        const isNew = promoted === f;
        const tone = isNew ? '--viz-ok' : isPaused ? '--viz-warn' : '--viz-store';
        cylinder(live, x, top, 184, 66, tone);
        text(isNew ? `${f.name}: new leader` : `Follower ${f.name}`, { x: x + 92, y: top + 30, 'text-anchor': 'middle', ...bold }, live);
        text(`${f.delay} ms away`, { x: x + 92, y: top + 52, 'text-anchor': 'middle', 'font-size': 14, fill: muted }, live);
        const behind = leaderPos() - f.applied;
        const ms = behindMs(f);
        const status = crashed ? `has up to #${f.received}`
          : isPaused ? `replay paused · ${behind} behind` : `${behind} behind · ${ms < 10 ? ms.toFixed(0) : Math.round(ms)} ms`;
        text(status, { x: x + 92, y: top + 88, 'text-anchor': 'middle', 'font-size': 15, fill: token(!crashed && (isPaused || ms > 200) ? '--viz-warn' : '--viz-ink') }, live);
      });

      // Bottom line: what a crash would cost
      const best = Math.max(...followers.map((f) => f.received));
      const atRisk = Math.max(0, committed - best);
      const showLoss = promoted ? lost : atRisk;
      const tone = showLoss > 0 ? '--viz-bad' : '--viz-ok';
      svg('rect', { x: 2, y: 300, width: 396, height: 40, rx: 6, fill: token(`${tone}-soft`), stroke: token(tone), 'stroke-width': 1.5 }, live);
      const msg = promoted
        ? `Failover to ${promoted.name}: ${lost} saved order${lost === 1 ? '' : 's'} lost`
        : crashed ? 'Leader crashed: choosing a follower…' : `Crash now: ${atRisk} saved order${atRisk === 1 ? '' : 's'} lost`;
      text(msg, { x: 200, y: 326, 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700, fill: ink }, live);
    },

    stats() {
      const [a, b] = followers;
      return {
        'orders saved': committed,
        'commit wait (last 1 s)': waitText(),
        'A behind': `${leaderPos() - a.applied}`,
        'B behind': `${leaderPos() - b.applied}`,
        'lost in failover': promoted ? lost : '—',
      };
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Cut follower A off (5 s)',
        run() {
          if (crashedAt >= 0) return;
          followers[0].cutUntil = t + EVENT_MS;
          note('link to follower A cut for 5 s: nothing travels either way');
        },
      },
      {
        label: 'Long query on B (5 s)',
        run() {
          if (crashedAt >= 0) return;
          followers[1].pauseUntil = t + EVENT_MS;
          note('a long query on follower B pauses its replay for 5 s');
        },
      },
      {
        label: 'Crash the leader',
        run() {
          if (crashedAt >= 0) return;
          crashedAt = t;
          for (const f of followers) { f.inFlight = []; f.acks = []; } // its network went down with it
          note(`leader crashed with ${committed} orders saved; changes on the wire are lost`);
        },
      },
    ],
  };
};

/** A cylinder: the shape the site uses for anything that stores data. */
function cylinder(parent: SVGGElement, x: number, y: number, w: number, h: number, tone: string): void {
  const rx = w / 2;
  const ry = 7;
  const fill = token(`${tone}-soft` as `--viz-${string}`);
  const stroke = token(tone as `--viz-${string}`);
  svg('path', {
    d: `M${x} ${y + ry} L${x} ${y + h - ry} A${rx} ${ry} 0 0 0 ${x + w} ${y + h - ry} L${x + w} ${y + ry}`,
    fill, stroke, 'stroke-width': 1.5,
  }, parent);
  svg('ellipse', { cx: x + rx, cy: y + ry, rx, ry, fill, stroke, 'stroke-width': 1.5 }, parent);
}
