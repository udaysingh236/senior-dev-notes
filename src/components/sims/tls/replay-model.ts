// 0-RTT replay against a cluster. A client sends POST /transfer as TLS 1.3 early data; an attacker on
// the path copies the encrypted first flight and sends it again a few times, on new connections. The
// load balancer spreads every connection over the servers at random. What decides how many
// transfers run twice is where the "have I seen this ClientHello?" memory lives:
//   0  no anti-replay: every copy runs
//   1  a cache inside each server: a copy is caught only if it lands on a server that saw it
//   2  one cache shared by all servers: every copy is caught, at the cost of a lookup per handshake
//   3  no POST in early data: the server refuses it (425 Too Early); the client resends after the
//      full handshake, and the attacker cannot finish a handshake, so nothing is replayed
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

interface Msg {
  id: number; // which transfer this flight belongs to
  replay: boolean;
  server: number;
  sentAt: number;
  arriveAt: number;
}

interface Flash {
  server: number;
  until: number;
  tone: 'ok' | 'bad' | 'muted' | 'warn';
}

const GAP_MS = 1500; // a new genuine transfer every 1.5 s
const FLIGHT_MS = 500;
const DEFENCES = ['no anti-replay', 'cache in each server', 'one shared cache', 'no POST in early data'];

const INK = token('--viz-ink');
const MUTED = token('--viz-muted');
const STROKE = token('--viz-stroke');

