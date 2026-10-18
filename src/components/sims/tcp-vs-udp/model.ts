// One lossy link, three ways to carry a stream of small messages (think voice frames or game
// updates, 50 a second): TCP, QUIC with four independent streams, and plain UDP.
//
// config.mode picks the picture:
//   'tcp'      packets and ACKs crossing the link; a loss is repaired by retransmission, and every
//              packet behind the gap waits in the receiver's buffer (head-of-line blocking)
//   'udp'      the same traffic as datagrams; a loss is a hole, nothing ever waits
//   'compare'  TCP, QUIC and UDP on identical traffic and identical losses, as three bar charts
//
// Every lane sees exactly the same losses: whether a transmission is dropped is a seeded hash of
// (packet number, attempt), not a draw from a shared stream. Recovery follows real TCP and QUIC
// in outline: a loss is detected when three later packets have been acknowledged (fast
// retransmit, RFC 5681 and RFC 9002's packet threshold of 3), or by a timeout of RTT + 200 ms
// (Linux's minimum RTO) that doubles each time. Each bar is one packet's delay from being sent to
// reaching the application, against a 150 ms deadline (ITU-T G.114's limit for natural speech).
import { clamp, clear, layer, percent, svg, text, token } from '../../sim/svg';
import type { ParamSpec, Rng, SimFactory } from '../../sim/types';

type Mode = 'tcp' | 'udp' | 'compare';
type Lane = 'tcp' | 'quic' | 'udp';

interface Attempt {
  send: number; // ms of simulated time
  lost: boolean;
  how: 'first' | 'fast' | 'timeout';
}

interface Packet {
  n: number;
  sent: number;
  attempts: Attempt[];
  arrive: number; // reliable lanes: when the copy that got through reaches the receiver
  deliver: Record<Lane, number | null>; // when the application gets it; null = never (UDP loss)
}

const DEADLINE = 150; // ms
const STREAMS = 4; // QUIC lane: packet n travels on stream n % 4
const BARS = 40;
const Y_MAX = 400; // ms at the top of each chart
const LANES: Lane[] = ['tcp', 'quic', 'udp'];
const LANE_LABEL: Record<Lane, string> = { tcp: 'TCP', quic: 'QUIC, 4 streams', udp: 'UDP' };

const INK = token('--viz-ink');
const MUTED = token('--viz-muted');
const STROKE = token('--viz-stroke');
const OK = token('--viz-ok');
const WARN = token('--viz-warn');
const BAD = token('--viz-bad');
const FLOW = token('--viz-flow');

const PARAMS: ParamSpec[] = [
  { name: 'loss', label: 'Packet loss', min: 0, max: 15, step: 1, value: 4, unit: '%' },
  { name: 'rtt', label: 'Round-trip time', min: 40, max: 240, step: 10, value: 100, unit: 'ms' },
  { name: 'rate', label: 'Messages per second', min: 10, max: 50, step: 10, value: 50 },
];

