// N+1 queries, the batched fix, a per-request loader, and a test that catches regressions.
//
// Standard library only: node:sqlite in memory stands in for the database, and every query
// first waits ROUND_TRIP_MS, the network between an app server and a database in another
// availability zone. The query counts are exact; the timings depend on your machine's timers.
//
//   node n-plus-one.mjs        (Node 22.13+; Node 22 prints an ExperimentalWarning for sqlite)
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

const ROUND_TRIP_MS = 1;
const MAX_IN_LIST = 500; // SQLAlchemy's selectinload uses chunks of 500 keys, too

/** A database connection that counts queries and pays one round trip for each. */
class Db {
  constructor() {
    this.conn = new DatabaseSync(':memory:');
    this.queries = 0;
    this.conn.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_cents INTEGER);
      CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT, qty INTEGER);
      CREATE INDEX order_items_order_id ON order_items (order_id);`);
  }

  seed(orders) {
    this.conn.exec('DELETE FROM customers; DELETE FROM orders; DELETE FROM order_items;');
    const customer = this.conn.prepare('INSERT INTO customers VALUES (?, ?)');
    for (let c = 1; c <= 40; c++) customer.run(c, `customer ${c}`);
    const order = this.conn.prepare('INSERT INTO orders VALUES (?, ?, ?)');
    const item = this.conn.prepare('INSERT INTO order_items (order_id, sku, qty) VALUES (?, ?, ?)');
    for (let o = 1; o <= orders; o++) {
      order.run(o, ((o * 7) % 40) + 1, 1000 + o);
      for (let k = 0; k < 3; k++) item.run(o, `SKU-${o * 31 + k}`, 1 + (k % 3));
    }
  }

  async fetch(sql, params = []) {
    this.queries++;
    await sleep(ROUND_TRIP_MS);
    return this.conn.prepare(sql).all(...params).map((row) => ({ ...row }));
  }
}

const placeholders = (n) => Array(n).fill('?').join(', ');
const pageOfOrders = (db, limit) => db.fetch('SELECT * FROM orders ORDER BY id LIMIT ?', [limit]);

// --- 1. Naive: what a lazy-loading ORM does inside a loop -------------------------------------
async function listOrdersNaive(db, limit) {
  const orders = await pageOfOrders(db, limit); // 1 query
  for (const order of orders) { // + 2 queries per order
    [order.customer] = await db.fetch('SELECT * FROM customers WHERE id = ?', [order.customer_id]);
    order.items = await db.fetch('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  }
  return orders;
}

// --- 2. Correct: one query per relationship, joined up in a Map ------------------------------
/** Runs sql with an IN list for keys, in chunks so the statement never grows unbounded. */
async function fetchIn(db, sql, keys) {
  const rows = [];
  for (let start = 0; start < keys.length; start += MAX_IN_LIST) {
    const chunk = keys.slice(start, start + MAX_IN_LIST);
    rows.push(...(await db.fetch(sql.replace('{inList}', placeholders(chunk.length)), chunk)));
  }
  return rows;
}

async function listOrdersBatched(db, limit) {
  const orders = await pageOfOrders(db, limit);
  const customerIds = [...new Set(orders.map((o) => o.customer_id))]; // distinct: 50 orders, 40 customers
  const customers = new Map(
    (await fetchIn(db, 'SELECT * FROM customers WHERE id IN ({inList})', customerIds)).map((c) => [c.id, c]),
  );
  const items = new Map(orders.map((o) => [o.id, []])); // an order with no items gets []
  const itemSql = 'SELECT * FROM order_items WHERE order_id IN ({inList}) ORDER BY id';
  for (const row of await fetchIn(db, itemSql, orders.map((o) => o.id))) items.get(row.order_id).push(row);
  for (const order of orders) {
    order.customer = customers.get(order.customer_id);
    order.items = items.get(order.id);
  }
  return orders;
}

// --- 3. Production-shaped: a loader for code that cannot see the loop ------------------------
/**
 * Collects every load(key) made in one turn of the event loop, then fetches them in one batch.
 * Create one per request: the cache inside must never be shared between users.
 */
class Loader {
  constructor(batchFn) {
    this.batchFn = batchFn; // async (keys) => Map(key -> value)
    this.cache = new Map();
    this.queue = [];
  }

  load(key) {
    if (this.cache.has(key)) return this.cache.get(key).promise; // same key twice: one fetch
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.cache.set(key, { promise, resolve, reject });
    this.queue.push(key);
    // First key of a new batch: dispatch after every pending promise callback has had its turn.
    if (this.queue.length === 1) setImmediate(() => this.#dispatch());
    return promise;
  }

  async #dispatch() {
    const keys = this.queue;
    this.queue = [];
    try {
      const found = await this.batchFn(keys);
      for (const key of keys) this.cache.get(key).resolve(found.get(key) ?? null);
    } catch (err) { // one failed batch fails every caller in it
      for (const key of keys) {
        this.cache.get(key).reject(err);
        this.cache.delete(key);
      }
    }
  }
}

async function listOrdersWithLoaders(db, limit) {
  const customers = new Loader(async (ids) => {
    const rows = await db.fetch(`SELECT * FROM customers WHERE id IN (${placeholders(ids.length)})`, ids);
    return new Map(rows.map((c) => [c.id, c]));
  });
  const items = new Loader(async (ids) => {
    const grouped = new Map(ids.map((id) => [id, []]));
    const sql = `SELECT * FROM order_items WHERE order_id IN (${placeholders(ids.length)}) ORDER BY id`;
    for (const row of await db.fetch(sql, ids)) grouped.get(row.order_id).push(row);
    return grouped;
  });

  // Each order is resolved on its own, the way a GraphQL resolver or a nested serializer works.
  const resolve = async (order) => {
    order.customer = await customers.load(order.customer_id);
    order.items = await items.load(order.id);
    return order;
  };
  return Promise.all((await pageOfOrders(db, limit)).map(resolve));
}

// --- 4. The test that keeps N+1 from coming back ----------------------------------------------
async function queryCount(db, endpoint, orders) {
  db.seed(orders);
  const before = db.queries;
  await endpoint(db, orders);
  return db.queries - before;
}

/** Same request with 10 and 100 rows: the query count must not grow with the data. */
async function assertConstantQueries(endpoint) {
  const db = new Db();
  const small = await queryCount(db, endpoint, 10);
  const large = await queryCount(db, endpoint, 100);
  const verdict = large === small ? 'ok' : 'FAIL: grows with the number of rows';
  return `${small} queries for 10 orders, ${large} for 100: ${verdict}`;
}

async function timed(label, db, run) {
  db.queries = 0;
  const start = performance.now();
  const result = await run();
  const ms = performance.now() - start;
  console.log(`   ${label.padEnd(29)} ${String(db.queries).padStart(4)} queries ${ms.toFixed(1).padStart(8)} ms`);
  return result;
}

const db = new Db();
db.seed(200);
console.log(`1. A page of 50 orders with customer and items, ${ROUND_TRIP_MS} ms per round trip`);
const naive = await timed('naive loop', db, () => listOrdersNaive(db, 50));
const batched = await timed('batched with IN', db, () => listOrdersBatched(db, 50));
const loaded = await timed('per-order resolvers + loader', db, () => listOrdersWithLoaders(db, 50));
console.log(`   same result from all three: ${isDeepStrictEqual(naive, batched) && isDeepStrictEqual(batched, loaded)}`);
console.log('2. Query count as the data grows (the regression test)');
console.log(`   naive:   ${await assertConstantQueries(listOrdersNaive)}`);
console.log(`   batched: ${await assertConstantQueries(listOrdersBatched)}`);
console.log(`   loaders: ${await assertConstantQueries(listOrdersWithLoaders)}`);
