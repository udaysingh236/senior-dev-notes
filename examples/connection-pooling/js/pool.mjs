// A small, correct connection pool, and three experiments with it.
//
// Standard library only. The "database" is a stand-in whose connect() takes 10 ms (about what our
// PostgreSQL measured for TCP + TLS + SCRAM on localhost) and whose queries take 1 ms, so the
// experiments show the pool's behaviour without needing a server. The pool itself is the real
// thing: swap FakeDatabase.connect for a pg Client's connect() and it works the same way.
//
// Run: node pool.mjs
import { setTimeout as sleep } from 'node:timers/promises';

const CONNECT_MS = 10; // opening a connection
const QUERY_MS = 1; // one query on an open connection

/** Counts connections the way max_connections would see them. */
class FakeDatabase {
  openNow = 0;
  openedTotal = 0;
  peak = 0;

  async connect() {
    await sleep(CONNECT_MS); // TCP, TLS, authentication, a new backend process
    this.openNow++;
    this.openedTotal++;
    this.peak = Math.max(this.peak, this.openNow);
    return new FakeConnection(this);
  }
}

class FakeConnection {
  constructor(db) {
    this.db = db;
    this.created = performance.now();
    this.inTransaction = false;
  }

  async execute(sql) {
    if (sql === 'BEGIN') this.inTransaction = true;
    else if (sql === 'COMMIT' || sql === 'ROLLBACK') this.inTransaction = false;
    await sleep(QUERY_MS);
  }

  close() {
    this.db.openNow--;
  }
}

class PoolTimeout extends Error {}

/** A bounded pool: at most maxSize connections, callers wait up to timeoutMs. */
class Pool {
  constructor({ connect, maxSize, timeoutMs, maxLifetimeMs = 1_800_000 }) {
    Object.assign(this, { connect, maxSize, timeoutMs, maxLifetimeMs });
    this.idle = [];
    this.size = 0; // open connections, idle or in use, plus ones being opened
    this.waiters = []; // FIFO of { resolve, timer }
  }

  async acquire() {
    if (this.idle.length) return this.idle.pop(); // 1. reuse an idle connection
    if (this.size < this.maxSize) { // 2. room to open one
      this.size++;
      try {
        return await this.connect();
      } catch (err) {
        this.size--;
        this.#wakeOne(null);
        throw err;
      }
    }
    return new Promise((resolve, reject) => { // 3. wait for a release, but not forever
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new PoolTimeout(`no connection within ${this.timeoutMs} ms (${this.size} in use)`));
      }, this.timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async release(conn, { broken = false } = {}) {
    if (conn.inTransaction && !broken) await conn.execute('ROLLBACK'); // never pass on a transaction
    // Retire old connections, a little early at random so they do not all expire together.
    const tooOld = performance.now() - conn.created > this.maxLifetimeMs * (0.95 + 0.05 * Math.random());
    if (broken || tooOld) {
      conn.close();
      this.size--;
      this.#wakeOne(null);
    } else {
      this.#wakeOne(conn);
    }
  }

  /** Hands conn to the oldest waiter, or keeps it idle. With conn = null, a slot freed up. */
  #wakeOne(conn) {
    const waiter = this.waiters.shift();
    if (!waiter) {
      if (conn) this.idle.push(conn);
      return;
    }
    clearTimeout(waiter.timer);
    if (conn) return waiter.resolve(conn);
    this.size++;
    waiter.resolve(this.connect().catch((err) => { this.size--; throw err; }));
  }

  /** Runs fn with a connection and always gives it back. */
  async withConnection(fn) {
    const conn = await this.acquire();
    try {
      const result = await fn(conn);
      await this.release(conn);
      return result;
    } catch (err) {
      await this.release(conn, { broken: true });
      throw err;
    }
  }
}

/** Runs n requests with `concurrency` in flight at once; returns elapsed ms. */
async function runRequests(n, concurrency, handler) {
  let started = 0;
  const start = performance.now();
  const worker = async () => {
    while (started < n) {
      started++;
      await handler();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return performance.now() - start;
}

async function experimentConnectPerRequest() {
  console.log('1. 400 requests, 8 in flight, one query each');
  let db = new FakeDatabase();
  let elapsed = await runRequests(400, 8, async () => {
    const conn = await db.connect();
    await conn.execute('SELECT 1');
    conn.close();
  });
  console.log(`   new connection per request: ${String(Math.round(400 / (elapsed / 1000))).padStart(5)} req/s, ${db.openedTotal} connections opened`);

  db = new FakeDatabase();
  const pool = new Pool({ connect: () => db.connect(), maxSize: 8, timeoutMs: 1000 });
  elapsed = await runRequests(400, 8, () => pool.withConnection((conn) => conn.execute('SELECT 1')));
  console.log(`   pool of 8:                  ${String(Math.round(400 / (elapsed / 1000))).padStart(5)} req/s, ${db.openedTotal} connections opened`);
}

async function experimentHoldTime() {
  console.log('2. 200 requests, 40 in flight, pool of 4: what is done while holding the connection');
  for (const [label, insideCall] of [['payment call after COMMIT', false], ['payment call inside the transaction', true]]) {
    const db = new FakeDatabase();
    const pool = new Pool({ connect: () => db.connect(), maxSize: 4, timeoutMs: 5000 });
    const elapsed = await runRequests(200, 40, async () => {
      await pool.withConnection(async (conn) => {
        await conn.execute('BEGIN');
        await conn.execute("UPDATE orders SET status = 'paying' WHERE id = $1");
        if (insideCall) await sleep(50); // HTTP call to a payment provider, connection held
        await conn.execute('COMMIT');
      });
      if (!insideCall) await sleep(50); // the same call, connection already returned
    });
    console.log(`   ${label.padEnd(36)} ${String(Math.round(200 / (elapsed / 1000))).padStart(5)} req/s`);
  }
}

async function experimentNestedAcquire() {
  console.log('3. pool of 2, two requests that each need a second connection while holding the first');
  const db = new FakeDatabase();
  const pool = new Pool({ connect: () => db.connect(), maxSize: 2, timeoutMs: 500 });
  const start = performance.now();
  let arrived = 0;
  let allArrived;
  const bothHolding = new Promise((resolve) => { allArrived = resolve; });
  const barrier = () => (++arrived === 2 && allArrived(), bothHolding);

  const handler = async (name, delayMs) => {
    try {
      await pool.withConnection(async (conn) => {
        await conn.execute('BEGIN');
        await barrier(); // both now hold one connection each
        await sleep(delayMs);
        await pool.withConnection((audit) => audit.execute('INSERT INTO audit_log ...')); // a "separate" write
        await conn.execute('COMMIT');
      });
      console.log(`   ${name}: done at ${((performance.now() - start) / 1000).toFixed(1)}s`);
    } catch (err) {
      if (!(err instanceof PoolTimeout)) throw err;
      console.log(`   ${name}: PoolTimeout at ${((performance.now() - start) / 1000).toFixed(1)}s: ${err.message}`);
    }
  };
  await Promise.all([handler('request 1', 0), handler('request 2', 100)]);
}

await experimentConnectPerRequest();
await experimentHoldTime();
await experimentNestedAcquire();
