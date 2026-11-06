// POST /payments with an Idempotency-Key, two ways, over SQLite (node:sqlite) and a fake bank.
//
// naive  checks whether the key exists, charges, then records the key.
// keyed  claims the key first (a lock with a lease), creates the payment in the same transaction,
//        charges with a downstream key derived from the payment, and finishes in a fenced update.
//
// Three scenarios run against both: a duplicate that arrives while the first attempt is still
// charging, a process that dies after the bank said yes, and a key reused with a different amount.
// Run: node --no-warnings payments.mjs   (node:sqlite prints an experimental warning on Node 22)
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

// Demo value: longer than the 0.3 s bank call. In production, longer than the slowest attempt
// can run (tens of seconds), never shorter.
const LEASE_S = 1.0;
const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));
const nowS = () => Date.now() / 1000;

/** A fake payment processor. Like real ones, it honours its own idempotency key if given one. */
class Bank {
  constructor(latencyS = 0.3) {
    Object.assign(this, { latencyS, charges: [], byRef: new Map() });
  }
  async charge(amount, ref = null) {
    await sleep(this.latencyS);
    if (ref !== null && this.byRef.has(ref)) return this.byRef.get(ref); // a repeat: no new charge
    this.charges.push(amount);
    const chargeId = `ch_${this.charges.length}`;
    if (ref !== null) this.byRef.set(ref, chargeId);
    return chargeId;
  }
}

/** Stands in for the process dying: nothing after this line runs. */
class Crash extends Error {}

const SCHEMA = `
CREATE TABLE naive_keys (account_id TEXT, key TEXT, status INTEGER, body TEXT,
                         PRIMARY KEY (account_id, key));
CREATE TABLE idempotency_keys (
  account_id TEXT NOT NULL, key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,          -- hash of the request body, to catch a reused key
  recovery_point TEXT NOT NULL,       -- 'created' -> 'finished'
  owner TEXT,                         -- the attempt holding the lease (for fencing)
  locked_until REAL,                  -- the lease; NULL once finished
  payment_id TEXT NOT NULL,
  status INTEGER, body TEXT,          -- the stored response, replayed to every retry
  created_at REAL NOT NULL,
  PRIMARY KEY (account_id, key)       -- scope keys per account
);
CREATE TABLE payments (id TEXT PRIMARY KEY, account_id TEXT, amount INTEGER,
                       state TEXT, charge_id TEXT);`;

// No `await` inside: on one event loop, the transaction cannot interleave with another request.
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const fingerprint = (body) =>
  createHash('sha256').update(JSON.stringify(body, Object.keys(body).sort())).digest('hex');

// --- naive: check, then act -------------------------------------------------------------------

async function payNaive(db, bank, account, key, amount, { crashAfterCharge = false } = {}) {
  const row = db.prepare('SELECT status, body FROM naive_keys WHERE account_id = ? AND key = ?')
    .get(account, key);
  if (row) return [row.status, JSON.parse(row.body)]; // seen before: replay
  const chargeId = await bank.charge(amount);         // the money moves here...
  if (crashAfterCharge) throw new Crash();            // ...and the key was never written
  const body = { charge: chargeId, amount };
  try {
    db.prepare('INSERT INTO naive_keys VALUES (?, ?, 201, ?)').run(account, key, JSON.stringify(body));
  } catch {                                           // a concurrent attempt got here first:
    return [500, { error: 'duplicate key' }];         // the constraint fired after the money left
  }
  return [201, body];
}

// --- keyed: claim, charge with a downstream key, finish under the lease --------------------------

