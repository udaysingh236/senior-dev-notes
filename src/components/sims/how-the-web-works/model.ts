// Round trips to the first byte: a browser loading a page from a distant server, packet by packet.
//
// config.protocol picks the mode:
//   'tls12' | 'tls13' | 'quic'  one connection set-up, drawn as packets on a wire plus a waterfall
//   'compare'                   TLS 1.2, TLS 1.3, HTTP/3 (QUIC) and a reused connection, side by side
//
// Every message takes half a round trip each way, so the picture is exact arithmetic, not a
// random process. The model plays in slow motion (SLOW) so a 600 ms page load can be followed.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { ParamSpec, SimFactory } from '../../sim/types';

export type Protocol = 'tls12' | 'tls13' | 'quic' | 'reused';
type Mode = Exclude<Protocol, 'reused'> | 'compare';
type Phase = 'dns' | 'tcp' | 'tls' | 'quic' | 'request';
type End = 'browser' | 'server' | 'resolver';

interface Message {
  from: End;
  to: End;
  label: string;
  depart: number; // simulated ms
  arrive: number;
  final?: boolean; // the response carrying the first byte
}

interface Plan {
  messages: Message[];
  phases: { phase: Phase; label: string; start: number; end: number }[];
  events: { at: number; text: string }[];
  serverBusy: [number, number]; // when the server is working on the request
  firstByte: number;
  roundTrips: number; // round trips to the server before the first byte
}

/** One wall-clock second plays this many simulated milliseconds. */
const SLOW = 200;
/** Hold the finished picture this long (simulated ms) before replaying. */
const HOLD = 700;

const INK = token('--viz-ink');
const MUTED = token('--viz-muted');
const STROKE = token('--viz-stroke');

const PHASE_COLOUR: Record<Phase, string> = {
  dns: token('--viz-store'),
  tcp: token('--viz-flow'),
  tls: token('--viz-client'),
  quic: token('--viz-flow'), // drawn as two stripes: connect and secure in one round trip
  request: token('--viz-warn'),
};

const ROW_LABEL: Record<Protocol, string> = {
  tls12: 'TLS 1.2',
  tls13: 'TLS 1.3',
  quic: 'HTTP/3',
  reused: 'Reused',
};

/** Works out every message and phase for one page request. All times in ms. */
export function plan(protocol: Protocol, rtt: number, dns: number, server: number): Plan {
  const half = rtt / 2;
  const messages: Message[] = [];
  const phases: Plan['phases'] = [];
  const events: Plan['events'] = [];
  let t = 0;
  let roundTrips = 0;

  // A request from the browser and its reply: one round trip.
  const exchange = (ask: string, reply: string, note: string) => {
    messages.push({ from: 'browser', to: 'server', label: ask, depart: t, arrive: t + half });
    messages.push({ from: 'server', to: 'browser', label: reply, depart: t + half, arrive: t + rtt });
    t += rtt;
    roundTrips++;
    events.push({ at: t, text: `${reply} arrives: ${note} (${roundTrips} round trip${roundTrips > 1 ? 's' : ''})` });
  };

  if (protocol !== 'reused') {
    if (dns > 0) {
      messages.push({ from: 'browser', to: 'resolver', label: 'where?', depart: 0, arrive: dns / 2 });
      messages.push({ from: 'resolver', to: 'browser', label: 'address', depart: dns / 2, arrive: dns });
    }
    phases.push({ phase: 'dns', label: 'DNS', start: 0, end: dns });
    events.push({ at: dns, text: dns > 0 ? 'DNS answer: the server\'s IP address' : 'DNS answer came from the cache: 0 ms' });
    t = dns;
  }

  if (protocol === 'tls12' || protocol === 'tls13') {
    const start = t;
    exchange('SYN', 'SYN-ACK', 'TCP connected');
    phases.push({ phase: 'tcp', label: 'TCP', start, end: t });
    const tls = t;
    if (protocol === 'tls12') {
      exchange('Hello', 'Hello+cert', 'certificate checked');
      exchange('Key', 'Finished', 'encrypted channel ready');
    } else {
      exchange('Hello+key', 'Hello+cert', 'certificate checked, keys agreed');
    }
    phases.push({ phase: 'tls', label: 'TLS', start: tls, end: t });
  } else if (protocol === 'quic') {
    const start = t;
    exchange('Initial', 'Hello+cert', 'QUIC connected and encrypted');
    phases.push({ phase: 'quic', label: 'QUIC', start, end: t });
  }

  // The request itself: half a trip there, the server works, half a trip back.
  const ask = t;
  messages.push({ from: 'browser', to: 'server', label: 'GET /', depart: t, arrive: t + half });
  events.push({ at: t + half, text: `GET / reaches the server; it works for ${server} ms` });
  const serverBusy: [number, number] = [t + half, t + half + server];
  messages.push({ from: 'server', to: 'browser', label: '200 OK', depart: t + half + server, arrive: t + rtt + server, final: true });
  t += rtt + server;
  roundTrips++;
  events.push({ at: t, text: `first byte of the page arrives after ${roundTrips} round trip${roundTrips > 1 ? 's' : ''}` });
  phases.push({ phase: 'request', label: 'Request', start: ask, end: t });

  return { messages, phases, events, serverBusy, firstByte: t, roundTrips };
}

