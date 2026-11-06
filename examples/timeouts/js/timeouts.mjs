// Timeouts: what a socket timeout really bounds, a total deadline, and deadlines passed between services.
//
// Standard library only (Node 20+). Starts one small HTTP server on localhost with:
//   /drip             answers at once, then sends its 20-byte body one byte a second
//   /silent           sends nothing for 6 s, then answers
//   /report           a handler that does 2 s of work in 10 steps and ignores the caller
//   /report-deadline  the same handler, reading the caller's deadline from a header
//
//   node timeouts.mjs
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const DRIP_BYTES = 20, DRIP_GAP_MS = 1000; // always under the client's timeout
const STEPS = 10, STEP_MS = 200; // the report takes 2 s of work
let started = performance.now();
const say = (msg) => console.log(`   [${((performance.now() - started) / 1000).toFixed(1).padStart(5)}s] ${msg}`);

class DeadlineExceeded extends Error {}

/** fetch() that gives up when the deadline passes, or when the caller's own signal aborts. */
async function fetchWithDeadline(url, deadlineMs, { signal } = {}) {
  const remaining = Math.floor(deadlineMs - performance.now()); // AbortSignal.timeout wants whole ms
  if (remaining <= 0) throw new DeadlineExceeded('deadline already passed');
  // One signal for "my deadline" and "my caller gave up", whichever comes first.
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining);
  try {
    const res = await fetch(url, {
      signal: combined,
      headers: { 'x-request-timeout-ms': String(remaining) }, // so the server can stop when we stop
    });
    if (res.status === 504) throw new DeadlineExceeded('the server stopped: it would not finish in time');
    return await res.text(); // the same signal also bounds reading the body
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new DeadlineExceeded(`gave up at the deadline (${err.name})`);
    }
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/drip') {
    res.writeHead(200, { 'content-length': DRIP_BYTES });
    for (let i = 0; i < DRIP_BYTES; i++) {
      await sleep(DRIP_GAP_MS);
      if (res.destroyed) return; // the client hung up
      res.write('.');
    }
    return res.end();
  }
  if (req.url === '/silent') {
    await sleep(6000);
    return res.end('finally');
  }
  // /report ignores the caller; /report-deadline reads its deadline from the header.
  const budget = req.headers['x-request-timeout-ms'];
  const deadline = budget && req.url === '/report-deadline' ? performance.now() + Number(budget) : null;
  for (let step = 0; step < STEPS; step++) {
    if (deadline && deadline - performance.now() < STEP_MS) {
      say(`server: ${req.url} stopped after ${step} of ${STEPS} steps, the caller's deadline is near`);
      res.writeHead(504);
      return res.end('deadline exceeded');
    }
    await sleep(STEP_MS); // one step of real work: a query, a render, a call
  }
  say(`server: ${req.url} finished all ${STEPS} steps`);
  if (res.destroyed) say(`server: ${req.url} could not send the answer: the caller had gone`);
  else res.end('report');
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

/** http.get with the `timeout` option, and a 'timeout' handler that only logs, as many do. */
function httpGetWithTimeoutOption(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; }).on('end', () => resolve(body));
    });
    req.on('timeout', () => say(`http.get: 'timeout' event after ${timeout} ms of silence (the request goes on)`));
    req.on('error', reject);
  });
}

console.log(`1. A server that sends ${DRIP_BYTES} bytes, one every ${DRIP_GAP_MS / 1000} s. Client timeout: 3 s`);
started = performance.now();
say(`http.get({ timeout: 3000 }): got ${(await httpGetWithTimeoutOption(base + '/drip', 3000)).length} bytes, no 'timeout' event`);
started = performance.now();
say(`fetch() with no timeout: got ${(await (await fetch(base + '/drip')).text()).length} bytes`);
started = performance.now();
try {
  await fetchWithDeadline(base + '/drip', performance.now() + 3000);
} catch (err) {
  say(`fetchWithDeadline(3 s): ${err.message}`);
}

console.log('2. A server that is silent for 6 s. Client timeout option: 3 s');
started = performance.now();
say(`http.get({ timeout: 3000 }): got "${await httpGetWithTimeoutOption(base + '/silent', 3000)}"`);

console.log(`3. A handler that needs ${(STEPS * STEP_MS) / 1000} s. Client deadline: 0.5 s`);
for (const path of ['/report', '/report-deadline']) {
  started = performance.now();
  try {
    await fetchWithDeadline(base + path, performance.now() + 500);
  } catch (err) {
    say(`client: ${path}: ${err.message}`);
  }
  await sleep(STEPS * STEP_MS + 300); // let the server finish, or not, and report it
}
server.close();
server.closeAllConnections();