export const createReplayModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let now = 0;
  let nextTransfer = 0;
  let nextId = 1;
  let pending: Msg[] = [];
  let flashes: Flash[] = [];
  let seenPerServer: Set<number>[] = [];
  let seenShared = new Set<number>();
  let transfers = 0;
  let replaysSent = 0;
  let duplicates = 0;
  let blocked = 0;
  let lookups = 0;
  let fullHandshakes = 0;
  let lastLog: string | null = null;

  const pos = (k: number, n: number) => {
    // Up to 8 servers per row, two rows.
    const perRow = Math.min(8, n);
    const row = Math.floor(k / 8);
    const col = k % 8;
    const w = 276 / perRow;
    return { x: 120 + col * w + w / 2, y: 74 + row * 64, w: Math.min(30, w - 6) };
  };

  function send(id: number, replay: boolean, at: number): void {
    const server = rng.int(0, p.servers - 1);
    pending.push({ id, replay, server, sentAt: at, arriveAt: at + FLIGHT_MS });
  }

  function arrive(m: Msg): void {
    const d = p.defence;
    const who = m.replay ? 'copy' : 'original';
    let run = true;
    if (d === 3) {
      // Early data refused. The real client finishes the handshake and resends; a copy cannot.
      run = !m.replay;
      if (!m.replay) fullHandshakes++;
    } else if (d === 1) {
      run = !seenPerServer[m.server].has(m.id);
      seenPerServer[m.server].add(m.id);
    } else if (d === 2) {
      lookups++;
      run = !seenShared.has(m.id);
      seenShared.add(m.id);
    }
    if (m.replay && run) duplicates++;
    if (m.replay && !run) blocked++;
    const tone: Flash['tone'] = !run ? 'muted' : m.replay ? 'bad' : d === 3 ? 'warn' : 'ok';
    flashes.push({ server: m.server, until: now + 700, tone });
    const action = !run
      ? (d === 3 ? 'early data refused, attacker cannot finish the handshake' : 'seen before, rejected')
      : m.replay ? 'RUN AGAIN: a second transfer' : d === 3 ? 'run after a full handshake (1 extra round trip)' : 'run';
    lastLog = `transfer #${m.id}, ${who} -> server ${m.server + 1}: ${action}`;
  }

  return {
    params: [
      { name: 'servers', label: 'Servers behind the balancer', min: 1, max: 16, step: 1, value: 8 },
      { name: 'replays', label: 'Copies the attacker sends of each request', min: 0, max: 10, step: 1, value: 4 },
      { name: 'defence', label: 'Defence: 0 none, 1 cache per server, 2 shared cache, 3 no POST early', min: 0, max: 3, step: 1, value: 1 },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      now = 0;
      nextTransfer = 200;
      nextId = 1;
      pending = [];
      flashes = [];
      seenPerServer = Array.from({ length: p.servers }, () => new Set<number>());
      seenShared = new Set();
      transfers = replaysSent = duplicates = blocked = lookups = fullHandshakes = 0;
      lastLog = `Defence: ${DEFENCES[p.defence]}. Every POST /transfer is copied ${p.replays} times.`;
    },

    step(dt) {
      now += dt;
      while (now >= nextTransfer) {
        const id = nextId++;
        transfers++;
        send(id, false, nextTransfer);
        for (let k = 0; k < p.replays; k++) {
          send(id, true, nextTransfer + rng.range(300, 4000));
          replaysSent++;
        }
        nextTransfer += GAP_MS;
      }
      pending.sort((a, b) => a.arriveAt - b.arriveAt);
      while (pending.length && pending[0].arriveAt <= now) arrive(pending.shift()!);
      flashes = flashes.filter((f) => f.until > now);
    },

    render(view) {
      const n = p.servers;
      const base = layer(view, 'base');
      if (base.getAttribute('data-n') !== `${n}:${p.defence}`) {
        clear(base);
        base.setAttribute('data-n', `${n}:${p.defence}`);
        const label = { 'font-size': 18, 'font-weight': 700, fill: INK };
        text('client', { ...label, x: 4, y: 64 }, base);
        text('attacker', { ...label, x: 4, y: 176 }, base);
        svg('circle', { cx: 100, cy: 58, r: 7, fill: token('--viz-flow') }, base);
        svg('rect', { x: 93, y: 163, width: 14, height: 14, transform: 'rotate(45 100 170)', fill: token('--viz-bad') }, base);
        for (let k = 0; k < n; k++) {
          const s = pos(k, n);
          svg('rect', { x: s.x - s.w / 2, y: s.y - 15, width: s.w, height: 30, rx: 4, fill: token('--viz-server-soft'), stroke: token('--viz-server'), 'stroke-width': 1.5 }, base);
        }
        const note = p.defence === 2 ? 'one replay cache, asked on every handshake' : p.defence === 1 ? 'each server remembers only what it saw' : p.defence === 3 ? 'POST must wait for the full handshake' : 'nothing remembers anything';
        text(note, { x: 4, y: 222, 'font-size': 17, fill: MUTED, 'font-style': 'italic' }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      for (const f of flashes) {
        const s = pos(f.server, n);
        const colour = f.tone === 'muted' ? STROKE : token(`--viz-${f.tone}`);
        svg('rect', { x: s.x - s.w / 2 - 3, y: s.y - 18, width: s.w + 6, height: 36, rx: 6, fill: 'none', stroke: colour, 'stroke-width': 3 }, live);
      }
      for (const m of pending) {
        if (m.sentAt > now) continue;
        const t = Math.min(1, (now - m.sentAt) / FLIGHT_MS);
        const s = pos(m.server, n);
        const x0 = 100;
        const y0 = m.replay ? 170 : 58;
        const x = x0 + (s.x - x0) * t;
        const y = y0 + (s.y - y0) * t;
        if (m.replay) svg('rect', { x: x - 5, y: y - 5, width: 10, height: 10, transform: `rotate(45 ${x} ${y})`, fill: token('--viz-bad') }, live);
        else svg('circle', { cx: x, cy: y, r: 6, fill: token('--viz-flow') }, live);
      }
    },

    stats() {
      return {
        transfers,
        'replays sent': replaysSent,
        'transfers run twice': duplicates,
        'copies rejected': blocked,
        'shared cache lookups': lookups,
        'POSTs that lost 0-RTT': fullHandshakes,
      };
    },

    log: () => lastLog,
  };
};
