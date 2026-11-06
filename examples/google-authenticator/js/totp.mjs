// TOTP from scratch (RFC 4226 + RFC 6238), and three server-side verifiers.
//
// Node 20+, standard library only. Run: node totp.mjs
// Prints the same lines as ../python/totp.py. The clock is passed in as a number; nothing sleeps.

import { createHmac, timingSafeEqual } from 'node:crypto';

const STEP = 30; // seconds per time step (RFC 6238 default)
const DIGITS = 6;

// --- the algorithm -----------------------------------------------------------------------------

function counterBytes(counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter)); // 8 bytes, big-endian
  return buf;
}

/** RFC 4226: HMAC the 8-byte counter, take 4 bytes at an offset, keep the last digits. */
export function hotp(secret, counter, digits = DIGITS) {
  const mac = createHmac('sha1', secret).update(counterBytes(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f; // low 4 bits of the last byte: 0..15
  const number = mac.readUInt32BE(offset) & 0x7fffffff; // drop the top bit
  return String(number % 10 ** digits).padStart(digits, '0'); // a string: keep leading zeros
}

/** RFC 6238: HOTP where the counter is the number of 30 s steps since 1970-01-01 UTC. */
export function totp(secret, unixTime, digits = DIGITS) {
  return hotp(secret, Math.floor(unixTime / STEP), digits);
}

/** The QR code carries the secret in Base32 (RFC 4648) without padding. */
export function secretFromBase32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/[\s=]/g, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error(`not Base32: ${ch}`);
    bits += v.toString(2).padStart(5, '0'); // each character is 5 bits
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Constant-time compare: the time taken does not depend on where the codes differ. */
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// --- three verifiers ---------------------------------------------------------------------------

/** Accept only the code for the server's current step. */
export function verifyNaive(secret, code, now) {
  return same(totp(secret, now), code);
}

/** Also accept the codes of `window` steps before and after (RFC 6238, section 5.2). */
export function verifyWindow(secret, code, now, window = 1) {
  const step = Math.floor(now / STEP);
  for (let k = -window; k <= window; k++) if (same(hotp(secret, step + k), code)) return true;
  return false;
}

const MAX_FAILURES = 10;

/** What the server keeps per user. In a database: one row, secret encrypted at rest. */
export const enrollment = (secret) => ({ secret, lastStep: -1, drift: 0, failures: 0 });

export function verify(e, code, now, window = 1, fallback = true) {
  if (e.failures >= MAX_FAILURES) return 'locked';
  const serverStep = Math.floor(now / STEP);
  const centre = serverStep + e.drift;
  const steps = new Set();
  for (let k = -window; k <= window; k++) {
    steps.add(centre + k);
    if (fallback) steps.add(serverStep + k); // the phone may have corrected its clock
  }
  const ordered = [...steps].sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
  for (const step of ordered) { // most likely step first
    if (step <= e.lastStep) continue; // this step, or a later one, was already used: a replay
    if (same(hotp(e.secret, step), code)) {
      // In SQL: one conditional UPDATE ... WHERE last_step < :step (see the page)
      Object.assign(e, { lastStep: step, drift: step - serverStep, failures: 0 });
      return 'ok';
    }
  }
  e.failures += 1;
  return 'rejected';
}

// --- experiments -------------------------------------------------------------------------------

const n = (x) => x.toLocaleString('en-US');
const pct = (x, places) => `${(x * 100).toFixed(places)}%`;
const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const pad2 = (x) => String(x).padStart(2, '0');
const section = (title) => console.log(`\n== ${title} ==`);

section('0. RFC test vectors');
const rfcSecret = Buffer.from('12345678901234567890');
const got = Array.from({ length: 10 }, (_, c) => hotp(rfcSecret, c));
const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
console.log('RFC 4226 HOTP counters 0-9:', got.join() === want.join() ? 'ok' : `MISMATCH ${got}`);
const vectors = { 59: '94287082', 1111111109: '07081804', 1234567890: '89005924', 2000000000: '69279037', 20000000000: '65353130' };
const ok6238 = Object.entries(vectors).every(([t, code]) => totp(rfcSecret, Number(t), 8) === code);
console.log('RFC 6238 TOTP SHA-1, 8 digits, 5 times:', ok6238 ? 'ok' : 'MISMATCH');

section('1. Dynamic truncation, counter 0');
const mac = createHmac('sha1', rfcSecret).update(counterBytes(0)).digest();
console.log('counter bytes :', hex(counterBytes(0)));
console.log('HMAC-SHA1     :', hex(mac));
const offset = mac[19] & 0x0f;
const number = mac.readUInt32BE(offset) & 0x7fffffff;
console.log(`last byte 0x${mac[19].toString(16)} -> offset ${offset}`);
console.log(`bytes ${offset}-${offset + 3}     : ${hex(mac.subarray(offset, offset + 4))} -> top bit cleared -> ${n(number)}`);
console.log(`${n(number)} mod 1,000,000 = ${String(number % 1e6).padStart(6, '0')}`);

section('2. From the clock to the counter');
const demo = secretFromBase32('ONSW42LPOJSGK5TON52GK4ZNMRSW23ZB'); // demo secret, never reuse
const now = 1793961737; // 2026-11-06 10:42:17 UTC
console.log(`unix time ${now} // ${STEP} = step ${Math.floor(now / STEP)}, ${now % STEP} s into it`);
for (const t of [now, now + 12, now + 13, now + 43]) {
  console.log(`  t = ${t} (step ${Math.floor(t / STEP)}) -> ${totp(demo, t)}`);
}

section('3. A code typed across a step boundary');
const readAt = 1793961749; // 29 s into step 59798724
let code = totp(demo, readAt);
for (const delay of [0, 4, 15, 35, 65]) {
  const arrive = readAt + delay;
  const naive = verifyNaive(demo, code, arrive) ? 'ok' : 'REJECTED';
  const win = verifyWindow(demo, code, arrive) ? 'ok' : 'REJECTED';
  console.log(`  read at :${pad2(readAt % 60)}, arrives ${String(delay).padStart(2)} s later -> naive ${naive.padEnd(8)} window +-1 ${win}`);
}

section('4. Replay: the same code twice');
const e = enrollment(demo);
code = totp(demo, now);
console.log('  first use      :', verify(e, code, now));
console.log('  same code, +5 s:', verify(e, code, now + 5), ' (a phished code replayed)');
console.log('  window-only verifier would say:', verifyWindow(demo, code, now + 5) ? 'ok' : 'rejected');

section('5. Phone clock gains 2 s a day; the user logs in every 3 days');
let fixedFail = 0;
let trackedFail = 0;
const tracked = enrollment(demo);
for (let day = 0; day <= 90; day += 3) {
  const server = now + day * 86400;
  const phone = server + 2 * day; // the phone's clock runs ahead
  const c = totp(demo, phone);
  const fixedOk = verifyWindow(demo, c, server);
  const trackedOk = verify(tracked, c, server) === 'ok';
  fixedFail += !fixedOk;
  trackedFail += !trackedOk;
  if (day % 15 === 0) {
    const sign = tracked.drift >= 0 ? '+' : '';
    console.log(
      `  day ${String(day).padStart(2)}: phone ahead ${String(2 * day).padStart(3)} s -> fixed window ` +
        `${(fixedOk ? 'ok' : 'REJECTED').padEnd(8)} tracked ${(trackedOk ? 'ok' : 'REJECTED').padEnd(8)}` +
        ` (learned drift ${sign}${tracked.drift} steps)`,
    );
  }
}
console.log(`  failed logins out of 31: fixed window ${fixedFail}, drift tracking ${trackedFail}`);

console.log('  day 93: the phone corrects its clock (back online); learned drift is now wrong');
const noFallback = { ...enrollment(demo), lastStep: tracked.lastStep, drift: tracked.drift };
for (const attempt of [1, 2]) {
  const server = now + 93 * 86400 + attempt * 60;
  const c = totp(demo, server); // phone and server agree again
  const a = verify(noFallback, c, server, 1, false).padEnd(8);
  const b = verify(tracked, c, server);
  const sign = tracked.drift >= 0 ? '+' : '';
  console.log(`    login ${attempt}: drift only -> ${a} drift + fallback -> ${b} (drift now ${sign}${tracked.drift})`);
}

section('6. Guessing odds (6 digits)');
for (const window of [0, 1, 2]) {
  const valid = 2 * window + 1;
  const p = valid / 10 ** DIGITS;
  const half = Math.log(2) / -Math.log1p(-p);
  console.log(
    `  window +-${window}: ${valid} valid code${valid > 1 ? 's' : ''}, 1 guess = ${pct(p, 4)}, ` +
      `100 guesses = ${pct(1 - (1 - p) ** 100, 3)}, 50% after ${n(Math.round(half))} guesses`,
  );
}
