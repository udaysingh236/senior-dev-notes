// Production-shaped rate limiting: a token bucket shared by every app server, kept in Redis.
//
// - Atomic: the read, the decision and the write happen inside one Lua script, so two servers
//   can never both spend the last token.
// - One clock: the script reads Redis's own TIME, so app servers with drifting clocks agree.
// - Fails open: if Redis is slow or down, we log it and let the request through.
// - Speaks HTTP: 429, Retry-After, and the IETF draft RateLimit / RateLimit-Policy fields.
//
// Needs Redis on localhost:6379 and the client library:  npm install
// Run:  node redis-limiter.mjs
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from 'redis';

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
  tokens = math.max(0, tokens - cost)
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
  constructor(client, capacity, rate) {
    Object.assign(this, { client, capacity, rate });
    this.sha = null;
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
      return { allowed: allowed === 1, tokens: Number(tokens), retryAfter: Number(retry) };
    } catch (err) {
      // Fail open: a broken limiter should not become a broken API. Alert on this log.
      console.warn(`WARNING ratelimit: rate limiter unavailable, allowing request: ${err.message}`);
      return { allowed: true, tokens: this.capacity, retryAfter: 0 };
    }
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

const TRUSTED_PROXIES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']); // YOUR load balancers only

/**
 * Who to count. An API key beats an IP. X-Forwarded-For is only believed when it was added
 * by our own proxy; anyone else can type whatever they like into that header.
 */
export function clientKey(peer, apiKey, forwardedFor) {
  if (apiKey) return `key:${apiKey}`;
  if (forwardedFor && TRUSTED_PROXIES.has(peer)) return `ip:${forwardedFor.split(',').at(-1).trim()}`;
  return `ip:${peer}`;
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

async function demoFailOpen() {
  // Nothing listens on 6390. Without disableOfflineQueue, commands would wait for a reconnect
  // forever and every request would hang instead of failing open.
  const dead = createClient({
    url: 'redis://localhost:6390',
    disableOfflineQueue: true,
    socket: { connectTimeout: 50, reconnectStrategy: false },
  });
  dead.on('error', () => {}); // connection errors are expected here
  await dead.connect().catch(() => {});
  const result = await new RedisTokenBucket(dead, 10, 2).tryAcquire('key:demo-key');
  console.log(`Redis down:         allowed=${result.allowed} (failed open, see the warning above)`);
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
await demoHttp(client);
await demoFailOpen();
await client.close();
