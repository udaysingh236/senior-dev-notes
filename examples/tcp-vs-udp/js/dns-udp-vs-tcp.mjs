// The same question over UDP and over TCP, against a real server on the internet.
//
// We ask Cloudflare's public resolver 1.1.1.1 for the A record of example.com. Over UDP that is one
// datagram out and one back. Over TCP we first pay for the handshake, then send the same bytes with
// a 2-byte length prefix (DNS over TCP frames its messages exactly like framing.mjs). Then we ask
// again on the open TCP connection to see what reuse buys.
//
// Run: node dns-udp-vs-tcp.mjs      (needs outgoing UDP and TCP to port 53)
import dgram from 'node:dgram';
import net from 'node:net';
import { randomInt } from 'node:crypto';

const [HOST, PORT] = ['1.1.1.1', 53];
const ROUNDS = 7;

/** A minimal DNS query: header with recursion desired, one question, type A, class IN. */
function query(name) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(randomInt(65536), 0);
  header.writeUInt16BE(0x0100, 2); // recursion desired
  header.writeUInt16BE(1, 4); // one question
  const labels = name.split('.').flatMap((p) => [Buffer.from([p.length]), Buffer.from(p)]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]); // root, type A, class IN
}

function askUdp(q) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => { s.close(); reject(new Error('UDP timeout')); }, 2000);
    const t = performance.now();
    s.once('message', () => { clearTimeout(timer); s.close(); resolve(performance.now() - t); });
    s.send(q, PORT, HOST);
  });
}

/** Reads length-prefixed DNS messages off a TCP socket, one per call. */
function tcpAsker(socket) {
  let buffer = Buffer.alloc(0);
  let waiting = null;
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (waiting && buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
      buffer = buffer.subarray(2 + buffer.readUInt16BE(0));
      waiting();
    }
  });
  return (q) => new Promise((resolve) => {
    const t = performance.now();
    waiting = () => resolve(performance.now() - t);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(q.length);
    socket.write(Buffer.concat([length, q])); // 2-byte length, then the message
  });
}

const [udp, connect, first, reused] = [[], [], [], []];
const q = query('example.com');
for (let i = 0; i < ROUNDS; i++) {
  udp.push(await askUdp(q));
  const t = performance.now();
  const socket = net.connect(PORT, HOST);
  await new Promise((r, j) => socket.once('connect', r).once('error', j));
  connect.push(performance.now() - t); // SYN, SYN-ACK: one round trip
  const ask = tcpAsker(socket);
  first.push(await ask(q));
  reused.push(await ask(q));
  socket.end();
  await new Promise((r) => setTimeout(r, 200));
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (x) => `${x.toFixed(1).padStart(5)} ms`;
console.log(`median of ${ROUNDS} rounds, asking ${HOST} for example.com A`);
console.log(`  UDP                        ${ms(med(udp))}   one round trip, no setup`);
console.log(`  TCP, new connection        ${ms(med(connect) + med(first))}   = connect ${ms(med(connect)).trim()} + query ${ms(med(first)).trim()}`);
console.log(`  TCP, connection reused     ${ms(med(reused))}   the handshake is already paid for`);
