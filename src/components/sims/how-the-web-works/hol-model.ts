// Many files over a lossy link, three ways, on the same loss pattern:
//   HTTP/1.1  six TCP connections, one file at a time on each; a new request after each response
//   HTTP/2    one TCP connection carrying every file at once, interleaved packet by packet
//   HTTP/3    one QUIC connection carrying every file at once, interleaved packet by packet
//
// Every connection is already open, so only the transfer is compared. Each connection has its own
// congestion window, sends one window per round trip, doubles it while nothing is lost, and cuts
// it to 70% after a round with a loss (then grows by one packet a round). A lost packet is resent
// in the next round. The difference is delivery: TCP hands bytes to the browser strictly in order,
// so a hole stalls every file behind it; QUIC orders bytes per stream, so a hole stalls one file.
// Bandwidth is assumed plentiful, as on most page loads (see the slow-start sim).
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';
import { MSS } from './slowstart-model';

export type Proto = 'h1' | 'h2' | 'h3';
const INITCWND = 10;
const H1_CONNECTIONS = 6;
const DRAWS = 40000;

export interface HolInput {
  files: number;
  sizeKB: number;
  rtt: number;
  loss: number; // percent
}

export interface FileResult {
  arrived: number[]; // per packet of this file: when it reached the client
  delivered: number[]; // per packet: when the browser could use it
  done: number; // when the whole file was usable
}

export interface LaneResult {
  files: FileResult[];
  last: number;
  mean: number;
}

/** A congestion-controlled sender: one window per round trip. */
class Window {
  cwnd = INITCWND;
  ssthresh = Infinity;
  update(lost: boolean): void {
    if (lost) {
      this.cwnd = Math.max(2, Math.floor(this.cwnd * 0.7));
      this.ssthresh = this.cwnd;
    } else if (this.cwnd < this.ssthresh) this.cwnd *= 2;
    else this.cwnd += 1;
  }
}

class Draws {
  i = 0;
  u: readonly number[];
  loss: number;
  constructor(u: readonly number[], loss: number) {
    this.u = u;
    this.loss = loss / 100;
  }
  lost(): boolean {
    return this.u[this.i++ % this.u.length] < this.loss;
  }
}

function packetsPerFile(sizeKB: number): number {
  return Math.ceil((sizeKB * 1000) / MSS);
}

/**
 * One connection sending a sequence of packets (each tagged with its file) starting at `t0`
 * (when the request reaches the server). Returns when each packet arrived at the client.
 */
function sendAll(seq: number[], t0: number, rtt: number, win: Window, draws: Draws): number[] {
  const arrival = new Array<number>(seq.length).fill(Infinity);
  let pending = seq.map((_, i) => i); // packet indexes still to (re)send, resends first
  let start = t0;
  while (pending.length) {
    const batch = pending.slice(0, win.cwnd);
    const rest = pending.slice(win.cwnd);
    const lostNow: number[] = [];
    batch.forEach((k, j) => {
      // Senders pace a window out over about half a round trip rather than in one burst.
      if (draws.lost()) lostNow.push(k);
      else arrival[k] = start + rtt / 2 + (j / batch.length) * (rtt / 2);
    });
    win.update(lostNow.length > 0);
    pending = [...lostNow, ...rest];
    start += rtt;
  }
  return arrival;
}

export function runLane(proto: Proto, input: HolInput, u: readonly number[]): LaneResult {
  const per = packetsPerFile(input.sizeKB);
  const draws = new Draws(u, input.loss);
  const files: FileResult[] = Array.from({ length: input.files }, () => ({ arrived: [], delivered: [], done: 0 }));

  if (proto === 'h1') {
    // Six connections; each takes the next waiting file when its last response is complete.
    const conns = Array.from({ length: H1_CONNECTIONS }, () => ({ win: new Window(), free: 0 }));
    for (let f = 0; f < input.files; f++) {
      const c = conns.reduce((a, b) => (b.free < a.free ? b : a));
      const arrival = sendAll(new Array(per).fill(f), c.free + input.rtt / 2, input.rtt, c.win, draws);
      // Within one file on one connection, TCP order and file order are the same thing.
      let upTo = 0;
      files[f].arrived = arrival;
      files[f].delivered = arrival.map((a) => (upTo = Math.max(upTo, a)));
      files[f].done = upTo;
      c.free = upTo; // the browser sends the next request when this response is complete
    }
  } else {
    // One connection; files sent one after another in priority order, as Chrome schedules them.
    const seq: number[] = [];
    for (let f = 0; f < input.files; f++) for (let k = 0; k < per; k++) seq.push(f);
    const arrival = sendAll(seq, input.rtt / 2, input.rtt, new Window(), draws);
    let upTo = 0;
    seq.forEach((f, i) => {
      upTo = Math.max(upTo, arrival[i]);
      files[f].arrived.push(arrival[i]);
      // TCP: usable only once every earlier byte on the connection has arrived.
      // QUIC: usable once every earlier byte of the same stream has arrived.
      const ownUpTo = Math.max(arrival[i], files[f].delivered.at(-1) ?? 0);
      files[f].delivered.push(proto === 'h2' ? upTo : ownUpTo);
    });
    for (const file of files) file.done = Math.max(...file.delivered);
  }

  const dones = files.map((f) => f.done);
  return { files, last: Math.max(...dones), mean: dones.reduce((a, b) => a + b, 0) / dones.length };
}

