// A small but realistic page, loaded the way a browser loads it, so the critical path shows up:
//
//   HTML (www, 30 KB, built per user)          discovered at once
//   CSS (www, 40 KB) and JS (www, 120 KB)      discovered in the first HTML packets
//   8 images (img host, 30 KB each)            discovered when the HTML is complete
//   web font (third-party font CDN, 25 KB)     discovered when the CSS is complete
//   API call (api host, 5 KB, built per user)  made when the JS has run (CSS and JS done + 50 ms)
//
// Every new host costs a DNS lookup and a connection set-up (TCP + TLS 1.3 = 2 round trips, or
// QUIC = 1). HTTP/1.1 opens up to six connections per host, one request at a time on each;
// HTTP/2 and HTTP/3 put every request to a host on one connection. Each connection has its own
// congestion window (10 packets, doubling each round trip), kept warm between requests.
// A CDN edge 20 ms away ends every connection near the user, answers static files from its cache,
// and forwards HTML and API calls to the origin over a connection it keeps open.
// A repeat visit has DNS answers and static files cached; HTML and the API call go to the network.
// The model is deterministic: a 1 ms time step, no randomness.
import { clear, layer, svg, text, token, formatMs } from '../../sim/svg';
import type { SimFactory } from '../../sim/types';
import { MSS } from './slowstart-model';

type Host = 'www' | 'img' | 'fonts' | 'api';
type Kind = 'html' | 'css' | 'js' | 'img' | 'font' | 'api';

export interface PageInput {
  rtt: number; // ms, browser to origin
  http: number; // 1, 2 or 3
  cdn: number; // 0 or 1
  preconnect: number; // 0 or 1: <link rel="preconnect"> to the font and API hosts
  visit: number; // 1 = first visit, 2 = repeat visit
}

export interface Resource {
  id: string;
  kind: Kind;
  host: Host;
  bytes: number;
  dynamic: boolean; // built per user: never served from a cache
  discovered: number;
  queuedUntil: number; // HTTP/1.1: waiting for a free connection
  dns: [number, number] | null;
  connect: [number, number] | null;
  sent: number;
  firstByte: number;
  done: number;
  cached: boolean;
}

export interface PageResult {
  resources: Resource[];
  firstByte: number;
  firstRender: number;
  fontShown: number;
  dataShown: number;
  allDone: number;
  connections: number;
}

const EDGE_RTT = 20;
const FONT_CDN_RTT = 30; // the third-party font CDN is already near most users
const DNS_MS = 40; // a lookup that misses the browser and OS caches
const INITCWND = 10;
const JS_RUN_MS = 50;
const SERVER_MS: Record<Kind, number> = { html: 50, api: 80, css: 2, js: 2, img: 2, font: 2 };

interface Conn {
  host: Host;
  dns: [number, number] | null; // the lookup this connection waited for, if any
  connectStart: number;
  readyAt: number; // set-up finished
  used: boolean;
  busyUntil: number; // HTTP/1.1: the response in flight finishes
  cwnd: number;
  nextRound: number; // server side: when the next round may start
  queue: { res: Resource; readyAt: number; left: number }[];
}

