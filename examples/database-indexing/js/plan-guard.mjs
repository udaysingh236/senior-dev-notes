// Watch SQLite's query plan change as indexes are added, then fail a test when a query scans.
//
// The query is the usual "latest 20 orders of one customer". Each step drops the previous index
// and creates a better one, prints the plan SQLite chose and how long the query takes.
// Run: node plan-guard.mjs   (Node 22.5+, built-in node:sqlite, nothing to install)
import { DatabaseSync } from 'node:sqlite';

const ROWS = 200_000;
const QUERY = `SELECT id, created_at, amount_cents FROM orders
               WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`;

const STEPS = [
  ['no index', null],
  ['index on (customer_id)', 'CREATE INDEX idx ON orders (customer_id)'],
  ['index on (customer_id, created_at)', 'CREATE INDEX idx ON orders (customer_id, created_at)'],
  ['covering: (customer_id, created_at, amount_cents)',
    'CREATE INDEX idx ON orders (customer_id, created_at, amount_cents)'],
];

const pad = (n) => String(n).padStart(2, '0');

function build() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL,
           created_at TEXT NOT NULL, amount_cents INTEGER NOT NULL, note TEXT NOT NULL)`);
  const insert = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= ROWS; i++) {
    const customer = (i * 7919) % 2_000 + 1; // 2,000 customers, 100 orders each, spread across the table
    const createdAt = `2025-${pad(1 + Math.floor((i * 12) / ROWS))}-${pad(1 + (i % 28))} ${pad(i % 24)}:00:00`;
    insert.run(i, customer, createdAt, (i * 31) % 100_000, 'x'.repeat(60));
  }
  db.exec('COMMIT');
  return db;
}

/** The detail column of EXPLAIN QUERY PLAN: 'SCAN orders', 'SEARCH orders USING INDEX ...'. */
const plan = (db, sql, params = []) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail);

/** For a test suite: fail if the plan reads a whole table or index, or sorts in a temp B-tree. */
function assertUsesIndex(db, sql, params = []) {
  const bad = plan(db, sql, params).filter((step) => step.startsWith('SCAN') || step.includes('TEMP B-TREE'));
  if (bad.length) throw new Error(`query plan has [${bad.map((s) => `'${s}'`).join(', ')}]`);
}

function msPerQuery(db, sql, params, repeat = 20) {
  const statement = db.prepare(sql);
  const start = performance.now();
  for (let i = 0; i < repeat; i++) statement.all(...params);
  return (performance.now() - start) / repeat;
}

const db = build();
for (const [label, ddl] of STEPS) {
  db.exec('DROP INDEX IF EXISTS idx');
  if (ddl) db.exec(ddl);
  console.log(`${label}: ${msPerQuery(db, QUERY, [1234]).toFixed(3)} ms`);
  for (const step of plan(db, QUERY, [1234])) console.log(`    ${step}`);
}

// With an index on created_at, a range on the column passes the guard. Wrapping the column
// in a function hides it from the index, and the guard catches that.
db.exec('CREATE INDEX orders_created ON orders (created_at)');
assertUsesIndex(db, 'SELECT count(*) FROM orders WHERE created_at >= ? AND created_at < ?', ['2025-06', '2025-07']);
console.log('guard: range on created_at uses the index');
try {
  assertUsesIndex(db, 'SELECT count(*) FROM orders WHERE substr(created_at, 1, 7) = ?', ['2025-06']);
} catch (err) {
  console.log(`guard: substr(created_at, 1, 7) fails: ${err.message}`);
}
