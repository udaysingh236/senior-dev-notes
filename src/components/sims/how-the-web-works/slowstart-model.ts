// One response downloaded over a fresh TCP connection, round by round.
//
// Each round the server may send `cwnd` packets (the congestion window). With no loss the window
// doubles every round (slow start); a round with a loss cuts it to 70% and ends slow start, after
// which it grows by one packet a round (CUBIC-like, simplified). Lost packets are resent in the
// next round. A round can never take less than one round trip, and never less than the time the
// link needs to put its packets on the wire, so bandwidth only matters once the window is big.
//
// The same loss pattern (one random number per packet sent, from the seeded RNG) is replayed for
// the "10x bandwidth" and "half the RTT" comparisons, so they differ only in the input changed.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

export const MSS = 1460; // bytes of payload per packet
const DRAWS = 20000;

export interface TransferInput {
  sizeKB: number; // response size, 1 KB = 1,000 bytes
  rtt: number; // ms
  mbps: number; // link bandwidth
  initcwnd: number; // packets in the first round
  loss: number; // percent of packets lost
}

export interface Round {
  start: number; // ms after the request was sent, when the server starts sending this round
  sent: number; // packets sent, including resends
  lost: number;
  cwnd: number;
}

export interface Transfer {
  rounds: Round[];
  done: number; // ms after the request was sent, when the last byte arrives
  packets: number;
}

/** Downloads `sizeKB` and returns every round. `u` holds one uniform draw per packet sent. */
export function transfer(input: TransferInput, u: readonly number[]): Transfer {
  const packets = Math.ceil((input.sizeKB * 1000) / MSS);
  const wireMs = (n: number) => (n * MSS * 8) / (input.mbps * 1000); // ms to serialise n packets
  const rounds: Round[] = [];
  let remaining = packets;
  let cwnd = input.initcwnd;
  let ssthresh = Infinity;
  let start = input.rtt / 2; // the request takes half a round trip to reach the server
  let draw = 0;
  let done = 0;

  while (remaining > 0 && rounds.length < 500) {
    const sent = Math.min(cwnd, remaining);
    let lost = 0;
    for (let i = 0; i < sent; i++) if (u[draw++ % u.length] < input.loss / 100) lost++;
    rounds.push({ start, sent, lost, cwnd });
    remaining -= sent - lost;
    done = start + wireMs(sent) + input.rtt / 2;
    // The next round starts when acknowledgements come back, or when the wire is free.
    start += Math.max(input.rtt, wireMs(sent));
    if (lost > 0) {
      cwnd = Math.max(2, Math.floor(cwnd * 0.7));
      ssthresh = cwnd;
    } else if (cwnd < ssthresh) {
      cwnd *= 2;
    } else {
      cwnd += 1;
    }
  }
  return { rounds, done, packets };
}

/** Bandwidth-delay product in packets: how many must be in flight to keep the link full. */
export function bdpPackets(rtt: number, mbps: number): number {
  return Math.round((mbps * 1000 * rtt) / (8 * MSS));
}

/** How long the transfer would take if only bandwidth mattered. */
export function naiveMs(sizeKB: number, mbps: number): number {
  return (sizeKB * 1000 * 8) / (mbps * 1000);
}

/** Simulated ms advanced per real ms: the transfer plays at a quarter of real speed. */
const SPEED = 0.25;
const HOLD = 2500;

