// Rebuilding a little of TCP on top of UDP: sequence numbers, acks, timeouts and a window.
//
// Real UDP sockets on 127.0.0.1, with an impaired "link": every datagram, in both directions, is
// dropped with probability 10% and otherwise delayed by 20-30 ms (so they can also arrive out of
// order). We send 100 messages three ways:
//
//   1. plain UDP           no acks: what arrives, arrives
//   2. stop-and-wait       send one, wait for its ack, retransmit on timeout
//   3. sliding window      up to 16 unacked messages in flight, each with its own timer
//
// Run: node reliable-udp.mjs
import dgram from 'node:dgram';

const HOST = '127.0.0.1';
const COUNT = 100;
const [LOSS, DELAY, JITTER] = [0.1, 20, 10]; // 10% loss, 20-30 ms each way

// A small seeded generator (mulberry32), so runs are similar; timing still varies a little.
let seed = 7;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Sends through a real UDP socket, but drops some datagrams and delays the rest. */
function linkSend(socket, data, port) {
  if (random() < LOSS) return;
  setTimeout(() => socket.send(data, port, HOST), DELAY + random() * JITTER);
}

function receiver(reliable) {
  const socket = dgram.createSocket('udp4');
  const state = { expected: 0, buffer: new Map(), delivered: [], outOfOrder: 0, waits: [] };
  socket.on('message', (data, from) => {
    const seq = data.readUInt32BE(0);
    if (reliable) {
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(seq);
      linkSend(socket, ack, from.port); // ack every copy: the last ack may be lost
    } else {
      // plain UDP: hand it to the application at once, in arrival order
      if (state.delivered.length && seq < state.delivered.at(-1)) state.outOfOrder++;
      state.delivered.push(seq);
      return;
    }
    if (seq < state.expected || state.buffer.has(seq)) return; // a duplicate from a retransmission
    state.buffer.set(seq, performance.now());
    while (state.buffer.has(state.expected)) {
      // deliver in order; a gap holds everything behind it
      state.waits.push(performance.now() - state.buffer.get(state.expected));
      state.buffer.delete(state.expected);
      state.delivered.push(state.expected++);
    }
  });
  return { socket, state };
}

function sender(window, reliable, peerPort, onDone) {
  const socket = dgram.createSocket('udp4');
  const inFlight = new Map(); // seq -> { sent, retries, timer }
  const s = { nextSeq: 0, srtt: null, rttvar: 0, rto: 200, retransmissions: 0 }; // RFC 6298, scaled down

  function transmit(seq, retries) {
    const data = Buffer.alloc(204);
    data.writeUInt32BE(seq);
    linkSend(socket, data, peerPort);
    if (!reliable) return;
    const timer = setTimeout(() => { // back off: each timeout doubles the wait
      s.retransmissions++;
      transmit(seq, retries + 1);
    }, s.rto * 2 ** retries);
    inFlight.set(seq, { sent: performance.now(), retries, timer });
  }

  function fillWindow() {
    while (s.nextSeq < COUNT && inFlight.size < window) transmit(s.nextSeq++, 0);
    if (s.nextSeq === COUNT && inFlight.size === 0) onDone(s);
  }

  socket.on('message', (data) => {
    const seq = data.readUInt32BE(0);
    const entry = inFlight.get(seq);
    if (!entry) return; // a duplicate ack
    clearTimeout(entry.timer);
    inFlight.delete(seq);
    if (entry.retries === 0) { // Karn's rule: never time a retransmitted message
      const rtt = performance.now() - entry.sent;
      if (s.srtt === null) [s.srtt, s.rttvar] = [rtt, rtt / 2];
      else {
        s.rttvar = 0.75 * s.rttvar + 0.25 * Math.abs(s.srtt - rtt);
        s.srtt = 0.875 * s.srtt + 0.125 * rtt;
      }
      s.rto = Math.max(50, s.srtt + 4 * s.rttvar); // a 50 ms floor, like TCP's minimum
    }
    fillWindow();
  });
  socket.bind(0, HOST, fillWindow);
  return socket;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, window, reliable) {
  const rx = receiver(reliable);
  await new Promise((r) => rx.socket.bind(0, HOST, r));
  const start = performance.now();
  const stats = await new Promise((resolve) => {
    const tx = sender(window, reliable, rx.socket.address().port, (s) => resolve({ s, tx }));
    if (!reliable) sleep(200).then(() => resolve({ s: null, tx }));
  });
  const elapsed = (performance.now() - start) / 1000;
  await sleep(100); // let the last datagrams land
  stats.tx.close();
  rx.socket.close();

  const { delivered, outOfOrder, waits } = rx.state;
  console.log(label);
  if (!reliable) {
    console.log(`    ${delivered.length}/${COUNT} arrived, ${COUNT - delivered.length} lost, ${outOfOrder} arrived after a later one`);
    return;
  }
  const inOrder = delivered.length === COUNT && delivered.every((seq, i) => seq === i);
  const waited = waits.filter((w) => w > 1);
  console.log(`    ${delivered.length}/${COUNT} delivered, in order: ${inOrder}, in ${elapsed.toFixed(2)} s`);
  console.log(`    ${stats.s.retransmissions} retransmissions; final RTO ${stats.s.rto.toFixed(0)} ms`);
  if (waited.length) {
    console.log(`    ${waited.length} messages arrived but waited for an earlier one; longest wait ${Math.max(...waited).toFixed(0)} ms`);
  }
}

console.log(`link: ${LOSS * 100}% loss each way, ${DELAY}-${DELAY + JITTER} ms delay each way\n`);
await run('1. plain UDP, no acks', COUNT, false);
await run('2. stop-and-wait (window of 1)', 1, true);
await run('3. sliding window of 16', 16, true);