const PARAMS: ParamSpec[] = [
  { name: 'rtt', label: 'Round trip to the server', min: 10, max: 300, step: 10, value: 190, unit: 'ms' },
  { name: 'dns', label: 'DNS lookup', min: 0, max: 300, step: 10, value: 40, unit: 'ms' },
  { name: 'server', label: 'Server work', min: 0, max: 500, step: 10, value: 50, unit: 'ms' },
];

const msText = (n: number) => `${Math.round(n)} ms`;

export const createRoundTripModel: SimFactory = (config) => {
  const mode = (config.protocol as Mode) ?? 'tls13';
  const isCompare = mode === 'compare';
  const rows: Protocol[] = isCompare ? ['tls12', 'tls13', 'quic', 'reused'] : [mode];

  let p: Record<string, number> = {};
  let t = 0;
  let plans: Plan[] = [];
  let span = 1; // ms shown across the time axis
  let runs = 0;

  const done = () => t >= Math.max(...plans.map((pl) => pl.firstByte));

  /** A bar (or the two-stripe QUIC bar) from `start` to `end` on a time axis. */
  function bar(g: SVGGElement, x0: number, scale: number, y: number, h: number, phase: Phase, start: number, end: number) {
    const x = x0 + start * scale;
    const w = Math.max(0, (end - start) * scale);
    if (w <= 0) return;
    if (phase === 'quic') {
      svg('rect', { x, y, width: w, height: h / 2, fill: PHASE_COLOUR.tcp }, g);
      svg('rect', { x, y: y + h / 2, width: w, height: h / 2, fill: PHASE_COLOUR.tls }, g);
    } else {
      svg('rect', { x, y, width: w, height: h, fill: PHASE_COLOUR[phase] }, g);
    }
  }

  // ---------- single connection: wire picture + waterfall ----------

  const POS: Record<End, { x: number; y: number }> = {
    browser: { x: 110, y: 0 },
    server: { x: 290, y: 0 },
    resolver: { x: 200, y: 0 },
  };

  function renderSingle(view: SVGSVGElement) {
    const pl = plans[0];
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      const box = (x: number, y: number, w: number, h: number, kind: 'client' | 'server', label: string) => {
        svg('rect', {
          x, y, width: w, height: h, rx: kind === 'client' ? 12 : 5,
          fill: token(`--viz-${kind}-soft`), stroke: token(`--viz-${kind}`), 'stroke-width': 2,
        }, base);
        text(label, { x: x + w / 2, y: y + h / 2 + 7, 'text-anchor': 'middle', fill: INK, 'font-size': 19, 'font-weight': 600 }, base);
      };
      box(6, 70, 104, 48, 'client', 'Browser');
      box(290, 70, 104, 48, 'server', 'Server');
      if (pl.phases[0].phase === 'dns') {
        box(150, 4, 100, 40, 'server', 'DNS');
        svg('line', { x1: 96, y1: 70, x2: 152, y2: 44, stroke: STROKE, 'stroke-width': 1.5, 'stroke-dasharray': '3 5' }, base);
      }
      svg('line', { x1: 110, y1: 94, x2: 290, y2: 94, stroke: STROKE, 'stroke-width': 1.5, 'stroke-dasharray': '3 5' }, base);
      // Waterfall rows: a faint outline shows where each phase will end.
      const scale = 290 / span;
      pl.phases.forEach((ph, i) => {
        const y = 170 + i * 34;
        text(ph.label, { x: 6, y: y + 20, fill: INK, 'font-size': 19 }, base);
        svg('rect', {
          x: 100 + ph.start * scale, y, width: Math.max(1, (ph.end - ph.start) * scale), height: 24,
          fill: 'none', stroke: STROKE, 'stroke-width': 1, 'stroke-dasharray': '3 3',
        }, base);
      });
    }

    const live = layer(view, 'live');
    clear(live);

    // Packets in flight. Requests travel on the upper side of the wire, replies on the lower.
    for (const m of pl.messages) {
      if (t < m.depart || t >= m.arrive) continue;
      const f = (t - m.depart) / (m.arrive - m.depart);
      let x: number;
      let y: number;
      if (m.from === 'resolver' || m.to === 'resolver') {
        const [ax, ay, bx, by] = m.from === 'browser' ? [96, 70, 152, 44] : [152, 44, 96, 70];
        x = ax + (bx - ax) * f;
        y = ay + (by - ay) * f;
      } else {
        const outbound = m.from === 'browser';
        x = POS[m.from].x + (POS[m.to].x - POS[m.from].x) * f;
        y = outbound ? 86 : 102;
      }
      const colour = m.final ? token('--viz-ok') : m.from === 'browser' ? token('--viz-flow') : token('--viz-server');
      svg('circle', { cx: x, cy: y, r: 7, fill: colour }, live);
      const resolverHop = m.from === 'resolver' || m.to === 'resolver';
      text(m.label, {
        x: Math.min(330, Math.max(70, x)),
        y: resolverHop ? y + 26 : m.from === 'browser' ? 76 : 130,
        'text-anchor': resolverHop ? 'start' : 'middle',
        fill: colour, 'font-size': 19, 'font-weight': 600,
      }, live);
    }

    // The server thinking.
    if (t >= pl.serverBusy[0] && t < pl.serverBusy[1]) {
      text('working', { x: 342, y: 146, 'text-anchor': 'middle', fill: token('--viz-warn'), 'font-size': 19, 'font-weight': 600 }, live);
    }

    // Waterfall bars, filled up to now.
    const scale = 290 / span;
    pl.phases.forEach((ph, i) => {
      bar(live, 100, scale, 170 + i * 34, 24, ph.phase, ph.start, Math.min(t, ph.end));
    });
    const cursor = 100 + Math.min(t, span) * scale;
    svg('line', { x1: cursor, y1: 162, x2: cursor, y2: 170 + pl.phases.length * 34 - 6, stroke: INK, 'stroke-width': 1.5 }, live);

    const yText = 170 + pl.phases.length * 34 + 22;
    const message = t >= pl.firstByte
      ? `First byte at ${msText(pl.firstByte)}: ${pl.roundTrips} round trips`
      : `${msText(t)} so far`;
    text(message, {
      x: 6, y: yText, fill: t >= pl.firstByte ? token('--viz-ok') : INK, 'font-size': 20, 'font-weight': 700,
    }, live);
  }

  // ---------- compare: four timelines on one axis ----------

  function renderCompare(view: SVGSVGElement) {
    const x0 = 104;
    const width = 286;
    const scale = width / span;
    const base = layer(view, 'base');
    if (!base.childElementCount) {
      rows.forEach((r, i) => {
        const y = 14 + i * 58;
        text(ROW_LABEL[r], { x: 6, y: y + 21, fill: INK, 'font-size': 19, 'font-weight': 600 }, base);
        svg('rect', { x: x0, y, width, height: 26, fill: 'none', stroke: STROKE, 'stroke-width': 1, rx: 3 }, base);
      });
      // Legend: colour plus a word, never colour alone.
      const legend: [Phase, string][] = [['dns', 'DNS'], ['tcp', 'TCP'], ['tls', 'TLS'], ['request', 'Request']];
      legend.forEach(([ph, label], i) => {
        const x = 6 + i * 98;
        svg('rect', { x, y: 254, width: 14, height: 14, fill: PHASE_COLOUR[ph] }, base);
        text(label, { x: x + 20, y: 267, fill: INK, 'font-size': 19 }, base);
      });
    }

    const live = layer(view, 'live');
    clear(live);
    plans.forEach((pl, i) => {
      const y = 14 + i * 58;
      for (const ph of pl.phases) bar(live, x0, scale, y, 26, ph.phase, ph.start, Math.min(t, ph.end));
      const reached = t >= pl.firstByte;
      text(reached ? `${msText(pl.firstByte)}, ${pl.roundTrips} RTT` : '…', {
        x: x0, y: y + 48, fill: reached ? token('--viz-ok') : MUTED, 'font-size': 19, 'font-weight': reached ? 700 : 400,
      }, live);
    });
    const cursor = x0 + Math.min(t, span) * scale;
    svg('line', { x1: cursor, y1: 8, x2: cursor, y2: 14 + rows.length * 58 - 26, stroke: INK, 'stroke-width': 1.5 }, live);
  }

  return {
    params: PARAMS,

    reset(params) {
      p = params;
      t = 0;
      runs = 0;
      plans = rows.map((r) => plan(r, p.rtt, p.dns, p.server));
      span = Math.max(...plans.map((pl) => pl.firstByte)) * 1.02;
    },

    step(dtMs) {
      t += (dtMs / 1000) * SLOW;
      if (t > Math.max(...plans.map((pl) => pl.firstByte)) + HOLD) {
        t = 0; // replay, so the reader can watch it again
        runs++;
      }
    },

    render(view) {
      // The static layer depends on the parameters, so rebuild it after every reset.
      const base = layer(view, 'base');
      if (base.dataset.key !== JSON.stringify(p)) {
        clear(base);
        base.dataset.key = JSON.stringify(p);
      }
      if (isCompare) renderCompare(view);
      else renderSingle(view);
    },

    stats() {
      if (isCompare) {
        return Object.fromEntries(
          plans.map((pl, i) => [ROW_LABEL[rows[i]], t >= pl.firstByte ? msText(pl.firstByte) : '…']),
        );
      }
      const pl = plans[0];
      const trips = pl.messages.filter((m) => m.to === 'browser' && m.from === 'server' && m.arrive <= t).length;
      return {
        time: `${msText(Math.min(t, pl.firstByte))}`,
        'round trips': trips,
        'first byte': t >= pl.firstByte ? msText(pl.firstByte) : '…',
      };
    },

    log() {
      if (t === 0 && runs === 0) return 'Press Play, or Step to move 20 ms of simulated time at a time.';
      if (isCompare) {
        const reached = plans.filter((pl) => t >= pl.firstByte).map((pl) => ROW_LABEL[rows[plans.indexOf(pl)]]);
        return reached.length
          ? `t=${msText(t)}: first byte reached by ${reached.join(', ')}`
          : `t=${msText(t)}: every row is still setting up or waiting`;
      }
      const past = plans[0].events.filter((e) => e.at <= t);
      const last = past[past.length - 1];
      return last ? `t=${msText(last.at)} ${last.text}` : `t=${msText(t)} looking up the name`;
    },
  };
};