/** Phase 1, one local transaction. Returns { paymentId } to proceed, or { early: response }. */
function claim(db, account, key, body, me) {
  const fp = fingerprint(body);
  const now = nowS();
  return transaction(db, () => {
    const inserted = db.prepare(
      `INSERT INTO idempotency_keys (account_id, key, fingerprint, recovery_point, owner,
                                     locked_until, payment_id, created_at)
       VALUES (?, ?, ?, 'created', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(account, key, fp, me, now + LEASE_S, `pay_${randomUUID().slice(0, 8)}`, now).changes;
    const row = db.prepare('SELECT * FROM idempotency_keys WHERE account_id = ? AND key = ?')
      .get(account, key);
    if (row.fingerprint !== fp) {
      return { early: [422, { error: 'Idempotency-Key reused with a different body' }] };
    }
    if (row.recovery_point === 'finished') return { early: [row.status, JSON.parse(row.body)] };
    if (inserted) { // first attempt: create the payment too
      db.prepare("INSERT INTO payments VALUES (?, ?, ?, 'pending', NULL)")
        .run(row.payment_id, account, body.amount);
    } else if (row.locked_until > now) {
      return { early: [409, { error: 'a request with this key is in progress' }] };
    } else { // the lease ran out: take it over
      db.prepare('UPDATE idempotency_keys SET owner = ?, locked_until = ? WHERE account_id = ? AND key = ?')
        .run(me, now + LEASE_S, account, key);
    }
    return { paymentId: row.payment_id };
  });
}

async function payKeyed(db, bank, account, key, amount, { crashAfterCharge = false } = {}) {
  const me = randomUUID();
  const { paymentId, early } = claim(db, account, key, { amount }, me);
  if (early) return early;
  // Phase 2, remote. Our payment id is the bank's idempotency key, so a second owner that
  // repeats this call after a crash gets the same charge back instead of a new one.
  const chargeId = await bank.charge(amount, paymentId);
  if (crashAfterCharge) throw new Crash();
  const response = { payment: paymentId, charge: chargeId, amount };
  // Phase 3, one local transaction, fenced: it only commits if we still hold the lease.
  return transaction(db, () => {
    const done = db.prepare(
      `UPDATE idempotency_keys SET recovery_point = 'finished', status = 201, body = ?,
                                   owner = NULL, locked_until = NULL
       WHERE account_id = ? AND key = ? AND owner = ?`,
    ).run(JSON.stringify(response), account, key, me).changes;
    if (!done) return [409, { error: 'a request with this key is in progress' }]; // lost the lease
    db.prepare("UPDATE payments SET state = 'paid', charge_id = ? WHERE id = ?").run(chargeId, paymentId);
    return [201, response];
  });
}

// --- the scenarios ----------------------------------------------------------------------------

async function run(handler, scenario) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const bank = new Bank(0.3);
  const results = [];
  const key = randomUUID();
  const go = async (label, { amount = 1199, delay = 0, ...opts } = {}) => {
    await sleep(delay);
    try {
      const [status] = await handler(db, bank, 'acct_42', key, amount, opts);
      results.push(`${label}:${status}`);
    } catch (err) {
      if (!(err instanceof Crash)) throw err;
      results.push(`${label}:crash`);
    }
  };

  if (scenario === 'duplicate') { // the retry arrives 0.1 s into a 0.3 s charge
    await Promise.all([go('1'), go('2', { delay: 0.1 })]);
    await go('3'); // a later retry, after both finished
  } else if (scenario === 'crash') { // the process dies after the bank said yes
    await go('1', { crashAfterCharge: true });
    await go('2'); // at once: the dead attempt still holds the lease
    await go('3', { delay: LEASE_S }); // after the lease: take over and resume
  } else if (scenario === 'mismatch') { // a client bug: the key is reused for a different amount
    await go('1');
    await go('2', { amount: 2500 });
  }
  db.close();
  const charged = bank.charges.length === 1 ? '1 charge ' : `${bank.charges.length} charges`;
  return `${charged}  ${results.join(' ')}`;
}

console.log(`${'scenario'.padEnd(30)}  ${'naive'.padEnd(30)}  keyed`);
for (const [scenario, title] of [
  ['duplicate', 'duplicate while first runs'],
  ['crash', 'crash after the bank said yes'],
  ['mismatch', 'same key, different amount'],
]) {
  console.log(`${title.padEnd(30)}  ${(await run(payNaive, scenario)).padEnd(30)}  ${await run(payKeyed, scenario)}`);
}
