// Production-shaped rate limiting: a token bucket shared by every app server, kept in Redis.
//
// - Atomic: the read, the decision and the write happen inside one Lua script, so two servers
//   can never both spend the last token.
// - One clock: the script reads Redis's own TIME, so app servers with drifting clocks agree.
// - Decides what happens when Redis is slow or down: fail open, fail closed, or fall back to a
//   local bucket holding this node's share of the limit.
// - Counts cost, not requests: a call can take many tokens, and give back what it did not use.
// - Speaks HTTP: 429, Retry-After, and the IETF draft RateLimit / RateLimit-Policy fields.
//
// Needs Redis on localhost:6379 and the client library:  npm install
// Run:  node redis-limiter.mjs
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from 'redis';
import { TokenBucket } from './limiters.mjs';

const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])          -- tokens added per second
local cost     = tonumber(ARGV[3])
local t   = redis.call('TIME')              -- Redis's clock, not the app server's
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity   -- a new key starts with a full bucket
local ts     = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)

local allowed, retry_after = 0, 0
if tokens + 1e-9 >= cost then
  tokens = math.min(capacity, math.max(0, tokens - cost))   -- a negative cost is a refund
  allowed = 1
else
  retry_after = (cost - tokens) / rate
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Forget idle clients once their bucket would be full again anyway.
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 1000) + 1000)
return { allowed, tostring(tokens), tostring(retry_after) }   -- Lua numbers become integers
`;

export class RedisTokenBucket {
  /** @param {'open' | 'closed' | 'local'} whenDown */
  constructor(client, capacity, rate, whenDown = 'open', nodes = 1) {
    Object.assign(this, { client, capacity, rate, whenDown, nodes });
    this.sha = null;
    this.local = new Map(); // fallback buckets, used only while Redis is down
    this.down = false;
  }

  async #run(key, cost) {
    const options = { keys: [`rl:${key}`], arguments: [String(this.capacity), String(this.rate), String(cost)] };
    try {
      this.sha ??= await this.client.scriptLoad(TOKEN_BUCKET_LUA); // sent once, then run by hash
      return await this.client.evalSha(this.sha, options);
    } catch (err) {
      if (!String(err?.message).startsWith('NOSCRIPT')) throw err;
      this.sha = await this.client.scriptLoad(TOKEN_BUCKET_LUA); // Redis restarted and forgot it
      return this.client.evalSha(this.sha, options);
    }
  }

  /** @returns {Promise<{ allowed: boolean, tokens: number, retryAfter: number }>} */
  async tryAcquire(key, cost = 1) {
    try {
      const [allowed, tokens, retry] = await this.#run(key, cost);
      this.down = false;
      return { allowed: allowed === 1, tokens: Number(tokens), retryAfter: Number(retry) };
    } catch (err) {
      if (!this.down) console.warn(`WARNING ratelimit: rate limiter store unavailable, failing ${this.whenDown}: ${err.message}`);
      this.down = true; // log the transition once, not once per request
    }
    if (this.whenDown === 'closed') return { allowed: false, tokens: 0, retryAfter: 1 };
    if (this.whenDown === 'local') {
      // This node's share of the limit. Assumes the load balancer spreads clients evenly.
      if (!this.local.has(key)) this.local.set(key, new TokenBucket(Math.floor(this.capacity / this.nodes), this.rate / this.nodes));
      const d = this.local.get(key).tryAcquire(cost);
      return { allowed: d.allowed, tokens: d.remaining, retryAfter: d.retryAfter };
    }
    return { allowed: true, tokens: this.capacity, retryAfter: 0 }; // open: the API stays up, unprotected
  }

  headers(result) {
    const window = Math.ceil(this.capacity / this.rate);
    const fullIn = Math.ceil((this.capacity - result.tokens) / this.rate);
    const headers = {
      'RateLimit-Policy': `"default";q=${this.capacity};w=${window}`,
      RateLimit: `"default";r=${Math.floor(result.tokens)};t=${fullIn}`,
    };
    if (!result.allowed) headers['Retry-After'] = String(Math.max(1, Math.ceil(result.retryAfter)));
    return headers;
  }
}

// YOUR load balancers and CDN, nothing else. Real CDNs publish address ranges; check ranges then.
const TRUSTED_PROXIES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '198.51.100.2']);

/**
 * Who to count. An API key beats an IP. X-Forwarded-For is only believed when the connection
 * came from our own proxy, and only the entries our proxies appended.
 */
export function clientKey(peer, apiKey, forwardedFor) {
  if (apiKey) return `key:${apiKey}`;
  if (!TRUSTED_PROXIES.has(peer) || !forwardedFor) return `ip:${peer}`; // direct: the socket is the truth
  const hops = forwardedFor.split(',').map((hop) => hop.trim());
  // Right to left: the newest entries were added by our proxies. Take the first that is not ours.
  return `ip:${hops.findLast((hop) => !TRUSTED_PROXIES.has(hop)) ?? hops[0]}`;
}

export function makeServer(limiter) {
  return createServer(async (req, res) => {
    const key = clientKey(req.socket.remoteAddress, req.headers['x-api-key'], req.headers['x-forwarded-for']);
    const result = await limiter.tryAcquire(key);
    res.writeHead(result.allowed ? 200 : 429, limiter.headers(result));
    res.end(result.allowed ? 'ok\n' : 'slow down\n');
  });
}

// ----------------------------------------------------------------------------- demos

async function demoRace(client) {
  await client.del(['naive:203.0.113.7', 'rl:race']);
  let naiveOk = 0;
  async function naive() {
    const count = Number((await client.get('naive:203.0.113.7')) ?? 0); // check...
    await sleep(2); // the app does a little work in between
    if (count < 10) {
      await client.set('naive:203.0.113.7', String(count + 1)); // ...then act
      naiveOk++;
    }
  }
  await Promise.all(Array.from({ length: 20 }, naive));

  const limiter = new RedisTokenBucket(client, 10, 0.001); // almost no refill during the test
  const results = await Promise.all(Array.from({ length: 20 }, () => limiter.tryAcquire('race')));
  console.log(`race, GET then SET: ${naiveOk} of 20 accepted (limit 10)`);
  console.log(`race, Lua script:   ${results.filter((r) => r.allowed).length} of 20 accepted (limit 10)`);
}

function demoKeys() {
  const chain = '6.6.6.6, 203.0.113.7, 198.51.100.2'; // forged, real client, our CDN
  console.log(`key via LB:         ${clientKey('10.0.0.5', undefined, chain)}`);
  console.log(`key, direct caller: ${clientKey('203.0.113.9', undefined, '6.6.6.6')}`);
}

async function demoHttp(client) {
  await client.del('rl:key:demo-key');
  const limiter = new RedisTokenBucket(client, 10, 2); // burst of 10, then 2 per second
  const server = makeServer(limiter);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/products`;

  const statuses = [];
  let last;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(url, { headers: { 'X-Api-Key': 'demo-key' } });
    statuses.push(res.status);
    if (res.status === 429) last = res.headers;
    await res.arrayBuffer();
  }
  server.close();
  console.log(`12 quick requests:  [${statuses.join(', ')}]`);
  console.log(`the 429 said:       Retry-After: ${last.get('retry-after')}   RateLimit: ${last.get('ratelimit')}`);
  console.log(`                    RateLimit-Policy: ${last.get('ratelimit-policy')}`);
}