export const createSlowStartModel: SimFactory = () => {
  let p: TransferInput = { sizeKB: 100, rtt: 150, mbps: 100, initcwnd: 10, loss: 0 };
  let u: number[] = [];
  let run: Transfer;
  let faster: Transfer;
  let nearer: Transfer;
  let clock = 0;
  let hold = 0;
  let lastEvent: string | null = null;
  let announced = 0;

  return {
    params: [
      { name: 'sizeKB', label: 'Response size', min: 10, max: 1000, step: 10, value: 100, unit: 'KB' },
      { name: 'rtt', label: 'Round-trip time', min: 10, max: 300, step: 10, value: 150, unit: 'ms' },
      { name: 'mbps', label: 'Link bandwidth', min: 5, max: 1000, step: 5, value: 100, unit: 'Mbit/s' },
      { name: 'initcwnd', label: 'Initial window', min: 1, max: 40, step: 1, value: 10, unit: 'packets' },
      { name: 'loss', label: 'Packet loss', min: 0, max: 5, step: 0.5, value: 0, unit: '%' },
    ],

    reset(params, rng: Rng) {
      p = params as unknown as TransferInput;
      u = Array.from({ length: DRAWS }, () => rng.next());
      run = transfer(p, u);
      faster = transfer({ ...p, mbps: p.mbps * 10 }, u);
      nearer = transfer({ ...p, rtt: p.rtt / 2 }, u);
      clock = 0;
      hold = 0;
      announced = 0;
      lastEvent = `${run.packets} packets to send; the link could carry ${bdpPackets(p.rtt, p.mbps)} per round trip.`;
    },

    step(dt) {
      if (clock < run.done) {
        clock = Math.min(run.done, clock + dt * SPEED);
        while (announced < run.rounds.length && run.rounds[announced].start <= clock) {
          const r = run.rounds[announced];
          announced++;
          lastEvent = `round ${announced}: ${r.sent} packets${r.lost ? `, ${r.lost} lost, window cut to ${Math.max(2, Math.floor(r.cwnd * 0.7))}` : ''}`;
        }
        if (clock >= run.done) lastEvent = `last byte after ${formatMs(run.done)}: ${run.rounds.length} rounds`;
        return;
      }
      hold += dt;
      if (hold > HOLD) {
        clock = 0;
        hold = 0;
        announced = 0;
      }
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const INK = token('--viz-ink');
      const MUTED = token('--viz-muted');

      // Top: packets sent in each round, against the number that would fill the link.
      const top = 30;
      const height = 120;
      const x0 = 8;
      const width = 384;
      const bdp = bdpPackets(p.rtt, p.mbps);
      const tallest = Math.max(...run.rounds.map((r) => r.sent), 1);
      const scaleMax = bdp <= tallest * 2.5 ? Math.max(tallest, bdp) * 1.1 : tallest * 1.15;
      const shown = run.rounds.slice(0, 40);
      const slot = width / Math.max(shown.length, 6);
      const barW = Math.max(3, Math.min(40, slot - 4));
      text('packets sent in each round trip', { x: x0, y: 20, 'font-size': 19, 'font-weight': 700, fill: INK }, live);
      svg('line', { x1: x0, y1: top + height, x2: x0 + width, y2: top + height, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, live);
      shown.forEach((r, i) => {
        if (r.start > clock) return;
        const h = (r.sent / scaleMax) * height;
        const lostH = (r.lost / scaleMax) * height;
        const x = x0 + i * slot + (slot - barW) / 2;
        svg('rect', { x, y: top + height - h, width: barW, height: h, rx: 2, fill: token('--viz-flow-soft'), stroke: token('--viz-flow'), 'stroke-width': 1.5 }, live);
        if (r.lost) svg('rect', { x, y: top + height - h, width: barW, height: Math.max(3, lostH), fill: token('--viz-bad'), stroke: 'none' }, live);
        if (shown.length <= 12) text(r.sent, { x: x + barW / 2, y: top + height - h - 4, 'font-size': 15, 'text-anchor': 'middle', fill: MUTED }, live);
      });
      if (bdp <= scaleMax) {
        const y = top + height - (bdp / scaleMax) * height;
        svg('line', { x1: x0, y1: y, x2: x0 + width, y2: y, stroke: token('--viz-ok'), 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }, live);
        text(`link full: ${bdp}`, { x: x0 + width, y: y - 5, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-ok') }, live);
      } else {
        text(`link full: ${bdp} (off chart)`, { x: x0 + width, y: top + 14, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-ok') }, live);
      }

      // Bottom: the same download with one input changed.
      const rows: [string, Transfer][] = [
        ['this link', run],
        ['10× bandwidth', faster],
        ['half the RTT', nearer],
      ];
      const longest = Math.max(run.done, faster.done, nearer.done);
      const bx = 132;
      const bw = 400 - bx - 76;
      rows.forEach(([label, t], i) => {
        const y = 182 + i * 26;
        text(label, { x: x0, y: y + 15, 'font-size': 17, fill: INK }, live);
        const progress = i === 0 ? Math.min(clock, t.done) : t.done;
        svg('rect', { x: bx, y, width: bw, height: 18, rx: 3, fill: 'none', stroke: token('--viz-stroke'), 'stroke-width': 1 }, live);
        svg('rect', { x: bx, y, width: Math.max(2, (progress / longest) * bw), height: 18, rx: 3, fill: token(i === 0 ? '--viz-flow-soft' : '--viz-ok-soft'), stroke: token(i === 0 ? '--viz-flow' : '--viz-ok'), 'stroke-width': 1.5 }, live);
        text(formatMs(t.done), { x: 396, y: y + 15, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'end', fill: INK }, live);
      });
    },

    stats() {
      const lost = run.rounds.reduce((n, r) => n + r.lost, 0);
      return {
        'round trips of data': run.rounds.length,
        'last byte after': formatMs(run.done),
        'if only bandwidth mattered': formatMs(naiveMs(p.sizeKB, p.mbps)),
        'packets lost': lost,
      };
    },

    log: () => lastEvent,
  };
};