export function loadPage(p: PageInput): PageResult {
  const rttTo = (h: Host) => (h === 'fonts' ? FONT_CDN_RTT : p.cdn ? EDGE_RTT : p.rtt);
  const setupRtts = p.http === 3 ? (p.visit === 2 ? 0 : 1) : 2; // QUIC 0-RTT on a repeat visit
  const make = (id: string, kind: Kind, host: Host, kb: number, dynamic: boolean): Resource => ({
    id, kind, host, bytes: kb * 1000, dynamic, discovered: Infinity, queuedUntil: 0, dns: null, connect: null,
    sent: Infinity, firstByte: Infinity, done: Infinity, cached: false,
  });
  const html = make('HTML', 'html', 'www', 30, true);
  const css = make('CSS', 'css', 'www', 40, false);
  const js = make('JS', 'js', 'www', 120, false);
  const font = make('Font', 'font', 'fonts', 25, false);
  const api = make('API', 'api', 'api', 5, true);
  const imgs = Array.from({ length: 8 }, (_, i) => make(`img${i + 1}`, 'img', 'img', 30, false));
  const all = [html, css, js, font, api, ...imgs];

  const resolved = new Map<Host, number>(); // host -> when its address is known
  const conns: Conn[] = [];
  const pending: Resource[] = []; // discovered, waiting for a connection
  let opened = 0;

  function lookup(host: Host, now: number): number {
    if (!resolved.has(host)) resolved.set(host, p.visit === 2 ? now : now + DNS_MS);
    return resolved.get(host)!;
  }

  function open(host: Host, now: number): Conn {
    const known = resolved.has(host);
    const dnsDone = Math.max(now, lookup(host, now));
    const c: Conn = {
      host, dns: !known && dnsDone > now ? [now, dnsDone] : null, connectStart: dnsDone,
      readyAt: dnsDone + setupRtts * rttTo(host), used: false, busyUntil: 0, cwnd: INITCWND, nextRound: 0, queue: [],
    };
    conns.push(c);
    opened++;
    return c;
  }

  if (p.preconnect) {
    open('fonts', 0);
    open('api', 0);
  }

  /** Puts a discovered resource on a connection, or leaves it waiting. True when it was placed. */
  function place(r: Resource, now: number): boolean {
    if (!r.dynamic && p.visit === 2) {
      r.cached = true;
      r.sent = r.firstByte = now;
      r.done = now + 2; // read from the browser's disk cache
      return true;
    }
    const mine = conns.filter((c) => c.host === r.host);
    let c: Conn | undefined;
    if (p.http === 1) {
      // An idle open connection, else one still being set up that nobody has claimed yet.
      c = mine.find((x) => x.readyAt <= now && x.busyUntil <= now && x.queue.length === 0)
        ?? mine.find((x) => !x.used && x.readyAt > now);
      if (!c && mine.length < 6) c = open(r.host, now);
      if (!c) return false; // all six busy: wait
      c.busyUntil = Infinity;
    } else {
      c = mine[0] ?? open(r.host, now);
    }
    // The first request on a connection waits for its set-up; later ones ride an open one.
    if (!c.used && c.readyAt > r.discovered) {
      if (c.dns && c.dns[1] > r.discovered) r.dns = [Math.max(r.discovered, c.dns[0]), c.dns[1]];
      r.connect = [Math.max(r.discovered, c.connectStart), c.readyAt];
    }
    c.used = true;
    r.queuedUntil = now;
    const send = Math.max(now, c.readyAt);
    r.sent = send;
    const rtt = rttTo(r.host);
    // At the edge, static files come from its cache; per-user responses need the origin.
    const behind = p.cdn && r.host !== 'fonts' && r.dynamic ? p.rtt : 0;
    c.queue.push({ res: r, readyAt: send + rtt / 2 + SERVER_MS[r.kind] + behind, left: Math.ceil(r.bytes / MSS) });
    return true;
  }

  for (let now = 0; now < 20000; now++) {
    // Discovery: what the browser has learned it needs by now.
    if (html.discovered === Infinity) {
      html.discovered = 0;
      pending.push(html);
    }
    if (css.discovered === Infinity && html.firstByte <= now) {
      css.discovered = js.discovered = now;
      pending.push(css, js);
    }
    if (imgs[0].discovered === Infinity && html.done <= now) {
      for (const i of imgs) i.discovered = now;
      pending.push(...imgs);
    }
    if (font.discovered === Infinity && css.done <= now) {
      font.discovered = now;
      pending.push(font);
    }
    if (api.discovered === Infinity && Math.max(css.done, js.done) + JS_RUN_MS <= now) {
      api.discovered = now;
      pending.push(api);
    }

    for (let i = 0; i < pending.length; ) {
      if (place(pending[i], now)) pending.splice(i, 1);
      else i++;
    }

    // Each connection sends one window per round trip, oldest response first.
    for (const c of conns) {
      if (c.nextRound > now) continue;
      const ready = c.queue.filter((q) => q.readyAt <= now && q.left > 0);
      if (!ready.length) continue;
      const rtt = rttTo(c.host);
      let budget = c.cwnd;
      let sentAny = false;
      for (const q of ready) {
        if (!budget) break;
        const n = Math.min(budget, q.left);
        budget -= n;
        q.left -= n;
        sentAny = true;
        const arrive = now + rtt / 2;
        if (q.res.firstByte === Infinity) q.res.firstByte = arrive;
        if (q.left === 0) {
          q.res.done = arrive;
          if (p.http === 1) c.busyUntil = arrive;
        }
      }
      if (sentAny) {
        if (budget === 0) c.cwnd *= 2; // the window only grows when it was the limit
        c.nextRound = now + rtt;
      }
      c.queue = c.queue.filter((q) => q.left > 0);
    }
    if (all.every((r) => r.done <= now)) break;
  }

  const firstRender = Math.max(html.done, css.done);
  const fontShown = Math.max(firstRender, font.done);
  const dataShown = Math.max(firstRender, api.done);
  return {
    resources: all,
    firstByte: html.firstByte,
    firstRender,
    fontShown,
    dataShown,
    allDone: Math.max(...all.map((r) => r.done)),
    connections: opened,
  };
}

const SPEED = 0.5;
const HOLD = 2500;

