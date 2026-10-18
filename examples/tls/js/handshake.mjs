// What a TLS handshake costs on the real internet: TLS 1.2 vs TLS 1.3, and a resumed session.
//
// Times the TCP connect (one round trip) and then the TLS handshake on top of it, several times,
// and reports medians. Also prints the key exchange group that was negotiated. Needs the internet.
// Standard library only.
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';

const HOST = 'www.cloudflare.com';
const ROUNDS = 7;
// Look the address up once, so the timings below measure TCP and TLS, not DNS.
const { address: ADDRESS } = await lookup(HOST, { family: 4 });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function handshake(version, session) {
  return new Promise((resolve, reject) => {
    const result = {};
    let t1;
    const t0 = performance.now();
    const socket = tls.connect({ host: ADDRESS, port: 443, servername: HOST, minVersion: version, maxVersion: version, session }, () => {
      const t2 = performance.now();
      Object.assign(result, { tcp: t1 - t0, tls: t2 - t1, reused: socket.isSessionReused(), group: socket.getEphemeralKeyInfo()?.name });
      // TLS 1.3 sends resumption tickets after the handshake, so make one request to receive them.
      socket.write(`HEAD / HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`); // the server closes
      socket.resume();
      socket.on('close', () => setImmediate(resolve, result)); // let a late 'session' event land first
    });
    socket.once('connect', () => { t1 = performance.now(); }); // TCP is up; the TLS handshake starts now
    socket.on('session', (s) => { result.session = s; }); // listen early: it can fire before the callback
    socket.on('error', reject);
  });
}

const rows = { 'TLS 1.2, full': [], 'TLS 1.3, full': [], 'TLS 1.3, resumed': [] };
const tcp = [];
let reusedCount = 0;
let groups = new Set();
for (let i = 0; i < ROUNDS; i++) {
  let r = await handshake('TLSv1.2');
  tcp.push(r.tcp); rows['TLS 1.2, full'].push(r.tls); groups.add(`TLS 1.2: ${r.group}`);
  r = await handshake('TLSv1.3');
  tcp.push(r.tcp); rows['TLS 1.3, full'].push(r.tls); groups.add(`TLS 1.3: ${r.group}`);
  r = await handshake('TLSv1.3', r.session);
  tcp.push(r.tcp); rows['TLS 1.3, resumed'].push(r.tls); reusedCount += r.reused;
  await new Promise((done) => setTimeout(done, 200));
}

const rtt = median(tcp);
console.log(`${HOST}, median of ${ROUNDS} rounds`);
console.log(`  TCP connect          ${rtt.toFixed(1).padStart(6)} ms   = one round trip`);
for (const [label, times] of Object.entries(rows)) {
  const ms = median(times);
  console.log(`  ${label.padEnd(20)} ${ms.toFixed(1).padStart(6)} ms   = ${(ms / rtt).toFixed(1)} round trips`);
}
console.log(`  resumption accepted in ${reusedCount} of ${ROUNDS} tries`);
console.log(`  key exchange: ${[...groups].join(', ')}`);
