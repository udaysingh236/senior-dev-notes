// Segment-wise berth inventory in SQL: one bitmask per berth, one bit per segment.
//
// Forty concurrent requests for overlapping journeys hit one coach of 8 berths. Each request does
// 20 ms of other work (fare, passenger rows) between choosing a berth and writing it.
//
//   naive    SELECT a free berth, await the work, UPDATE mask = mask | need   -> double-booked segments
//   correct  choose the tightest-fitting berth, await the work, then
//            UPDATE ... WHERE id = ? AND mask & need = 0; 0 rows means someone beat us: choose again
//
// Run: node berth-allocator.mjs   (node:sqlite needs Node 22.5+; it prints an experimental warning)

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const STATIONS = ['NDLS', 'MTJ', 'AGC', 'GWL', 'VGLJ', 'BPL', 'ET', 'NGP'];
const SEGMENTS = STATIONS.length - 1;
const KINDS = ['LB', 'MB', 'UB', 'LB', 'MB', 'UB', 'SL', 'SU']; // one bay of a sleeper coach

/** Bits a..b-1 set: the segments a journey from station a to station b occupies. */
const need = (a, b) => ((1 << (b - a)) - 1) << a;

/** How much free run is left around the journey on this berth. Smaller = tighter fit. */
function waste(mask, a, b) {
  let lo = a;
  let hi = b;
  while (lo > 0 && !((mask >> (lo - 1)) & 1)) lo--;
  while (hi < SEGMENTS && !((mask >> hi) & 1)) hi++;
  return a - lo + (hi - b);
}

function setup(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE berth (id INTEGER PRIMARY KEY, kind TEXT, mask INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE booking (id INTEGER PRIMARY KEY, berth_id INTEGER, from_idx INTEGER, to_idx INTEGER);
  `);
  const insert = db.prepare('INSERT INTO berth (id, kind) VALUES (?, ?)');
  KINDS.forEach((kind, i) => insert.run(i + 1, kind));
  db.close();
}

async function bookNaive(db, a, b) {
  const n = need(a, b);
  const row = db.prepare('SELECT id FROM berth WHERE mask & ? = 0 ORDER BY id LIMIT 1').get(n);
  if (!row) return null;
  await sleep(20); // fare, passenger rows, ... other requests run here
  db.prepare('UPDATE berth SET mask = mask | ? WHERE id = ?').run(n, row.id);
  db.prepare('INSERT INTO booking (berth_id, from_idx, to_idx) VALUES (?, ?, ?)').run(row.id, a, b);
  return row.id;
}

function bestBerth(db, a, b, senior) {
  const rows = db.prepare('SELECT id, kind, mask FROM berth WHERE mask & ? = 0').all(need(a, b));
  // Tightest fit first; seniors get lower berths first; then by berth number.
  const key = (r) => [waste(r.mask, a, b), senior && r.kind !== 'LB' ? 1 : 0, r.id];
  rows.sort((x, y) => key(x).reduce((d, v, i) => d || v - key(y)[i], 0));
  return rows.length ? rows[0].id : null;
}

async function book(db, a, b, senior, stats) {
  const n = need(a, b);
  let berthId = bestBerth(db, a, b, senior); // what the user was shown
  await sleep(20); // the same slow work; the choice above is now stale
  while (berthId !== null) {
    db.exec('BEGIN'); // one short transaction: the check and the take are one statement
    const taken = db.prepare('UPDATE berth SET mask = mask | ? WHERE id = ? AND mask & ? = 0').run(n, berthId, n).changes;
    if (taken) {
      db.prepare('INSERT INTO booking (berth_id, from_idx, to_idx) VALUES (?, ?, ?)').run(berthId, a, b);
      db.exec('COMMIT');
      return berthId;
    }
    db.exec('COMMIT');
    stats.retries++; // an overlapping journey got this berth first: re-read, choose again
    berthId = bestBerth(db, a, b, senior);
  }
  return null;
}

/** Pairs of bookings on the same berth that share at least one segment. */
function overlaps(path) {
  const db = new DatabaseSync(path);
  const { pairs } = db.prepare(`
    SELECT COUNT(*) AS pairs FROM booking x JOIN booking y
      ON x.berth_id = y.berth_id AND x.id < y.id
     AND x.from_idx < y.to_idx AND y.from_idx < x.to_idx`).get();
  db.close();
  return pairs;
}

async function run(label, correct) {
  const path = join(mkdtempSync(join(tmpdir(), 'berths-')), 'inventory.db');
  setup(path);
  let seed = 7;
  const rand = (n) => {
    // tiny LCG, so the Python version gets the same journeys
    seed = Number((BigInt(seed) * 1103515245n + 12345n) % 2147483648n);
    return seed % n;
  };
  const journeys = [];
  for (let i = 0; i < 40; i++) {
    const a = rand(SEGMENTS);
    journeys.push([a, a + 1 + rand(Math.min(3, SEGMENTS - a)), rand(4) === 0]);
  }
  const stats = { retries: 0 };
  const results = await Promise.all(
    journeys.map(async ([a, b, senior]) => {
      const db = new DatabaseSync(path);
      try {
        return await (correct ? book(db, a, b, senior, stats) : bookNaive(db, a, b));
      } finally {
        db.close();
      }
    }),
  );
  const booked = results.filter((r) => r !== null).length;
  console.log(`${label.padEnd(8)} ${String(booked).padStart(2)} of 40 booked, ${String(overlaps(path)).padStart(3)} overlapping pairs, ${String(stats.retries).padStart(2)} retries`);
}

console.log('8 berths x 7 segments (NDLS..NGP); 40 concurrent requests, 20 ms of work each\n');
await run('naive', false);
await run('correct', true);
const show = (m) => Array.from({ length: SEGMENTS }, (_, s) => (m >> s) & 1).join(''); // segment 0 first
console.log(`\nbitmask check: berth booked NDLS-AGC ${show(need(0, 2))}, journey AGC-BPL needs ${show(need(2, 5))}, AND = ${need(0, 2) & need(2, 5)} -> it fits`);
