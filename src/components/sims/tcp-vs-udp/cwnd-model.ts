// One TCP connection sending the same response again and again, one round trip at a time.
//
// Each bar is one round trip: how many segments the sender put in flight, which is the congestion
// window (cwnd) unless the response ran out of data. The model follows Linux's defaults in
// outline:
//   - a new connection starts at 10 segments (RFC 6928) and doubles per round trip (slow start)
//   - any loss in a round is one congestion event: cwnd is cut to 70% (CUBIC's beta, RFC 9438)
//   - after that, cwnd follows CUBIC's curve W(t) = C(t - K)^3 + Wmax, or the Reno-friendly
//     estimate if that is larger, with C = 0.4 and t in seconds
//   - the bottleneck holds one bandwidth-delay product of queue; anything past that is dropped
//   - after an idle gap longer than the RTO, cwnd is halved once per RTO idle, down to 10
//     segments (Linux's tcp_slow_start_after_idle, on by default)
// Left out: timeouts (every loss is repaired by fast retransmit), HyStart, pacing, delayed ACKs.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { ParamSpec, Rng, SimFactory } from '../../sim/types';

export const MSS = 1460; // bytes of payload per segment
export const IW = 10; // initial window, segments
const BETA = 0.7;
const C = 0.4;
const ALPHA = (3 * (1 - BETA)) / (1 + BETA); // Reno-friendly growth per RTT, RFC 9438
const ROUND_TICKS_MS = 420; // shell time one round takes to draw
const GAP_TICKS_MS = 900; // shell time an idle gap takes to draw
const BARS = 30;

export interface Round {
  response: number;
  sent: number;
  lost: number;
  ms: number; // how long this round took
  cwndAfter: number;
}

export interface ResponseResult {
  response: number;
  ms: number;
  rounds: number;
  cwndAtStart: number;
  lost: number;
}

/** The connection, round by round. Pure logic with no drawing, so it can be tested in Node. */
export class Connection {
  p: Record<string, number>;
  rng: Rng;
  pipe: number; // bandwidth-delay product, segments
  queue: number; // bottleneck buffer, segments
  rto: number;
  cwnd = IW;
  ssthresh = Infinity;
  wMax = 0;
  wEst = 0;
  epoch = 0; // ms of simulated time at the last reduction
  clock = 0; // ms of simulated time
  response = 1;
  remaining: number;
  responseStart = 0;
  responseRounds = 0;
  responseLost = 0;
  cwndAtStart = IW;
  results: ResponseResult[] = [];
  rounds: Round[] = [];
  lastIdle: { from: number; to: number } | null = null;

  constructor(p: Record<string, number>, rng: Rng) {
    this.p = p;
    this.rng = rng;
    this.pipe = Math.max(1, Math.round((p.bandwidth * 1e6 * (p.rtt / 1000)) / 8 / MSS));
    this.queue = this.pipe;
    this.rto = p.rtt + 200; // Linux: srtt plus at least 200 ms
    this.remaining = this.segmentsPerResponse();
  }

  segmentsPerResponse(): number {
    return Math.ceil((this.p.size * 1000) / MSS);
  }

  /** Sends one round trip's worth. Returns true when this round finished the response. */
  round(): boolean {
    const window = Math.max(1, Math.floor(this.cwnd));
    const sent = Math.min(window, this.remaining);
    const overflow = Math.max(0, sent - (this.pipe + this.queue)); // tail drop at a full queue
    let lost = overflow;
    for (let i = 0; i < sent - overflow; i++) if (this.rng.chance(this.p.loss / 100)) lost++;
    this.remaining -= sent - lost;
    // The bottleneck needs `serialise` ms to pass this round's segments. A round lasts one RTT
    // (send, wait for the ACKs), or longer once the window is bigger than the pipe and a queue
    // forms. The last round only needs its serialisation time: the one-way trips at either end
    // of the response are counted once, as one RTT, in the response's total.
    const serialise = (Math.min(sent, this.pipe + this.queue) / this.pipe) * this.p.rtt;
    const ms = this.remaining > 0 ? Math.max(this.p.rtt, serialise) : serialise;
    this.clock += ms;
    this.responseRounds++;
    this.responseLost += lost;

    if (lost > 0) {
      this.wMax = this.cwnd;
      this.cwnd = Math.max(2, this.cwnd * BETA);
      this.ssthresh = this.cwnd;
      this.wEst = this.cwnd;
      this.epoch = this.clock;
    } else if (sent === window) {
      // Grow only when the window was the limit, as Linux does (an app-limited round proves nothing).
      if (this.cwnd < this.ssthresh) {
        this.cwnd = Math.min(this.cwnd * 2, this.ssthresh);
        if (this.cwnd >= this.ssthresh) {
          // Slow start ends without a loss: CUBIC starts a new epoch at the current window.
          this.wMax = this.cwnd;
          this.wEst = this.cwnd;
          this.epoch = this.clock;
        }
      } else {
        const t = (this.clock - this.epoch + this.p.rtt) / 1000;
        const k = Math.cbrt((this.wMax * (1 - BETA)) / C);
        const cubic = C * (t - k) ** 3 + this.wMax;
        this.wEst += ALPHA;
        const target = Math.max(cubic, this.wEst);
        this.cwnd = Math.min(Math.max(target, this.cwnd), this.cwnd * 1.5);
      }
    }
    this.rounds.push({ response: this.response, sent, lost, ms, cwndAfter: this.cwnd });
    if (this.rounds.length > BARS + 10) this.rounds.shift();

    if (this.remaining > 0) return false;
    this.results.push({
      response: this.response,
      ms: this.clock - this.responseStart + this.p.rtt, // plus the request's and the last byte's one-way trips
      rounds: this.responseRounds,
      cwndAtStart: this.cwndAtStart,
      lost: this.responseLost,
    });
    return true;
  }