const LANES: { id: Proto; title: string }[] = [
  { id: 'h1', title: 'HTTP/1.1: six TCP connections' },
  { id: 'h2', title: 'HTTP/2: one TCP connection' },
  { id: 'h3', title: 'HTTP/3: one QUIC connection' },
];
const SPEED = 0.25;
const HOLD = 2500;

export const createHolModel: SimFactory = () => {
  let p: HolInput = { files: 12, sizeKB: 30, rtt: 100, loss: 2 };
  let lanes: LaneResult[] = [];
  let clock = 0;
  let hold = 0;
  let end = 0;
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'loss', label: 'Packet loss', min: 0, max: 8, step: 0.5, value: 2, unit: '%' },
      { name: 'files', label: 'Files on the page', min: 2, max: 24, step: 1, value: 12 },
      { name: 'sizeKB', label: 'Size of each file', min: 5, max: 100, step: 5, value: 30, unit: 'KB' },
      { name: 'rtt', label: 'Round-trip time', min: 20, max: 300, step: 10, value: 100, unit: 'ms' },
    ],

    reset(params, rng: Rng) {
      p = params as unknown as HolInput;
      const u = Array.from({ length: DRAWS }, () => rng.next());
      lanes = LANES.map((l) => runLane(l.id, p, u));
      end = Math.max(...lanes.map((l) => l.last));
      clock = 0;
      hold = 0;
      lastEvent = `${p.files} files of ${p.sizeKB} KB; every connection already open. Amber: bytes that arrived but wait behind a lost packet.`;
    },

    step(dt) {
      if (clock < end) {
        clock = Math.min(end, clock + dt * SPEED);
        if (clock >= end) {
          lastEvent = LANES.map((l, i) => `${l.id === 'h1' ? 'HTTP/1.1' : l.id === 'h2' ? 'HTTP/2' : 'HTTP/3'} ${formatMs(lanes[i].last)}`).join(' · ');
        }
        return;
      }
      hold += dt;
      if (hold > HOLD) {
        clock = 0;
        hold = 0;
      }
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const laneH = 92;
      const n = p.files;
      const gap = n > 16 ? 2 : 4;
      const w = (392 - gap * (n - 1)) / n;
      lanes.forEach((lane, li) => {
        const top = li * laneH + 8;
        text(LANES[li].title, { x: 4, y: top + 16, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, live);
        const cellTop = top + 26;
        const cellH = 44;
        lane.files.forEach((f, k) => {
          const x = 4 + k * (w + gap);
          const total = f.arrived.length;
          const arrived = f.arrived.filter((a) => a <= clock).length;
          const usable = f.delivered.filter((d) => d <= clock).length;
          const done = f.done <= clock;
          svg('rect', { x, y: cellTop, width: w, height: cellH, rx: 3, fill: 'none', stroke: token('--viz-stroke'), 'stroke-width': 1.2 }, live);
          const usableH = (usable / total) * cellH;
          const waitingH = ((arrived - usable) / total) * cellH;
          if (waitingH > 0) {
            svg('rect', { x, y: cellTop + cellH - usableH - waitingH, width: w, height: waitingH, fill: token('--viz-warn-soft'), stroke: token('--viz-warn'), 'stroke-width': 1.2 }, live);
          }
          if (usableH > 0) {
            const tone = done ? 'ok' : 'flow';
            svg('rect', { x, y: cellTop + cellH - usableH, width: w, height: usableH, rx: 2, fill: token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.2 }, live);
          }
        });
        const finished = lane.files.filter((f) => f.done <= clock).length;
        text(`${finished}/${n} done`, { x: 4, y: cellTop + cellH + 18, 'font-size': 15, fill: token('--viz-muted') }, live);
        if (clock >= lane.last) {
          text(`all done ${formatMs(lane.last)}`, { x: 396, y: cellTop + cellH + 18, 'font-size': 15, 'font-weight': 700, 'text-anchor': 'end', fill: token('--viz-ink') }, live);
        }
      });
      text(`t = ${formatMs(clock)}`, { x: 396, y: 24, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-muted') }, live);
    },

    stats() {
      const names: Record<Proto, string> = { h1: 'HTTP/1.1', h2: 'HTTP/2', h3: 'HTTP/3' };
      const out: Record<string, string> = {};
      lanes.forEach((l, i) => {
        out[`${names[LANES[i].id]} all files`] = formatMs(l.last);
        out[`${names[LANES[i].id]} average file`] = formatMs(l.mean);
      });
      return out;
    },

    log: () => lastEvent,
  };
};
