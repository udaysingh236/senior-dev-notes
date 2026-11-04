// DPoP (RFC 9449) from scratch: a client that signs proofs and a resource server that checks them.
//
// Run: node dpop.mjs   (Node 20+, standard library only)
//
// Time is passed in explicitly (`now`, in seconds) so the experiments can jump the clock without sleeping.

import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual, verify } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64json = (obj) => b64url(JSON.stringify(obj));
const sha256b64 = (text) => b64url(createHash('sha256').update(text, 'ascii').digest());

// ---------------------------------------------------------------- keys and thumbprints

const REQUIRED_MEMBERS = { EC: ['crv', 'kty', 'x', 'y'], RSA: ['e', 'kty', 'n'], OKP: ['crv', 'kty', 'x'] };

/** RFC 7638: required members only, sorted, no whitespace, SHA-256, base64url. */
export function jwkThumbprint(jwk) {
  const canonical = JSON.stringify(Object.fromEntries(REQUIRED_MEMBERS[jwk.kty].map((k) => [k, jwk[k]])));
  return b64url(createHash('sha256').update(canonical).digest());
}

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return { privateKey, jwk: { kty, crv, x, y } };
}

// ---------------------------------------------------------------- the client side

/** One DPoP proof: a JWT signed with the client's private key, valid for one request. */
export function makeProof(key, htm, htu, { now, accessToken, nonce, iat } = {}) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk };
  const claims = { jti: randomUUID(), htm, htu, iat: Math.floor(iat ?? now) };
  if (accessToken) claims.ath = sha256b64(accessToken); // ties this proof to this one token
  if (nonce) claims.nonce = nonce; // proves the proof was made after the server said this
  const signingInput = `${b64json(header)}.${b64json(claims)}`;
  const sig = sign('sha256', Buffer.from(signingInput), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- the server side

class Rejected extends Error {}

/** Remembers proofs seen in the last `ttl` seconds. Share one across nodes (Redis SET NX EX). */
export class JtiStore {
  seen = new Map();

  firstUse(htu, jti, now, ttl) {
    if (jti.length > 64) throw new Rejected('jti too long'); // the spec warns about memory exhaustion
    if (this.seen.size > 10_000) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k); // Redis expires keys itself
    }
    const key = createHash('sha256').update(`${htu} ${jti}`).digest('hex');
    if ((this.seen.get(key) ?? 0) > now) return false;
    this.seen.set(key, now + ttl);
    return true;
  }
}

/** Stateless nonces: a time bucket plus an HMAC. Nothing to store, and it carries server time. */
export class NonceIssuer {
  constructor(every = 60, secret = randomBytes(32)) {
    Object.assign(this, { every, secret });
  }