export const createTransportModel: SimFactory = (config) => {
  const mode = (config.mode as Mode) ?? 'tcp';
  const single: Lane | null = mode === 'compare' ? null : mode;

  let p: Record<string, number> = {};
  let salt = 0;
  let t = 0; // simulated ms
  let scale = 0.1; // simulated ms per real ms
  let interval = 20;
  let oneWay = 50;
  let rto = 300;
  let packets: Packet[] = [];
  let nextN = 0;
  let forceNext = false;
  let lastDeliver: Record<'tcp', number> & { quic: number[] } = { tcp: 0, quic: [] };
  let counts: Record<Lane, { decided: number; late: number; lost: number; worst: number }>;
  let retransmissions = 0;
  let lastLog: string | null = null;

  function lossAt(n: number, attempt: number): boolean {
    // A small integer hash: the same packet and attempt are dropped in every lane.
    let h = (salt ^ Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(attempt + 7, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296 < p.loss / 100;
  }

  function createPacket(): void {
    const n = nextN++;
    const sent = n * interval;
    const attempts: Attempt[] = [{ send: sent, lost: forceNext || lossAt(n, 0), how: 'first' }];
    forceNext = false;
    while (attempts.at(-1)!.lost && attempts.length < 8) {
      const k = attempts.length; // the attempt we are about to make
      const prev = attempts.at(-1)!;
      // First loss: three later packets arrive, their duplicate ACKs come back, resend.
      const fast = sent + 3 * interval + 2 * oneWay;
      const timeout = prev.send + rto * 2 ** (k - 1);
      const useFast = k === 1 && fast < timeout;
      attempts.push({ send: useFast ? fast : timeout, lost: lossAt(n, k), how: useFast ? 'fast' : 'timeout' });
    }
    const arrive = attempts.at(-1)!.send + oneWay;
    const stream = n % STREAMS;
    const tcp = Math.max(arrive, lastDeliver.tcp);
    const quic = Math.max(arrive, lastDeliver.quic[stream] ?? 0);
    lastDeliver.tcp = tcp;
    lastDeliver.quic[stream] = quic;
    packets.push({ n, sent, attempts, arrive, deliver: { tcp, quic, udp: attempts[0].lost ? null : sent + oneWay } });
    retransmissions += attempts.length - 1;
  }

  /** Counts packets whose fate became known in (from, to]. */
  function settle(from: number, to: number): void {
    for (const pk of packets) {
      for (const lane of LANES) {
        const d = pk.deliver[lane];
        const known = d ?? pk.sent + oneWay; // a UDP loss is "known" when it would have arrived
        if (known <= from || known > to) continue;
        const c = counts[lane];
        c.decided++;
        if (d === null) c.lost++;
        else {
          const delay = d - pk.sent;
          if (delay > DEADLINE) c.late++;
          c.worst = Math.max(c.worst, delay);
        }
      }
    }
  }

  function logEvents(from: number, to: number): void {
    if (!single) return;
    for (const pk of packets) {
      const first = pk.attempts[0];
      const lostAt = first.send + oneWay / 2;
      if (first.lost && lostAt > from && lostAt <= to) {
        lastLog = single === 'udp'
          ? `#${pk.n} was lost on the way. The app never gets it; the packets behind it carry on.`
          : `#${pk.n} was lost on the way. Packets behind it will arrive and wait in the buffer.`;
      }
      if (single === 'tcp') {
        for (const a of pk.attempts.slice(1)) {
          if (a.send > from && a.send <= to) {
            lastLog = a.how === 'fast'
              ? `Three duplicate ACKs said "still missing #${pk.n}": the sender resends it.`
              : `No ACK for #${pk.n} before the timeout: the sender resends it and doubles the timer.`;
          }
        }
        const d = pk.deliver.tcp!;
        if (pk.attempts.length > 1 && d > from && d <= to) {
          const held = packets.filter((q) => q.n > pk.n && q.deliver.tcp === d).length;
          lastLog = `#${pk.n} arrived at last, ${Math.round(d - pk.sent)} ms after it was sent. ${held} packets that waited behind it go to the app at once.`;
        }
      }
    }
  }

  // ---------- drawing ----------

  function barColour(delay: number | null): string {
    if (delay === null) return BAD;
    return delay > DEADLINE ? WARN : OK;
  }

  /** One chart of the last BARS packets: bar height = delay to the app. */
  function drawChart(g: SVGGElement, lane: Lane, top: number, height: number, withAxis: boolean): void {
    const x0 = 34;
    const w = (396 - x0) / BARS;
    const base = top + height;
    const y = (ms: number) => base - (clamp(ms, 0, Y_MAX) / Y_MAX) * height;
    const lastN = nextN - 1;
    for (const pk of packets) {
      const i = pk.n - (lastN - BARS + 1);
      if (i < 0) continue;
      const x = x0 + i * w + 1;
      const d = pk.deliver[lane];
      const decided = (d ?? pk.sent + oneWay) <= t;
      if (!decided) {
        svg('circle', { cx: x + w / 2 - 1, cy: base - 3, r: 2, fill: MUTED }, g); // sent, not yet delivered
        continue;
      }
      if (d === null) {
        // Lost for good: a red cross under the axis, so it does not rely on colour alone.
        const cx = x + w / 2 - 1;
        svg('path', { d: `M${cx - 4} ${base + 4} l8 8 M${cx + 4} ${base + 4} l-8 8`, stroke: BAD, 'stroke-width': 2.5 }, g);
        continue;
      }
      const delay = d - pk.sent;
      svg('rect', { x, y: y(delay), width: w - 2, height: Math.max(1, base - y(delay)), rx: 1.5, fill: barColour(delay) }, g);
      if (delay > Y_MAX) svg('path', { d: `M${x} ${top + 5} l${(w - 2) / 2} -6 l${(w - 2) / 2} 6`, fill: WARN }, g);
    }
    if (withAxis) {
      svg('line', { x1: x0, y1: base, x2: 396, y2: base, stroke: STROKE, 'stroke-width': 1.5 }, g);
      const dy = y(DEADLINE);
      svg('line', { x1: x0, y1: dy, x2: 396, y2: dy, stroke: INK, 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, g);
      text('150', { x: x0 - 4, y: dy + 6, 'text-anchor': 'end', fill: INK, 'font-size': 16 }, g);
      text('0', { x: x0 - 4, y: base + 5, 'text-anchor': 'end', fill: MUTED, 'font-size': 16 }, g);
      if (height >= 100) text(String(Y_MAX), { x: x0 - 4, y: top + 12, 'text-anchor': 'end', fill: MUTED, 'font-size': 16 }, g);
    }
  }

  const CHART_TOP = 130;
  const CHART_H = 150;

  function renderSingle(view: SVGSVGElement, lane: Lane): void {
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      svg('rect', { x: 4, y: 8, width: 92, height: 50, rx: 14, fill: token('--viz-client-soft'), stroke: token('--viz-client'), 'stroke-width': 2 }, base);
      text('Sender', { x: 50, y: 40, 'text-anchor': 'middle', fill: INK, 'font-size': 19, 'font-weight': 700 }, base);
      svg('rect', { x: 304, y: 8, width: 92, height: 50, rx: 6, fill: token('--viz-server-soft'), stroke: token('--viz-server'), 'stroke-width': 2 }, base);
      text('Receiver', { x: 350, y: 40, 'text-anchor': 'middle', fill: INK, 'font-size': 19, 'font-weight': 700 }, base);
      svg('line', { x1: 96, y1: 22, x2: 304, y2: 22, stroke: STROKE, 'stroke-width': 1.5, 'stroke-dasharray': '3 5' }, base);
      if (lane === 'tcp') svg('line', { x1: 96, y1: 46, x2: 304, y2: 46, stroke: STROKE, 'stroke-width': 1.5, 'stroke-dasharray': '3 5' }, base);
      text('data', { x: 200, y: 15, 'text-anchor': 'middle', fill: MUTED, 'font-size': 15 }, base);
      if (lane === 'tcp') text('ACKs', { x: 200, y: 64, 'text-anchor': 'middle', fill: MUTED, 'font-size': 15 }, base);
      text('Delay from sender to app, last 40 messages (ms)', { x: 4, y: 116, fill: MUTED, 'font-size': 16 }, base);
      const deadlineY = CHART_TOP + CHART_H - (DEADLINE / Y_MAX) * CHART_H;
      text('deadline', { x: 396, y: deadlineY - 6, 'text-anchor': 'end', fill: INK, 'font-size': 15 }, base);
    }

    const live = layer(view, 'live');
    clear(live);
    const span = 208;
    const xAt = (sendTime: number) => 96 + ((t - sendTime) / oneWay) * span;
    for (const pk of packets) {
      for (const a of pk.attempts) {
        if (lane === 'udp' && a.how !== 'first') continue;
        const age = t - a.send;
        if (age < 0 || age > oneWay * 1.4) continue;
        if (a.lost) {
          if (age < oneWay / 2) svg('circle', { cx: xAt(a.send), cy: 22, r: 6, fill: a.how === 'first' ? FLOW : WARN }, live);
          else svg('path', { d: 'M193 15 l14 14 M207 15 l-14 14', stroke: BAD, 'stroke-width': 3, opacity: clamp(1.4 - age / oneWay, 0, 1) }, live);
        } else if (age <= oneWay) {
          svg('circle', { cx: xAt(a.send), cy: 22, r: 6, fill: a.how === 'first' ? FLOW : WARN }, live);
          if (a.how !== 'first') text(String(pk.n), { x: xAt(a.send), y: 9, 'text-anchor': 'middle', fill: WARN, 'font-size': 14, 'font-weight': 700 }, live);
        }
        // TCP: every arriving copy sends an ACK back.
        if (lane === 'tcp' && !a.lost) {
          const ackAge = age - oneWay;
          if (ackAge >= 0 && ackAge <= oneWay) svg('circle', { cx: 304 - (ackAge / oneWay) * span, cy: 46, r: 3.5, fill: MUTED }, live);
        }
      }
    }

    // What the receiver holds right now.
    let status: string;
    let colour = INK;
    if (lane === 'tcp') {
      const held = packets.filter((pk) => pk.arrive <= t && pk.deliver.tcp! > t);
      const missing = packets.find((pk) => pk.arrive > t && pk.attempts[0].send + oneWay <= t);
      if (held.length && missing) {
        status = `Buffer: ${held.length} held, waiting for #${missing.n}`;
        colour = WARN;
      } else status = 'Buffer empty: data goes straight to the app';
    } else status = 'No buffer: each datagram goes straight to the app';
    text(status, { x: 4, y: 90, fill: colour, 'font-size': 18, 'font-weight': 600 }, live);

    drawChart(live, lane, CHART_TOP, CHART_H, true);
  }

  function renderCompare(view: SVGSVGElement): void {
    const live = layer(view, 'live');
    clear(live);
    LANES.forEach((lane, i) => {
      const top = 6 + i * 120;
      const c = counts[lane];
      text(LANE_LABEL[lane], { x: 4, y: top + 16, fill: INK, 'font-size': 18, 'font-weight': 700 }, live);
      const bad = lane === 'udp' ? c.lost : c.late;
      const what = lane === 'udp' ? 'lost' : 'late';
      text(`${percent(bad, c.decided)} ${what}`, { x: 396, y: top + 16, 'text-anchor': 'end', fill: bad ? (lane === 'udp' ? BAD : WARN) : OK, 'font-size': 18, 'font-weight': 700 }, live);
      drawChart(live, lane, top + 26, 76, true);
    });
  }

  return {
    params: PARAMS,

    reset(params, rng: Rng) {
      p = params;
      salt = rng.int(0, 0x7fffffff);
      t = 0;
      interval = 1000 / p.rate;
      oneWay = p.rtt / 2;
      rto = p.rtt + 200;
      packets = [];
      nextN = 0;
      forceNext = false;
      lastDeliver = { tcp: 0, quic: [] };
      counts = { tcp: { decided: 0, late: 0, lost: 0, worst: 0 }, quic: { decided: 0, late: 0, lost: 0, worst: 0 }, udp: { decided: 0, late: 0, lost: 0, worst: 0 } };
      retransmissions = 0;
      lastLog = null;
      // Single lane: a packet takes about 0.5 s of real time to cross. Compare: a quicker pace.
      scale = single ? oneWay / 500 : 0.25;
    },

    step(dtMs) {
      const from = t;
      t += dtMs * scale;
      while (nextN * interval <= t) createPacket();
      settle(from, t);
      logEvents(from, t);
      // Forget packets that are long finished and off the chart.
      const keepFrom = nextN - BARS - 20;
      if (packets.length > BARS + 60) packets = packets.filter((pk) => pk.n >= keepFrom || (pk.deliver.tcp ?? 0) > t);
    },

    render(view) {
      if (single) renderSingle(view, single);
      else renderCompare(view);
    },

    stats() {
      if (!single) {
        return {
          'TCP late': percent(counts.tcp.late, counts.tcp.decided),
          'QUIC late': percent(counts.quic.late, counts.quic.decided),
          'UDP lost': percent(counts.udp.lost, counts.udp.decided),
          'worst TCP delay': `${Math.round(counts.tcp.worst)} ms`,
          'worst QUIC delay': `${Math.round(counts.quic.worst)} ms`,
        };
      }
      const c = counts[single];
      const onTime = c.decided - c.late - c.lost;
      const base: Record<string, string | number> = {
        messages: c.decided,
        'on time': onTime,
      };
      if (single === 'tcp') {
        base['late (over 150 ms)'] = c.late;
        base.retransmissions = retransmissions;
      } else base.lost = c.lost;
      base['worst delay'] = `${Math.round(c.worst)} ms`;
      return base;
    },

    log() {
      if (t === 0) return 'Press Play. Use "Lose the next packet" to cause a loss on demand.';
      return lastLog;
    },

    actions: [
      {
        label: 'Lose the next packet',
        run() {
          forceNext = true;
        },
      },
    ],
  };
};
