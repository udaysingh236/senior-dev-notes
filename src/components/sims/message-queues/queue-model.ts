// A queue in front of email workers. Orders arrive at random (Poisson) and each puts one message
// in the queue. Idle workers receive the message at the front: its receive count goes up and it
// is hidden for the lease. A normal send takes about 0.5 s; then the worker acks, and the ack
// deletes the message only if the worker's lease is still the current one. A lease that runs out
// puts the message back at the front, even if a worker is still sending it.
//
// Buttons: a sale (3x orders for 15 s), a slow provider (8 s per email for 15 s), a worker crash
// right after sending (before the ack), and a poison message that crashes every worker that takes
// it. A message whose receive count has reached the limit goes to the dead-letter queue on its
// next receive. With the idempotent consumer on, a worker that gets an already-emailed order acks
// without sending.
//
// What the reader controls: arrival rate, workers, lease, receive limit, idempotency.
// What they watch: the backlog and its age, workers whose lease ran out, duplicates, dead letters.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const TICK = 5; // ms
const NORMAL_MEDIAN_MS = 470;
const SIGMA = 0.3; // normal sends: median 0.47 s, average about 0.5 s
const SLOW_MS = 8000;
const POISON_CRASH_MS = 300;
const RESTART_MS = 1000;
const EVENT_S = 15; // how long the sale and the slow provider last
const HISTORY_MS = 30000;
const SAMPLE_MS = 250;
const MAX_WORKERS = 20;

interface Message {
  id: number;
  arrivedAt: number;
  receives: number;
  receipt: number; // receipt of the current lease, 0 when waiting
  leaseEnd: number;
  poison: boolean;
  emailed: boolean;
}

interface Worker {
  msg: Message | null;
  receipt: number;
  ends: number;
  crashAfterSend: boolean;
  restartAt: number; // > t while the worker is restarting
}

