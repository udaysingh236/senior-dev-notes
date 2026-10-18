// The production-shaped version: what a careful client library or sidecar cache does.
//   - several upstream resolvers, each with a short timeout, tried in turn
//   - answers checked against the question we asked (ID and name), so a stray packet is not believed
//   - TCP when the UDP answer comes back truncated (TC bit)
//   - TTLs clamped to a floor and a ceiling we choose
//   - serve-stale (RFC 8767): if every upstream fails, keep using the last good answer for a while
//
// Run: node resilient-resolver.mjs   (about 5 seconds; starts its own toy DNS server)
import { setTimeout as sleep } from 'node:timers/promises';
import * as w from './dnswire.mjs';
import { API, start } from './demo.mjs';

const TIMEOUT = 400; // ms per attempt; resolvers on a LAN answer in a few ms
const [MIN_TTL, MAX_TTL] = [1, 300];
const MAX_STALE = 3600; // s we are willing to use an expired answer if nobody answers (1-3 days in RFC 8767)
const STALE_TTL = 30; // s a stale answer is good for before we try the upstreams again

class LookupFailed extends Error {}

class ResilientResolver {
  cache = new Map(); // "name|type" -> { values, expires, staleUntil } (ms, performance.now())

  constructor(upstreams) {
    this.upstreams = upstreams;
  }

  async resolve(name, type = 'A') {
    const key = `${name.toLowerCase()}|${type}`;
    const now = performance.now();
    const entry = this.cache.get(key);
    if (entry && now < entry.expires) return entry.values;
    let values, ttl;
    try {
      [values, ttl] = await this.askUpstreams(name, type);
    } catch (err) {
      if (err instanceof LookupFailed && entry && now < entry.staleUntil) { // serve stale: an old answer beats no answer
        entry.expires = now + STALE_TTL * 1000;
        console.log(`    ! every upstream failed (${err.message}); serving the expired answer for ${STALE_TTL} s`);
        return entry.values;
      }
      throw err;
    }
    ttl = Math.max(MIN_TTL, Math.min(MAX_TTL, ttl));
    this.cache.set(key, { values, expires: now + ttl * 1000, staleUntil: now + (ttl + MAX_STALE) * 1000 });
    return values;
  }

  async askUpstreams(name, type) {
    const errors = [];
    for (const [host, port] of this.upstreams) {
      let reply;
      try {
        reply = await this.exchange(host, port, name, type);
      } catch (err) {
        errors.push(`${host}:${port} ${err.code ?? err.message}`);
        continue;
      }
      if (reply.rcode === 'SERVFAIL') { // this resolver could not get an answer; another might
        errors.push(`${host}:${port} SERVFAIL`);
        continue;
      }
      if (reply.rcode !== 'NOERROR') throw new LookupFailed(`${name}: ${reply.rcode}`); // a real "no" is not retried
      const records = reply.answer.filter((r) => r.type === type || r.type === 'CNAME');
      const values = records.filter((r) => r.type === type).map((r) => r.value);
      if (!values.length) throw new LookupFailed(`${name}: no ${type} records`);
      return [values, Math.min(...records.map((r) => r.ttl))];
    }
    throw new LookupFailed(errors.join('; '));
  }

  async exchange(host, port, name, type) {
    const { id, query } = w.buildQuery(name, type);
    let reply = w.parseMessage(await w.askUdp(host, port, query, TIMEOUT));
    if (reply.tc) { // too big for UDP: same question again over TCP
      console.log(`    UDP answer from ${host}:${port} was truncated (${reply.size} bytes, TC=1); retrying over TCP`);
      reply = w.parseMessage(await w.askTcp(host, port, query, TIMEOUT));
      console.log(`    TCP answer: ${reply.size} bytes, ${reply.answer.length} records`);
    }
    const [qname, qtype] = reply.question[0] ?? [];
    if (reply.id !== id || qname !== name.toLowerCase() || qtype !== type) {
      throw new Error('answer does not match the question'); // possible spoofing
    }
    return reply;
  }
}

const { zone, server, clock } = await start(2);
const dead = ['127.0.0.1', 5399]; // nothing listens here: the first upstream is "down"
const resolver = new ResilientResolver([dead, ['127.0.0.1', 8053]]);

console.log(`${clock.stamp()}  1. the first upstream is down; the second answers`);
let t = performance.now();
const first = await resolver.resolve(API);
console.log(`         ${API} -> ${JSON.stringify(first)}  in ${(performance.now() - t).toFixed(0)} ms`);

console.log(`${clock.stamp()}  2. an answer too big for UDP`);
const txt = await resolver.resolve('big.shop.example.test.', 'TXT');
console.log(`         got ${txt.length} TXT strings, ${txt.reduce((n, s) => n + s.length, 0)} characters`);

console.log(`${clock.stamp()}  3. the authoritative server goes down; the cached answer expires`);
zone.down = true;
await sleep(2200);
const addresses = await resolver.resolve(API);
console.log(`${clock.stamp()}     ${API} -> ${JSON.stringify(addresses)}`);

console.log(`${clock.stamp()}  4. a name we never cached, while everything is down`);
try {
  await resolver.resolve('new.shop.example.test.');
} catch (err) {
  console.log(`         failed, nothing stale to fall back on: ${err.message}`);
}
server.close();
