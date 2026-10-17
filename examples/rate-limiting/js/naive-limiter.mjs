// The rate limiter most of us write first, and four ways it lets the wrong traffic through.
//
// No dependencies. Nothing here touches the network: the demos call the limiter directly,
// so the run is instant and gives the same numbers every time.
//
// Run:  node naive-limiter.mjs
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const LIMIT = 10;
const WINDOW = 10; // 10 requests per 10 seconds

/** A Map of counters in this process's memory, keyed by client and window number. */
export class NaiveLimiter {
  counts = new Map(); // never cleaned up: it grows forever

  allow(client, now) {
    const key = `${client}:${Math.floor(now / WINDOW)}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= LIMIT;
  }
}

const limiter = new NaiveLimiter();

// How it usually gets wired in: keyed on the address of whoever opened the connection.
export const server = createServer((req, res) => {
  if (!limiter.allow(req.socket.remoteAddress, Date.now() / 1000)) {
    res.writeHead(429).end();
    return;
  }
  res.writeHead(200).end('ok\n');
});

function demoBoundary() {
  const lim = new NaiveLimiter();
  let passed = 0;
  for (let i = 0; i < 10; i++) passed += lim.allow('203.0.113.7', 9.9);
  for (let i = 0; i < 10; i++) passed += lim.allow('203.0.113.7', 10.0);
  console.log(`1. window boundary: ${passed} of 20 accepted within 0.1 s (limit is ${LIMIT} per ${WINDOW} s)`);
}

function demoFourServers() {
  const servers = Array.from({ length: 4 }, () => new NaiveLimiter()); // four copies behind a load balancer
  let passed = 0;
  for (let i = 0; i < 40; i++) passed += servers[i % 4].allow('203.0.113.7', 1.0); // round robin
  console.log(`2. four servers:    ${passed} of 40 accepted in one window (each server counted alone)`);
}

function demoBehindProxy() {
  const lim = new NaiveLimiter();
  const loadBalancerIp = '10.0.0.5'; // what remoteAddress shows when a proxy opened the connection
  const results = {};
  for (const user of ['asha', 'ben', 'chen']) {
    results[user] = 0;
    for (let i = 0; i < 5; i++) results[user] += lim.allow(loadBalancerIp, 1.0);
  }
  const shown = Object.entries(results).map(([user, n]) => `${user} ${n}/5`).join(', ');
  console.log(`3. behind a proxy:  accepted ${shown} - three users share one counter`);
}

/** A shared counter store with a network round trip on every call, like Redis over a LAN. */
class SlowStore {
  data = new Map();
  async get(key) {
    await sleep(5);
    return this.data.get(key) ?? 0;
  }
  async set(key, value) {
    await sleep(5);
    this.data.set(key, value);
  }
}

async function demoRace() {
  const store = new SlowStore();
  let accepted = 0;
  async function handleRequest() {
    const count = await store.get('203.0.113.7:0'); // check...
    if (count < LIMIT) {
      await store.set('203.0.113.7:0', count + 1); // ...then act: others read the same count
      accepted++;
    }
  }
  // Twenty requests arrive at the same moment. One thread, but the awaits interleave them.
  await Promise.all(Array.from({ length: 20 }, handleRequest));
  console.log(`4. shared store:    ${accepted} of 20 accepted, and the stored count says ${store.data.get('203.0.113.7:0')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  demoBoundary();
  demoFourServers();
  demoBehindProxy();
  await demoRace();
}
