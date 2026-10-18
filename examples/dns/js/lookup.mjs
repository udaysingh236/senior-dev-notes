// Ask real resolvers real questions, like a tiny `dig`. Needs an internet connection.
//   node lookup.mjs                  # a tour of record types, then the same question over DoH
//   node lookup.mjs github.com MX    # one question
import * as w from './dnswire.mjs';

const RESOLVER = '1.1.1.1'; // Cloudflare's public resolver; 8.8.8.8 (Google) or 9.9.9.9 (Quad9) work too
const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'];

const TOUR = [
  ['example.com', 'A'], ['example.com', 'AAAA'], ['www.github.com', 'A'], ['gmail.com', 'MX'],
  ['google.com', 'CAA'], ['cloudflare.com', 'HTTPS'], ['example.com', 'NS'], ['example.com', 'SOA'],
  ['no-such-name.example.com', 'A'], ['example.com', 'MX'],
];

function show(reply, name, type, ms, via) {
  const flags = ['aa', 'tc', 'rd', 'ra'].filter((f) => reply[f]).join(' ');
  console.log(`${name} ${type} via ${via}: ${reply.rcode} [${flags}] ${reply.size} bytes in ${ms.toFixed(0)} ms`);
  for (const r of reply.answer) {
    console.log(`    ${r.name.padEnd(26)} ${String(r.ttl).padStart(6)}  ${r.type.padEnd(6)} ${r.value.slice(0, 90)}`);
  }
  if (!reply.answer.length) {
    const soa = reply.authority.find((r) => r.type === 'SOA');
    if (soa) console.log(`    (no answer; the SOA says: cache this 'no' for ${Math.min(soa.ttl, soa.data.minimum)} s)`);
  }
}

async function ask(name, type) {
  const { query } = w.buildQuery(name, type);
  const t = performance.now();
  const reply = w.parseMessage(await w.askUdp(RESOLVER, 53, query));
  show(reply, name, type, performance.now() - t, `UDP ${RESOLVER}`);
}

/** DNS over HTTPS (RFC 8484): the same binary message, POSTed over HTTPS. ID 0 for cacheability. */
async function askDoh(url, name, type) {
  const { query } = w.buildQuery(name, type, { id: 0 });
  const t = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
    body: query,
    signal: AbortSignal.timeout(5000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  show(w.parseMessage(body), name, type, performance.now() - t, `DoH ${new URL(url).host}`);
}

if (process.argv.length === 4) {
  await ask(process.argv[2], process.argv[3].toUpperCase());
} else {
  for (const [name, type] of TOUR) {
    await ask(name, type);
    console.log();
  }
  console.log('The same question three ways; fetch keeps HTTPS connections open, so a second DoH query is cheaper:');
  await ask('example.com', 'A');
  for (const url of DOH) await askDoh(url, 'example.com', 'A');
  await askDoh(DOH[0], 'example.com', 'A');
}
