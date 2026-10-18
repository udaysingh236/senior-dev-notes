// Two naive ways to use DNS, and how each one breaks.
//   1. Resolve once at startup and keep the address for ever.
//   2. Resolve before every single request, with no cache.
//
// Run: node naive-client.mjs   (about 5 seconds; starts its own toy DNS server)
import * as w from './dnswire.mjs';
import { API, DNS, migrate, retireOld, start } from './demo.mjs';

/** Ask the DNS server directly; return the first address and its TTL. */
async function resolve(name) {
  const { query } = w.buildQuery(name, 'A');
  const reply = w.parseMessage(await w.askUdp(...DNS, query));
  const record = reply.answer.find((r) => r.type === 'A');
  return [record.value, record.ttl];
}

/** Naive 1: look the name up when the process starts, then never again. */
class ResolveOnceClient {
  static async create() {
    const client = new ResolveOnceClient();
    const [address, ttl] = await resolve(API); // the TTL is right here, and we throw it away
    client.address = address;
    console.log(`t=0.0s  [ once] startup: ${API} -> ${address} (TTL ${ttl} s, ignored)`);
    return client;
  }
  async addressForRequest() {
    return this.address;
  }
}

/** Naive 2: ask DNS before every request. Always fresh, and a lookup on every request. */
class ResolveEveryTimeClient {
  lookups = 0;
  async addressForRequest() {
    this.lookups++;
    return (await resolve(API))[0];
  }
}

const ttl = 2;
const { zone, server, fleet, clock } = await start(ttl);
const once = await ResolveOnceClient.create();
const every = new ResolveEveryTimeClient();

for (let i = 0; i < 10; i++) { // one request from each client every 0.45 s
  await clock.sleepUntil(i * 0.45);
  if (i === 2) migrate(zone, fleet, clock, ttl);
  if (i === 8) retireOld(fleet, clock); // 2.7 s after the change: every cache that respects the TTL has moved
  for (const [label, client] of [['once', once], ['every', every]]) {
    const address = await client.addressForRequest();
    console.log(`${clock.stamp()}  [${label.padStart(5)}] request ${String(i + 1).padStart(2)} -> ${address.padEnd(14)} ${fleet.call(address)}`);
  }
}

console.log(`\nresolve-every-time made ${every.lookups} DNS lookups for 10 requests; the server answered ${zone.queries} queries in total.`);
console.log('At 2,000 requests per second, that is 2,000 DNS queries per second, all from one client.');
server.close();