  #make(bucket) {
    const raw = Buffer.alloc(8);
    raw.writeBigUInt64BE(BigInt(bucket));
    return b64url(Buffer.concat([raw, createHmac('sha256', this.secret).update(raw).digest().subarray(0, 16)]));
  }

  current(now) {
    return this.#make(Math.floor(now / this.every));
  }

  valid(nonce, now) {
    const bucket = Math.floor(now / this.every);
    return [bucket, bucket - 1].some((b) => {
      const expected = Buffer.from(this.#make(b));
      const got = Buffer.from(nonce ?? '');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  }
}

const MAX_AGE = 60; // seconds a proof stays acceptable
const MAX_FUTURE = 5; // allowance for client clocks running ahead

/** The checks of RFC 9449 section 4.3. Returns the claims, or throws Rejected. */
export function checkProof(proof, { method, url, now, jtiStore, accessToken, boundJkt, nonces }) {
  const [h64, c64, s64] = proof.split('.');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h64, 'base64url'));
    claims = JSON.parse(Buffer.from(c64, 'base64url'));
  } catch {
    throw new Rejected('not a JWT');
  }
  if (header.typ !== 'dpop+jwt') throw new Rejected('typ is not dpop+jwt'); // stops other JWTs passing as proofs
  if (header.alg !== 'ES256') throw new Rejected('alg not allowed'); // never 'none', never HS256
  const jwk = header.jwk ?? {};
  if ('d' in jwk) throw new Rejected('jwk contains a private key');
  let ok = false;
  try {
    const pub = createPublicKey({ key: jwk, format: 'jwk' });
    ok = verify('sha256', Buffer.from(`${h64}.${c64}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64 ?? '', 'base64url'));
  } catch {}
  if (!ok) throw new Rejected('bad signature');
  if (!['jti', 'htm', 'htu', 'iat'].every((c) => c in claims)) throw new Rejected('missing claim');
  if (claims.htm !== method) throw new Rejected(`htm is ${claims.htm}, request is ${method}`);
  if (claims.htu !== url.split('?')[0].split('#')[0]) throw new Rejected(`htu is ${claims.htu}, request is ${url}`);
  if (nonces && !nonces.valid(claims.nonce, now)) throw new Rejected('use_dpop_nonce'); // send a fresh DPoP-Nonce
  if (!(claims.iat >= now - MAX_AGE && claims.iat <= now + MAX_FUTURE)) throw new Rejected('iat outside the window');
  if (accessToken !== undefined) {
    if (claims.ath !== sha256b64(accessToken)) throw new Rejected('ath does not match the access token');
    if (jwkThumbprint(jwk) !== boundJkt) throw new Rejected("proof key does not match the token's cnf.jkt");
  }
  // Last, so failed proofs don't fill the store.
  if (!jtiStore.firstUse(claims.htu, claims.jti, now, MAX_AGE + MAX_FUTURE)) throw new Rejected('jti already used');
  return claims;
}

// ---------------------------------------------------------------- a toy resource server

// What the authorization server issued. A JWT access token would carry these as claims;
// here the token is opaque and the server looks it up, as with token introspection.
const TOKENS = new Map();

function authorize(headers, method, url, now, { jtiStore, nonces, legacyBearerOnly = false }) {
  const [scheme, token] = (headers.Authorization ?? '').split(' ');
  const info = TOKENS.get(token);
  if (!info || now >= info.exp) throw new Rejected('invalid_token');
  if (legacyBearerOnly) return '200 OK'; // a server written before DPoP: it never looks at cnf
  const jkt = info.cnf?.jkt;
  if (jkt && scheme !== 'DPoP') throw new Rejected('DPoP-bound token sent as Bearer'); // the downgrade check
  if (scheme === 'DPoP') {
    if (!headers.DPoP) throw new Rejected('no DPoP proof');
    checkProof(headers.DPoP, { method, url, now, jtiStore, accessToken: token, boundJkt: jkt, nonces });
  }
  return '200 OK';
}

function attempt(label, ...args) {
  let result;
  try {
    result = authorize(...args);
  } catch (err) {
    if (!(err instanceof Rejected)) throw err;
    result = `rejected: ${err.message}`;
  }
  console.log(`   ${label.padEnd(46)} ${result}`);
}

console.log('0. RFC example values, recomputed');
const rfcEc = { kty: 'EC', x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs', y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA', crv: 'P-256' };
const rfcRsa = {
  kty: 'RSA',
  e: 'AQAB',
  n:
    '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMs' +
    'tn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajr' +
    'n1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
};
console.log(`   jkt of the RFC 9449 example key   ${jwkThumbprint(rfcEc)}`);
console.log(`   jkt of the RFC 7638 example key   ${jwkThumbprint(rfcRsa)}`);
console.log(`   ath of the RFC 9449 example token ${sha256b64('Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU')}`);

const t0 = 1_800_000_000;
const api = 'https://api.example.com/orders';
const clientKey = newKey();
const thiefKey = newKey();

console.log('\n1. A token copied from a log file, used from another machine');
TOKENS.set('bearer-tok', { exp: t0 + 600 });
TOKENS.set('dpop-tok', { exp: t0 + 600, cnf: { jkt: jwkThumbprint(clientKey.jwk) } });
let store = new JtiStore();
attempt('bearer token, no proof', { Authorization: 'Bearer bearer-tok' }, 'GET', api, t0, { jtiStore: store });
attempt('DPoP token, no proof', { Authorization: 'DPoP dpop-tok' }, 'GET', api, t0, { jtiStore: store });
const own = makeProof(thiefKey, 'GET', api, { now: t0, accessToken: 'dpop-tok' });
attempt("DPoP token, proof signed with thief's key", { Authorization: 'DPoP dpop-tok', DPoP: own }, 'GET', api, t0, { jtiStore: store });
attempt('DPoP token sent as Bearer', { Authorization: 'Bearer dpop-tok' }, 'GET', api, t0, { jtiStore: store });
attempt('same, to a server that predates DPoP', { Authorization: 'Bearer dpop-tok' }, 'GET', api, t0, { jtiStore: store, legacyBearerOnly: true });

console.log('\n2. One real request captured with its proof, then replayed');
const req = { Authorization: 'DPoP dpop-tok', DPoP: makeProof(clientKey, 'GET', api, { now: t0, accessToken: 'dpop-tok' }) };
attempt('the real request', req, 'GET', api, t0, { jtiStore: store });
attempt('replayed 2 s later', req, 'GET', api, t0 + 2, { jtiStore: store });
attempt('replayed as DELETE /orders/7', req, 'DELETE', `${api}/7`, t0 + 2, { jtiStore: store });
const nodes = Array.from({ length: 4 }, () => new JtiStore()); // four servers, each with its own memory
authorize(req, 'GET', api, t0, { jtiStore: nodes[0] }); // the real request reached node 0
let accepted = 0;
nodes.forEach((node, i) => { // the balancer spreads the replays over all four
  try {
    authorize(req, 'GET', api, t0 + 3 + i, { jtiStore: node });
    accepted++;
  } catch {}
});
console.log(`   ${'replayed to 4 nodes, each with its own cache'.padEnd(46)} ${accepted} of 4 accepted`);
attempt('replayed 61 s later', req, 'GET', api, t0 + 61, { jtiStore: new JtiStore() });

console.log('\n3. Script injected into the page signs 20 proofs for the next 10 minutes, then leaves');
TOKENS.get('dpop-tok').exp = t0 + 300; // a 5-minute access token
for (const [label, nonces] of [['no server nonce', null], ['nonce, rotated every 60 s', new NonceIssuer(60)]]) {
  const nonce = nonces?.current(t0);
  const stash = Array.from({ length: 20 }, (_, k) => makeProof(clientKey, 'GET', api, { now: t0, accessToken: 'dpop-tok', nonce, iat: t0 + 30 * k }));
  const s = new JtiStore();
  let ok = 0;
  let last = null;
  stash.forEach((p, k) => { // the attacker uses each proof when its iat comes round
    try {
      authorize({ Authorization: 'DPoP dpop-tok', DPoP: p }, 'GET', api, t0 + 30 * k, { jtiStore: s, nonces });
      ok++;
      last = 30 * k;
    } catch {}
  });
  console.log(`   ${label.padEnd(46)} ${ok} of 20 accepted${ok ? `, the last at t+${last} s` : ''}`);
}

console.log('\n4. TLS ends at the load balancer; the app rebuilds the URL from what it sees');
store = new JtiStore();
const proof = makeProof(clientKey, 'GET', api, { now: t0, accessToken: 'dpop-tok' });
const seenByApp = 'http://10.0.3.7:8080/orders';
attempt('URL from the socket', { Authorization: 'DPoP dpop-tok', DPoP: proof }, 'GET', seenByApp, t0, { jtiStore: store });
const external = `https://api.example.com${new URL(seenByApp).pathname}`; // from the configured public origin
attempt('URL from the configured public origin', { Authorization: 'DPoP dpop-tok', DPoP: proof }, 'GET', external, t0, { jtiStore: store });

console.log('\n5. What it costs');
const n = 2000;
let start = performance.now();
const proofs = Array.from({ length: n }, () => makeProof(clientKey, 'GET', api, { now: t0, accessToken: 'dpop-tok' }));
const signUs = ((performance.now() - start) / n) * 1000;
store = new JtiStore();
start = performance.now();
for (const p of proofs) checkProof(p, { method: 'GET', url: api, now: t0, jtiStore: store });
const verifyUs = ((performance.now() - start) / n) * 1000;
console.log(`   make a proof ${signUs.toFixed(0)} µs, check one ${verifyUs.toFixed(0)} µs, ${proofs[0].length} bytes in the DPoP header`);
