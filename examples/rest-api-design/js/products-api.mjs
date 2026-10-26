// A small products and payments API that gets the failure cases right, plus a demo client.
//
// - GET returns an ETag, the product's version.
// - PUT with If-Match only writes if the version is unchanged (412 if not). PUT without If-Match is
//   allowed here so the demo can show the lost update it causes.
// - PATCH takes a JSON Merge Patch (RFC 7396): only the fields sent change.
// - POST /payments honours an Idempotency-Key: the first result is stored and replayed.
// - Errors are Problem Details (RFC 9457).
//
// Run: node products-api.mjs

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = 8092;
const products = { 42: { name: 'Kettle', price: 1499, stock: 10 } };
const versions = { 42: 1 };
const idempotency = new Map(); // key -> { fingerprint, status, body }
let paymentIds = 0;
// Node runs one handler at a time on one thread, and nothing below awaits between the check and
// the write, so each check-and-write is one step (the Python version needs a lock for this).

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const id = req.url.replace('/products/', '');

  if (req.method === 'GET') {
    if (!products[id]) return problem(res, 404, 'not-found', 'No such product');
    return reply(res, 200, products[id], { ETag: `"v${versions[id]}"` });
  }

  if (req.method === 'PUT') {
    const current = `"v${versions[id]}"`;
    const sent = req.headers['if-match'];
    if (sent !== undefined && sent !== current) {
      return problem(res, 412, 'stale-version', 'The product changed since you read it',
        `You sent If-Match ${sent}; the current ETag is ${current}.`);
    }
    products[id] = body;
    versions[id]++;
    return reply(res, 200, body, { ETag: `"v${versions[id]}"` });
  }

  if (req.method === 'PATCH') {
    if (req.headers['content-type'] !== 'application/merge-patch+json') {
      return problem(res, 415, 'unsupported-patch', 'Send application/merge-patch+json');
    }
    for (const [field, value] of Object.entries(body)) {
      if (value === null) delete products[id][field]; // merge patch: null means remove
      else products[id][field] = value;
    }
    versions[id]++;
    return reply(res, 200, products[id], { ETag: `"v${versions[id]}"` });
  }

  if (req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    const fingerprint = JSON.stringify(body, Object.keys(body).sort());
    if (key && idempotency.has(key)) {
      const seen = idempotency.get(key);
      if (seen.fingerprint !== fingerprint) { // same key, different request: a client bug
        return problem(res, 422, 'key-reused', 'Idempotency-Key reused with a different body');
      }
      return reply(res, seen.status, seen.body, { 'Idempotent-Replayed': 'true' }); // no second charge
    }
    const payment = { id: `pay_${String(++paymentIds).padStart(4, '0')}`, amount: body.amount, status: 'charged' };
    if (key) idempotency.set(key, { fingerprint, status: 201, body: payment });
    return reply(res, 201, payment);
  }
});

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function problem(res, status, kind, title, detail) {
  const body = { type: `https://api.example.in/problems/${kind}`, title, status, ...(detail && { detail }) };
  res.writeHead(status, { 'Content-Type': 'application/problem+json' }).end(JSON.stringify(body));
}

async function call(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return [r.status, r.headers, await r.json()];
}

const show = async () => JSON.stringify((await call('GET', '/products/42'))[2]);

await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

console.log('1. Lost update: two editors, blind PUT');
let [, , asha] = await call('GET', '/products/42');
let [, , ravi] = await call('GET', '/products/42');
let [s1] = await call('PUT', '/products/42', { ...asha, price: 1299 });
let [s2] = await call('PUT', '/products/42', { ...ravi, stock: 9 });
console.log(`   Asha PUT price=1299 -> ${s1}, Ravi PUT stock=9 -> ${s2}`);
console.log(`   product now: ${await show()}   <- Asha's price is gone`);

console.log('2. The same edits with If-Match');
let h;
[, h, asha] = await call('GET', '/products/42');
const ashaEtag = h.get('etag');
[, h, ravi] = await call('GET', '/products/42');
const raviEtag = h.get('etag');
[s1] = await call('PUT', '/products/42', { ...asha, price: 1299 }, { 'If-Match': ashaEtag });
const [s2b, h2, prob] = await call('PUT', '/products/42', { ...ravi, stock: 9 }, { 'If-Match': raviEtag });
console.log(`   Asha PUT If-Match ${ashaEtag} -> ${s1}; Ravi PUT If-Match ${raviEtag} -> ${s2b} ${h2.get('content-type')}`);
console.log(`   ${prob.title}: ${prob.detail}`);
const [, hf, fresh] = await call('GET', '/products/42');
const [s3] = await call('PUT', '/products/42', { ...fresh, stock: 9 }, { 'If-Match': hf.get('etag') });
console.log(`   Ravi re-reads and retries -> ${s3}; product now: ${await show()}`);

console.log('3. Merge PATCH: each editor sends only its field');
await call('PATCH', '/products/42', { price: 1199 }, { 'Content-Type': 'application/merge-patch+json' });
await call('PATCH', '/products/42', { stock: 8 }, { 'Content-Type': 'application/merge-patch+json' });
console.log(`   product now: ${await show()}   <- both kept`);

console.log('4. POST /payments, the response is lost and the client retries');
const first = (await call('POST', '/payments', { amount: 1199 }))[2]; // pretend this response never arrived
const second = (await call('POST', '/payments', { amount: 1199 }))[2];
console.log(`   no key:   ${first.id} and ${second.id} -> charged twice`);
const key = randomUUID();
const a = await call('POST', '/payments', { amount: 1199 }, { 'Idempotency-Key': key });
const b = await call('POST', '/payments', { amount: 1199 }, { 'Idempotency-Key': key });
console.log(`   with key: ${a[2].id} and ${b[2].id} (replayed: ${b[1].get('idempotent-replayed')}) -> charged once`);
const c = await call('POST', '/payments', { amount: 9999 }, { 'Idempotency-Key': key });
console.log(`   same key, different amount -> ${c[0]} ${c[2].title}`);
server.close();