  /** The application waits `gap` ms, then sends the next response on the same connection. */
  idle(): void {
    const before = this.cwnd;
    this.clock += this.p.gap;
    if (this.p.gap > this.rto) {
      // Linux tcp_cwnd_restart: halve once per RTO of idle, never below the initial window.
      let w = this.cwnd;
      for (let idle = this.p.gap; idle > this.rto && w > IW; idle -= this.rto) w /= 2;
      this.cwnd = Math.max(Math.min(IW, this.cwnd), w);
      // RFC 2861 / Linux: remember three quarters of the old window, so slow start climbs back fast.
      this.ssthresh = Math.max(this.ssthresh, before * 0.75);
    }
    this.lastIdle = { from: before, to: this.cwnd };
    this.response++;
    this.remaining = this.segmentsPerResponse();
    this.responseStart = this.clock;
    this.responseRounds = 0;
    this.responseLost = 0;
    this.cwndAtStart = this.cwnd;
  }

  /** Delivered Mbit/s over the last `n` rounds, idle time excluded. */
  recentMbps(n = 10): number {
    const recent = this.rounds.slice(-n);
    const ms = recent.reduce((t, r) => t + r.ms, 0);
    const bits = recent.reduce((b, r) => b + (r.sent - r.lost) * MSS * 8, 0);
    return ms ? bits / ms / 1000 : 0;
  }

  /** Time the link itself needs: one round trip plus the bytes at full bandwidth. */
  idealMs(): number {
    return this.p.rtt + (this.p.size * 1000 * 8) / (this.p.bandwidth * 1000);
  }
}

const PARAMS: ParamSpec[] = [
  { name: 'size', label: 'Response size', min: 50, max: 5000, step: 50, value: 1000, unit: 'KB' },
  { name: 'rtt', label: 'Round-trip time', min: 10, max: 300, step: 10, value: 100, unit: 'ms' },
  { name: 'bandwidth', label: 'Bottleneck bandwidth', min: 10, max: 1000, step: 10, value: 50, unit: 'Mbit/s' },
  { name: 'loss', label: 'Random packet loss', min: 0, max: 3, step: 0.1, value: 0, unit: '%' },
  { name: 'gap', label: 'Idle gap between responses', min: 0, max: 3000, step: 100, value: 0, unit: 'ms' },
];

const INK = token('--viz-ink');
const MUTED = token('--viz-muted');
const STROKE = token('--viz-stroke');

