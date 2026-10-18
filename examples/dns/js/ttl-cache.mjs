// The correct version: a cache that keeps each answer exactly as long as its TTL allows,
// including negative answers ("no such name"), whose lifetime comes from the zone's SOA (RFC 2308).
//
// Run: node ttl-cache.mjs   (about 10 seconds; starts its own toy DNS server)
import { setTimeout as sleep } from 'node:timers/promises';
import * as w from './dnswire.mjs';
import { API, DNS, NEW, OLD, migrate, retireOld, start } from './demo.mjs';

class NameNotFound extends Error {}

class CachingResolver {
  cache = new Map(); // "name|type" -> { addresses, rcode, expires }
  hits = 0;
  misses = 0;

  constructor(server) {
    this.server = server;
  }

  async resolve(name, type = 'A') {
    const key = `${name.toLowerCase()}|${type}`;
    let entry = this.cache.get(key);
    if (entry && performance.now() < entry.expires) {
      this.hits++;
    } else {
      this.misses++;
      entry = await this.ask(name, type);
      this.cache.set(key, entry);
    }
    if (!entry.addresses.length) {
      throw new NameNotFound(`${entry.rcode}, cached for ${((entry.expires - performance.now()) / 1000).toFixed(1)} s more`);
    }
    return entry.addresses;
  }

  async ask(name, type) {
    const { query } = w.buildQuery(name, type);
    const reply = w.parseMessage(await w.askUdp(...this.server, query));
    const now = performance.now();
    // Follow any CNAMEs in the answer; the chain is only as fresh as its shortest-lived link.
    const records = reply.answer.filter((r) => r.type === type || r.type === 'CNAME');
    const addresses = records.filter((r) => r.type === type).map((r) => r.value);
    if (reply.rcode === 'NOERROR' && addresses.length) {
      return { addresses, rcode: 'NOERROR', expires: now + Math.min(...records.map((r) => r.ttl)) * 1000 };
    }
    // NXDOMAIN (no such name) or NODATA (name exists, no records of this type).
    // Negative TTL = the smaller of the SOA record's TTL and its MINIMUM field (RFC 2308).
    const soa = reply.authority.find((r) => r.type === 'SOA');
    const negativeTtl = soa ? Math.min(soa.ttl, soa.data.minimum) : 0; // no SOA: do not cache
    return { addresses: [], rcode: reply.rcode === 'NOERROR' ? 'NODATA' : reply.rcode, expires: now + negativeTtl * 1000 };
  }
}

const ttl = 2;
const { zone, server, fleet, clock } = await start(ttl);
const resolver = new CachingResolver(DNS);

console.log('Part 1: the same move as before, with a cache that respects the TTL\n');
for (let i = 0; i < 10; i++) {
  await clock.sleepUntil(i * 0.45);
  if (i === 2) migrate(zone, fleet, clock, ttl);
  if (i === 8) retireOld(fleet, clock);
  const [address] = await resolver.resolve(API);
  const tag = address === OLD ? 'old' : address === NEW ? 'new' : '?';
  console.log(`${clock.stamp()}  request ${String(i + 1).padStart(2)} -> ${address.padEnd(14)} (${tag}) ${fleet.call(address)}`);
}
console.log(`\n10 requests, ${resolver.misses} DNS lookups, ${resolver.hits} answered from the cache.\n`);

console.log('Part 2: asking for a name before it exists (negative caching)\n');
const beta = 'beta.shop.example.test.';
const lookup = async (prefix = '') => {
  try {
    console.log(`${clock.stamp()}  lookup ${beta}: ${(await resolver.resolve(beta))[0]}`);
  } catch (err) {
    if (!(err instanceof NameNotFound)) throw err;
    console.log(`${clock.stamp()}  lookup ${beta}: ${prefix}${err.message}`);
  }
};
await lookup();
zone.set(beta, 'A', ['198.51.100.30'], 60);
console.log(`${clock.stamp()}  operator: created ${beta} -> 198.51.100.30`);
for (let i = 0; i < 4; i++) {
  await sleep(1500);
  await lookup('still ');
}
server.close();