async function demoCost(client) {
  // Count cost, not requests: reserve the worst case up front, refund what was not used.
  await client.del('rl:tpm:demo-key');
  const tpm = new RedisTokenBucket(client, 10_000, 10_000 / 60); // 10,000 tokens a minute
  const first = await tpm.tryAcquire('tpm:demo-key', 4_000); // 1,000 prompt + max_tokens of 3,000
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  console.log(`cost: reserve 4,000 of 10,000  -> ${fmt(first.tokens)} left`);
  let big = await tpm.tryAcquire('tpm:demo-key', 7_000);
  console.log(`cost: a 7,000 call now         -> ${big.allowed ? 'allowed' : '429'}, retry in ${big.retryAfter.toFixed(1)} s`);
  const refund = await tpm.tryAcquire('tpm:demo-key', -2_400); // the reply used 600 of the 3,000
  big = await tpm.tryAcquire('tpm:demo-key', 7_000);
  console.log(`cost: refund the unused 2,400  -> ${fmt(refund.tokens)} left, the 7,000 call is ${big.allowed ? 'allowed' : 'rejected'}`);
}

/** Short timeouts, no offline queue, no reconnect loop: fail in milliseconds, not never. */
function fastFailClient(url) {
  const client = createClient({
    url,
    disableOfflineQueue: true, // without this, commands wait for a reconnect that may never come
    socket: { connectTimeout: 50, reconnectStrategy: false },
    commandOptions: { timeout: 100 },
  });
  client.on('error', () => {}); // connection errors are handled by the limiter
  return client;
}

async function demoStoreDown() {
  // The default client: it keeps reconnecting and queues commands until it succeeds.
  const patient = createClient({ url: 'redis://localhost:6390' }); // nothing listens on 6390
  patient.on('error', () => {});
  patient.connect().catch(() => {});
  const start = performance.now();
  const answer = await Promise.race([
    new RedisTokenBucket(patient, 10, 2).tryAcquire('key:demo-key').then((r) => `allowed=${r.allowed}`),
    sleep(3000).then(() => 'no answer'),
  ]);
  console.log(`Redis down, default client: ${answer} after ${((performance.now() - start) / 1000).toFixed(2)} s`);
  patient.destroy();

  const dead = fastFailClient('redis://localhost:6390');
  await dead.connect().catch(() => {});
  const t0 = performance.now();
  const r = await new RedisTokenBucket(dead, 10, 2).tryAcquire('key:demo-key');
  console.log(`Redis down, retries off:    allowed=${r.allowed} after ${((performance.now() - t0) / 1000).toFixed(2)} s`);

  console.log('Redis down, 12 quick requests from one key:');
  for (const mode of ['open', 'closed', 'local']) {
    const limiter = new RedisTokenBucket(dead, 10, 2, mode, 2);
    let allowed = 0;
    for (let i = 0; i < 12; i++) if ((await limiter.tryAcquire('key:demo-key')).allowed) allowed++;
    console.log(`  whenDown=${mode.padEnd(7)} ${String(allowed).padStart(2)} allowed`);
  }
}

const client = createClient({
  url: 'redis://localhost:6379',
  disableOfflineQueue: true, // fail fast while disconnected instead of queueing commands
  socket: { connectTimeout: 100 },
  commandOptions: { timeout: 100 }, // the limiter must never add more than a few ms to a request
});
client.on('error', (err) => console.warn(`redis: ${err.message}`));
await client.connect();
console.log(`connected to Redis ${(await client.info('server')).match(/redis_version:(\S+)/)[1]}`);
await demoRace(client);
demoKeys();
await demoHttp(client);
await demoCost(client);
await demoStoreDown();
await client.close();