function fmtMs(ms: number): string {
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function rtts(n: number, word = 'RTT'): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function fmtSegs(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

export const createCwndModel: SimFactory = () => {
  let conn: Connection;
  let tick = 0; // shell ms into the current round or gap
  let phase: 'round' | 'gap' = 'round';
  let lastLog: string | null = null;

  function describe(r: ResponseResult): string {
    return `response ${r.response}: ${fmtMs(r.ms)} in ${rtts(r.rounds, 'round trip')}, starting from a window of ${fmtSegs(r.cwndAtStart)}`;
  }

  return {
    params: PARAMS,

    reset(params, rng) {
      conn = new Connection(params, rng);
      tick = 0;
      phase = 'round';
      lastLog = `A new connection: the window starts at ${IW} segments (${(IW * MSS) / 1000} KB). The pipe holds ${fmtSegs(conn.pipe)}.`;
    },

    step(dt) {
      tick += dt;
      if (phase === 'round' && tick >= ROUND_TICKS_MS) {
        tick = 0;
        const done = conn.round();
        const r = conn.rounds[conn.rounds.length - 1];
        if (r.lost > 0) lastLog = `${r.lost} of ${r.sent} segments lost: the window is cut to 70%, ${fmtSegs(r.cwndAfter)}.`;
        if (done) {
          lastLog = describe(conn.results[conn.results.length - 1]);
          phase = 'gap';
        }
      } else if (phase === 'gap' && tick >= GAP_TICKS_MS) {
        tick = 0;
        conn.idle();
        phase = 'round';
        const idle = conn.lastIdle!;
        if (idle.to < idle.from) lastLog = `Idle ${conn.p.gap} ms, longer than the ${conn.rto} ms RTO: the window falls from ${fmtSegs(idle.from)} to ${fmtSegs(idle.to)}.`;
      }
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const X0 = 52;
      const X1 = 396;
      const TOP = 70;
      const BASE = 226;
      const rounds = conn.rounds.slice(-BARS);
      const growing = phase === 'round' ? Math.min(1, tick / ROUND_TICKS_MS) : 1;
      const maxBar = Math.max(IW, ...rounds.map((r) => r.sent));
      // Scale to the bars, and to the pipe when it is in sight; a far-away pipe gets an arrow.
      const pipeInView = conn.pipe <= maxBar * 2.5;
      const yMax = pipeInView ? Math.max(maxBar, conn.pipe * 1.08) : maxBar * 1.08;
      const y = (segs: number) => BASE - (Math.min(segs, yMax) / yMax) * (BASE - TOP);
      const w = (X1 - X0) / BARS;

      // Header line: what the connection is doing now.
      const now = phase === 'gap' ? `idle ${conn.p.gap} ms` : `round trip ${conn.responseRounds + 1}`;
      text(`Response ${conn.response} · ${now}`, { x: 4, y: 22, fill: INK, 'font-size': 19, 'font-weight': 700 }, live);
      text(`window ${fmtSegs(conn.cwnd)} segments = ${((conn.cwnd * MSS) / 1000).toFixed(0)} KB`, { x: 4, y: 48, fill: MUTED, 'font-size': 17 }, live);

      // Axes and the pipe.
      svg('line', { x1: X0, y1: BASE, x2: X1, y2: BASE, stroke: STROKE, 'stroke-width': 1.5 }, live);
      text('0', { x: X0 - 6, y: BASE + 5, 'text-anchor': 'end', fill: MUTED, 'font-size': 16 }, live);
      text(fmtSegs(yMax), { x: X0 - 6, y: TOP + 5, 'text-anchor': 'end', fill: MUTED, 'font-size': 16 }, live);
      if (pipeInView) {
        const py = y(conn.pipe);
        svg('line', { x1: X0, y1: py, x2: X1, y2: py, stroke: INK, 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, live);
        text(`pipe ${fmtSegs(conn.pipe)}`, { x: X0 + 4, y: py - 6, fill: INK, 'font-size': 16 }, live);
      } else {
        text(`pipe ${fmtSegs(conn.pipe)} ↑ far above`, { x: X0 + 4, y: TOP - 4, fill: INK, 'font-size': 16 }, live);
      }

      let prevResponse = rounds[0]?.response;
      rounds.forEach((r, i) => {
        const x = X0 + i * w + 1;
        const last = i === rounds.length - 1;
        const scale = last ? growing : 1;
        const top = y(r.sent * scale);
        const lostTop = y(r.lost * scale);
        if (r.response !== prevResponse) {
          svg('line', { x1: x - 1, y1: TOP - 2, x2: x - 1, y2: BASE + 6, stroke: MUTED, 'stroke-width': 1.5, 'stroke-dasharray': '2 3' }, live);
          prevResponse = r.response;
        }
        const tone = r.response % 2 ? '--viz-flow' : '--viz-client';
        svg('rect', { x, y: top, width: w - 2, height: Math.max(1, BASE - top), rx: 1.5, fill: token(tone as `--viz-${string}`) }, live);
        if (r.lost > 0) {
          // Lost segments: the red part at the bottom of the bar, plus a cross above it.
          svg('rect', { x, y: lostTop, width: w - 2, height: Math.max(2, BASE - lostTop), fill: token('--viz-bad') }, live);
          const cx = x + w / 2 - 1;
          svg('path', { d: `M${cx - 4} ${top - 14} l8 8 M${cx + 4} ${top - 14} l-8 8`, stroke: token('--viz-bad'), 'stroke-width': 2.5 }, live);
        }
      });
      text('segments sent per round trip →', { x: X1, y: BASE + 24, 'text-anchor': 'end', fill: MUTED, 'font-size': 16 }, live);

      // The last finished response against what the link alone could do.
      const r = conn.results[conn.results.length - 1];
      if (r) {
        const ideal = conn.idealMs();
        text(`last: ${fmtMs(r.ms)} · the link alone: ${fmtMs(ideal)}`, { x: 4, y: 270, fill: r.ms > ideal * 1.5 ? token('--viz-warn') : token('--viz-ok'), 'font-size': 18, 'font-weight': 600 }, live);
      }
    },

    stats() {
      const first = conn.results[0];
      const last = conn.results[conn.results.length - 1];
      return {
        'first response': first ? `${fmtMs(first.ms)}, ${rtts(first.rounds)}` : '–',
        'latest response': last ? `${fmtMs(last.ms)}, ${rtts(last.rounds)}` : '–',
        'the link alone': fmtMs(conn.idealMs()),
        'throughput, last 10 RTTs': `${conn.recentMbps().toFixed(1)} of ${conn.p.bandwidth} Mbit/s`,
        'lost so far': conn.results.reduce((n, x) => n + x.lost, 0) + conn.responseLost,
      };
    },

    log: () => lastLog,
  };
};
