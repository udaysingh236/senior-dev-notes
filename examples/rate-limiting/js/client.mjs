// The other side of the contract: a client that behaves well when it is rate limited.
//
// Starts a tiny local API limited to a burst of 5 and 5 requests per second per API key, then
// sends it 30 requests three ways:
//   1. retry at once on 429 (what a buggy script does)
//   2. wait for Retry-After plus random jitter, backing off further each time
//   3. pace yourself with a client-side token bucket, a little under the limit
//
// No dependencies.  Run:  node client.mjs
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { TokenBucket } from './limiters.mjs';

/** One request. Returns the status and the Retry-After value in seconds, if any. */
async function get(url) {
  const res = await fetch(url, { headers: { 'X-Api-Key': 'k1' } });
  await res.arrayBuffer(); // drain the body so the connection can be reused
  const retryAfter = res.headers.get('retry-after');
  return { status: res.status, retryAfter: retryAfter === null ? null : Number(retryAfter) };
}

/** @returns {Promise<{ succeeded: boolean, attempts: number }>} */
async function getWithRetry(url, polite, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { status, retryAfter } = await get(url);
    if (status !== 429) return { succeeded: status === 200, attempts: attempt };
    if (polite) {
      const backoff = Math.min(8, 0.25 * 2 ** attempt); // grows each time: 0.5, 1, 2, 4, 8 s
      // Retry-After is the earliest the server wants us back; jitter spreads clients out
      // so they don't all return in the same millisecond.
      await sleep(((retryAfter ?? 0) + Math.random() * backoff) * 1000);
    }
  }
  return { succeeded: false, attempts };
}

/** A client-side token bucket that waits for a token instead of failing. */
class Pacer {
  constructor(rate, burst) {
    this.bucket = new TokenBucket(burst, rate);
  }

  async wait() {
    for (let d = this.bucket.tryAcquire(); !d.allowed; d = this.bucket.tryAcquire()) {
      await sleep(d.retryAfter * 1000);
    }
  }
}

async function run(name, url, { polite = false, pacer = null } = {}) {
  const started = performance.now();
  let ok = 0;
  let sent = 0;
  for (let i = 0; i < 30; i++) {
    if (pacer) await pacer.wait();
    const { succeeded, attempts } = await getWithRetry(url, polite);
    ok += succeeded;
    sent += attempts;
  }
  const took = ((performance.now() - started) / 1000).toFixed(1).padStart(4);
  console.log(`${name.padEnd(28)}${String(ok).padStart(3)}/30 ok  ${String(sent - ok).padStart(3)} rejected  ${String(sent).padStart(3)} requests sent  ${took} s`);
}

function startApi() {
  // One bucket per API key. Node runs handlers one at a time, so no lock is needed here.
  const buckets = new Map();
  const server = createServer((req, res) => {
    const key = req.headers['x-api-key'];
    if (!buckets.has(key)) buckets.set(key, new TokenBucket(5, 5));
    const d = buckets.get(key).tryAcquire();
    if (d.allowed) res.writeHead(200).end();
    else res.writeHead(429, { 'Retry-After': String(Math.ceil(d.retryAfter)) }).end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/orders` })),
  );
}

const { server, url } = await startApi();
await run('1. retry at once', url);
await sleep(1500); // let the server's bucket refill between strategies
await run('2. Retry-After + jitter', url, { polite: true });
await sleep(1500);
await run('3. client-side bucket 4.5/s', url, { pacer: new Pacer(4.5, 5) });
server.close();