export const createWaterfallModel: SimFactory = () => {
  let p: PageInput = { rtt: 150, http: 2, cdn: 0, preconnect: 0, visit: 1 };
  let page: PageResult;
  let clock = 0;
  let hold = 0;
  let lastEvent: string | null = null;

  return {
    params: [
      { name: 'rtt', label: 'Round trip to the origin', min: 20, max: 300, step: 10, value: 150, unit: 'ms' },
      { name: 'http', label: 'HTTP version (1.1, 2 or 3)', min: 1, max: 3, step: 1, value: 2 },
      { name: 'cdn', label: 'CDN edge 20 ms away (0 = no, 1 = yes)', min: 0, max: 1, step: 1, value: 0 },
      { name: 'preconnect', label: 'Preconnect to font and API hosts (0/1)', min: 0, max: 1, step: 1, value: 0 },
      { name: 'visit', label: 'Visit (1 = first, 2 = repeat)', min: 1, max: 2, step: 1, value: 1 },
    ],

    reset(params) {
      p = params as unknown as PageInput;
      page = loadPage(p);
      clock = 0;
      hold = 0;
      lastEvent = `HTTP/${p.http === 1 ? '1.1' : p.http}${p.cdn ? ' through a CDN edge' : ''}, ${p.visit === 2 ? 'repeat' : 'first'} visit: ${page.connections} connections opened.`;
    },

    step(dt) {
      if (clock < page.allDone) {
        clock = Math.min(page.allDone, clock + dt * SPEED);
        if (clock >= page.allDone) lastEvent = `everything loaded after ${formatMs(page.allDone)}; first render at ${formatMs(page.firstRender)}`;
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
      const INK = token('--viz-ink');
      const x0 = 74;
      const span = Math.max(page.allDone, 400);
      const sx = (t: number) => x0 + (Math.min(t, clock) / span) * (396 - x0);
      const rows: [string, Resource[]][] = [
        ['HTML', [page.resources[0]]],
        ['CSS', [page.resources[1]]],
        ['JS', [page.resources[2]]],
        ['Font', [page.resources[3]]],
        ['API', [page.resources[4]]],
        ['Images', page.resources.slice(5)],
      ];
      let y = 6;
      for (const [label, list] of rows) {
        const h = list.length > 1 ? 52 : 26;
        text(label, { x: 4, y: y + (list.length > 1 ? 32 : 19), 'font-size': 18, 'font-weight': 700, fill: INK }, live);
        list.forEach((r, i) => {
          const lane = list.length > 1 ? 5 : 18;
          const ly = y + 3 + i * (lane + 1.4);
          const seg = (a: number, b: number, tone: string, outline = false) => {
            if (a > clock || b <= a) return;
            svg('rect', {
              x: sx(a), y: ly, width: Math.max(1.5, sx(b) - sx(a)), height: lane, rx: lane > 6 ? 3 : 1,
              fill: outline ? 'none' : token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': lane > 6 ? 1.5 : 1,
            }, live);
          };
          if (r.cached) {
            seg(r.discovered, Math.max(r.done, r.discovered + span / 120), 'ok');
            return;
          }
          if (r.queuedUntil > r.discovered) seg(r.discovered, r.queuedUntil, 'stroke', true);
          if (r.dns) seg(r.dns[0], r.dns[1], 'store');
          if (r.connect) seg(r.connect[0], r.connect[1], 'warn');
          seg(r.sent, r.firstByte, 'stroke', true);
          seg(r.firstByte, r.done, 'flow');
        });
        y += h + 4;
      }
      // Markers for first render and everything loaded.
      const axis = y + 4;
      svg('line', { x1: x0, y1: axis, x2: 396, y2: axis, stroke: token('--viz-stroke'), 'stroke-width': 1 }, live);
      const mark = (t: number, label: string, anchor: string, dy: number) => {
        if (t > clock) return;
        svg('line', { x1: sx(t), y1: 4, x2: sx(t), y2: axis, stroke: token('--viz-ok'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, live);
        text(label, { x: sx(t), y: axis + dy, 'font-size': 15, 'text-anchor': anchor, fill: token('--viz-ok') }, live);
      };
      mark(page.firstRender, `render ${formatMs(page.firstRender)}`, 'start', 18);
      mark(page.allDone, `done ${formatMs(page.allDone)}`, 'end', 36);
      // Legend.
      const ly = axis + 58;
      const chips: [string, string, boolean][] = [['DNS', 'store', false], ['connect', 'warn', false], ['wait', 'stroke', true], ['data', 'flow', false], ['cache', 'ok', false]];
      chips.forEach(([name, tone, outline], i) => {
        const x = 4 + i * 79;
        svg('rect', { x, y: ly - 12, width: 14, height: 14, rx: 2, fill: outline ? 'none' : token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.5 }, live);
        text(name, { x: x + 19, y: ly, 'font-size': 15, fill: token('--viz-muted') }, live);
      });
    },

    stats() {
      return {
        'first byte of HTML': formatMs(page.firstByte),
        'first render': formatMs(page.firstRender),
        'web font shown': formatMs(page.fontShown),
        'API data shown': formatMs(page.dataShown),
        'everything loaded': formatMs(page.allDone),
        'connections opened': page.connections,
      };
    },

    log: () => lastEvent,
  };
};