function normal(rng: Rng): number {
  const u = Math.max(rng.next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

export const createQueueModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let t = 0;
  let nextArrival = 0;
  let nextId = 1;
  let nextReceipt = 1;
  let waiting: Message[] = [];
  let inFlight: Message[] = [];
  let workers: Worker[] = [];
  let dead: Message[] = [];
  let saleUntil = -1;
  let slowUntil = -1;
  let crashNext = false;
  let sent = 0;
  let duplicates = 0;
  let skipped = 0;
  let history: number[] = [];
  let nextSample = 0;
  let lastEvent: string | null = null;

  const note = (msg: string) => (lastEvent = `t=${(t / 1000).toFixed(1)}s ${msg}`);
  const rateNow = () => p.rate * (t < saleUntil ? 3 : 1);
  const slow = () => t < slowUntil;

  function arrive(poison = false): void {
    waiting.push({ id: nextId++, arrivedAt: t, receives: 0, receipt: 0, leaseEnd: 0, poison, emailed: false });
  }

  function expireLeases(): void {
    for (let i = inFlight.length - 1; i >= 0; i--) {
      const m = inFlight[i];
      if (t >= m.leaseEnd) {
        inFlight.splice(i, 1);
        m.receipt = 0;
        waiting.unshift(m); // back to the front
        if (m.poison) note(`poison message #${m.id}: lease over, back in the queue (received ${m.receives} times)`);
        else note(`#${m.id}: lease over before an ack, back in the queue`);
      }
    }
  }

  function receive(): Message | null {
    while (waiting.length) {
      const m = waiting.shift()!;
      if (m.receives >= p.maxReceives) {
        dead.push(m);
        note(`#${m.id}${m.poison ? ' (poison)' : ''} received ${m.receives} times: moved to the dead-letter queue`);
        continue;
      }
      m.receives++;
      m.receipt = nextReceipt++;
      m.leaseEnd = t + p.lease * 1000;
      inFlight.push(m);
      return m;
    }
    return null;
  }

  function finish(w: Worker): void {
    const m = w.msg!;
    if (m.poison) {
      note(`poison message #${m.id}: worker crashed (attempt ${m.receives}), no ack`);
      w.restartAt = t + RESTART_MS;
      w.msg = null;
      return;
    }
    if (p.idempotent === 1 && m.emailed) {
      skipped++;
    } else {
      sent++;
      if (m.emailed) {
        duplicates++;
        note(`#${m.id}: emailed a second time (receive ${m.receives})`);
      }
      m.emailed = true;
    }
    if (w.crashAfterSend) {
      note(`worker crashed after emailing #${m.id}, before its ack`);
      w.restartAt = t + RESTART_MS;
      w.msg = null;
      return;
    }
    if (m.receipt === w.receipt) {
      inFlight.splice(inFlight.indexOf(m), 1); // ack: delete for good
      m.receipt = -1;
    } else if (m.receipt !== -1) {
      note(`#${m.id}: late ack refused, the lease had run out`);
    } // receipt -1: another worker already acked and deleted it
    w.msg = null;
  }

  function advance(): void {
    t += TICK;
    while (nextArrival <= t) {
      arrive();
      nextArrival += rng.exponential(1000 / rateNow());
    }
    expireLeases();
    for (const w of workers) {
      if (w.msg && t >= w.ends) finish(w);
      if (!w.msg && t >= w.restartAt) {
        const m = receive();
        if (m) {
          const send = slow() ? SLOW_MS : Math.min(2000, NORMAL_MEDIAN_MS * Math.exp(SIGMA * normal(rng)));
          w.msg = m;
          w.receipt = m.receipt;
          w.ends = t + (m.poison ? POISON_CRASH_MS : send);
          w.crashAfterSend = false;
          if (crashNext && !m.poison) {
            w.crashAfterSend = true;
            crashNext = false;
          }
        }
      }
    }
    if (t >= nextSample) {
      history.push(waiting.length);
      if (history.length > HISTORY_MS / SAMPLE_MS) history.shift();
      nextSample += SAMPLE_MS;
    }
  }

  return {
    params: [
      { name: 'rate', label: 'Orders per second', min: 2, max: 40, step: 1, value: 12 },
      { name: 'workers', label: 'Email workers (2 emails/s each)', min: 1, max: MAX_WORKERS, step: 1, value: 10 },
      { name: 'lease', label: 'Lease (visibility timeout)', min: 1, max: 20, step: 1, value: 5, unit: 's' },
      { name: 'maxReceives', label: 'Dead-letter after this many receives', min: 1, max: 10, step: 1, value: 5 },
      { name: 'idempotent', label: 'Idempotent consumer', min: 0, max: 1, step: 1, value: 0, format: (v) => (v ? 'on' : 'off') },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      t = 0;
      nextId = 1;
      nextReceipt = 1;
      waiting = [];
      inFlight = [];
      dead = [];
      workers = Array.from({ length: p.workers }, () => ({ msg: null, receipt: 0, ends: 0, crashAfterSend: false, restartAt: 0 }));
      saleUntil = -1;
      slowUntil = -1;
      crashNext = false;
      sent = 0;
      duplicates = 0;
      skipped = 0;
      history = [];
      nextSample = 0;
      nextArrival = rng.exponential(1000 / rateNow());
      lastEvent = `${p.workers} workers can send ${p.workers * 2} emails/s; ${p.rate} orders/s arrive.`;
    },

    step(dt) {
      const end = t + dt;
      while (t < end) advance();
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const bold = { 'font-size': 17, 'font-weight': 700, fill: token('--viz-ink') };
      const small = { 'font-size': 15, fill: token('--viz-muted') };

      // Row 1: orders -> queue -> dead letters
      const sale = t < saleUntil;
      svg('rect', { x: 2, y: 6, width: 86, height: 52, rx: 6, fill: token(sale ? '--viz-warn-soft' : '--viz-client-soft'), stroke: token(sale ? '--viz-warn' : '--viz-client'), 'stroke-width': 1.5 }, live);
      text('Orders', { x: 45, y: 28, 'text-anchor': 'middle', ...bold }, live);
      text(`${Math.round(rateNow())}/s`, { x: 45, y: 49, 'text-anchor': 'middle', 'font-size': 15, fill: token(sale ? '--viz-warn' : '--viz-muted') }, live);

      const qx = 98;
      const qw = 210;
      const cells = 15;
      const cw = qw / cells;
      svg('rect', { x: qx, y: 10, width: qw, height: 30, rx: 4, fill: token('--viz-surface'), stroke: token('--viz-server'), 'stroke-width': 1.5 }, live);
      const shown = Math.min(waiting.length, cells);
      for (let i = 0; i < shown; i++) {
        const m = waiting[i];
        const tone = m.poison ? '--viz-bad' : m.receives > 0 ? '--viz-warn' : '--viz-flow';
        svg('rect', { x: qx + 2 + i * cw, y: 13, width: cw - 3, height: 24, rx: 2, fill: token(tone) }, live);
      }
      if (waiting.length > cells) text('+', { x: qx + qw - 8, y: 31, 'text-anchor': 'middle', ...bold }, live);
      const oldest = waiting.length ? (t - waiting[0].arrivedAt) / 1000 : 0;
      text(`${waiting.length} waiting · oldest ${oldest.toFixed(1)} s`, { x: qx, y: 58, ...small }, live);

      svg('rect', { x: 316, y: 6, width: 82, height: 52, rx: 6, fill: token(dead.length ? '--viz-bad-soft' : '--viz-surface'), stroke: token(dead.length ? '--viz-bad' : '--viz-stroke'), 'stroke-width': 1.5 }, live);
      text('Dead', { x: 357, y: 28, 'text-anchor': 'middle', ...bold }, live);
      text(`${dead.length}`, { x: 357, y: 49, 'text-anchor': 'middle', 'font-size': 15, fill: token(dead.length ? '--viz-bad' : '--viz-muted') }, live);

      // Row 2: workers
      text('Workers', { x: 2, y: 86, ...bold }, live);
      text('blue: sending · amber: lease ran out · red: crashed', { x: 2, y: 106, 'font-size': 14, fill: token('--viz-muted') }, live);
      const perRow = 10;
      const wcw = 39;
      workers.forEach((w, i) => {
        const x = 2 + (i % perRow) * wcw;
        const y = 116 + Math.floor(i / perRow) * 36;
        let fill = token('--viz-surface');
        let stroke = token('--viz-stroke');
        let dash: string | undefined;
        if (t < w.restartAt) {
          fill = token('--viz-bad-soft');
          stroke = token('--viz-bad');
        } else if (w.msg) {
          const expired = w.msg.receipt !== w.receipt;
          fill = token(expired ? '--viz-warn-soft' : '--viz-flow-soft');
          stroke = token(expired ? '--viz-warn' : '--viz-flow');
          if (expired) dash = '4 3';
        }
        svg('rect', { x, y, width: wcw - 5, height: 30, rx: 4, fill, stroke, 'stroke-width': 1.5, 'stroke-dasharray': dash }, live);
      });

      // Row 3: provider
      const py = 196;
      const s = slow();
      svg('rect', { x: 2, y: py, width: 396, height: 40, rx: 6, fill: token(s ? '--viz-warn-soft' : '--viz-server-soft'), stroke: token(s ? '--viz-warn' : '--viz-server'), 'stroke-width': 1.5 }, live);
      text(s ? 'Email provider: slow, 8 s each' : 'Email provider: 0.5 s each', { x: 12, y: py + 26, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, live);
      text(`dupes ${duplicates}`, { x: 388, y: py + 26, 'text-anchor': 'end', 'font-size': 16, 'font-weight': 700, fill: token(duplicates ? '--viz-bad' : '--viz-muted') }, live);

      // Row 4: backlog over the last 30 s
      const gy = 252;
      const gh = 56;
      const max = Math.max(20, ...history);
      text(`waiting, last 30 s (top = ${max})`, { x: 2, y: gy + 2, 'font-size': 14, fill: token('--viz-muted') }, live);
      svg('line', { x1: 2, y1: gy + 8 + gh, x2: 398, y2: gy + 8 + gh, stroke: token('--viz-stroke'), 'stroke-width': 1 }, live);
      if (history.length > 1) {
        const n = HISTORY_MS / SAMPLE_MS;
        const pts = history
          .map((v, i) => `${(2 + (396 * (i + n - history.length)) / (n - 1)).toFixed(1)},${(gy + 8 + gh - (gh * v) / max).toFixed(1)}`)
          .join(' ');
        svg('polyline', { points: pts, fill: 'none', stroke: token('--viz-flow'), 'stroke-width': 2 }, live);
      }
    },

    stats() {
      const oldest = waiting.length ? (t - waiting[0].arrivedAt) / 1000 : 0;
      return {
        Waiting: waiting.length,
        'Oldest waiting': `${oldest.toFixed(1)} s`,
        'In flight': inFlight.length,
        'Emails sent': sent,
        'Duplicate emails': duplicates,
        'Duplicates skipped': skipped,
        'Dead letters': dead.length,
      };
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Sale: 3× orders for 15 s',
        run() {
          saleUntil = t + EVENT_S * 1000;
          nextArrival = Math.min(nextArrival, t + rng.exponential(1000 / rateNow()));
          note(`sale starts: ${Math.round(rateNow())} orders/s for ${EVENT_S} s`);
        },
      },
      {
        label: 'Provider slows to 8 s per email',
        run() {
          slowUntil = t + EVENT_S * 1000;
          note(`email provider slows to 8 s per email for ${EVENT_S} s`);
        },
      },
      {
        label: 'Crash a worker after it sends',
        run() {
          crashNext = true;
          note('the next worker to take a message will crash after sending, before its ack');
        },
      },
      {
        label: 'Add a poison message',
        run() {
          arrive(true);
          note(`poison message #${nextId - 1} added: it crashes every worker that takes it`);
        },
      },
    ],
  };
};
