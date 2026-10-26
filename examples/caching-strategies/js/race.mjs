// Cache-aside writes racing with reads: set on write, delete on write, and a versioned marker.
//
// Part 1 replays the two classic interleavings step by step.
// Part 2 runs one hot key for 10 simulated minutes with random timing and measures how long the
// cache holds a version older than one a writer has already told it about. (The millisecond
// between a commit and its own cache command is stale under every strategy, so it is not counted.)
//
// Run: node race.mjs

/** mulberry32, the same generator as the Python version, so both print the same numbers. */
function rng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { exp: (mean) => -Math.log(1 - next()) * mean };
}

/** One key. An entry is { kind, version }: kind 'value', or 'marker' for "deleted at version v". */
class Cache {
  constructor(mode) {
    this.mode = mode;
    this.entry = null;
  }
  /** What a reader does after a miss. Returns false if the write was refused. */
  fill(version) {
    if (this.mode === 'versioned' && this.entry) {
      const { kind, version: current } = this.entry;
      // Refuse anything older than what the cache already knows about.
      if (version < current || (kind === 'value' && version === current)) return false;
    }
    this.entry = { kind: 'value', version };
    return true;
  }
  /** What a writer does after committing `version` to the database. */
  afterWrite(version) {
    if (this.mode === 'set') this.entry = { kind: 'value', version };
    else if (this.mode === 'delete') this.entry = null;
    else this.entry = { kind: 'marker', version };
  }
  get() {
    return this.entry && this.entry.kind === 'value' ? this.entry.version : null;
  }
}

function replay() {
  console.log('Set on write, two writers (database: v1 then v2; cache updates arrive v2 then v1)');
  let db = 0;
  let cache = new Cache('set');
  db = 1; // writer A commits v1
  db = 2; // writer B commits v2
  cache.afterWrite(2); // B's SET reaches the cache first
  cache.afterWrite(1); // A's SET was delayed
  console.log(`  database v${db}, cache v${cache.get()}  -> stale until the next write or the TTL\n`);

  for (const mode of ['delete', 'versioned']) {
    console.log(`${mode === 'delete' ? 'Delete on write' : 'Versioned marker'}, one reader and one writer`);
    db = 1;
    cache = new Cache(mode);
    const steps = [];
    let seen = db; // reader: cache miss, SELECT returns v1
    steps.push(`reader misses and reads v${seen}`);
    db = 2; // writer commits v2
    cache.afterWrite(db);
    steps.push(`writer commits v2 and ${mode === 'delete' ? 'deletes the key' : 'writes marker v2'}`);
    const ok = cache.fill(seen);
    steps.push(`reader fills v${seen}: ${ok ? 'stored' : 'refused, the marker is newer'}`);
    for (const s of steps) console.log(`  ${s}`);
    if (cache.get() === null) {
      seen = db; // the next reader misses and reads v2
      cache.fill(seen);
      console.log(`  next reader misses, reads v${seen} and fills it`);
    }
    console.log(`  database v${db}, cache v${cache.get()}\n`);
  }
}

/** One key, 500 reads/s and `writesPerS` writes/s, Poisson. A DB read takes 10 ms on
 *  average, a commit 5 ms, a cache command 1 ms. TTL 60 s. Returns [share of time stale,
 *  longest stale stretch in ms, number of refused fills]. */
function simulate(mode, writesPerS, seed = 11) {
  const r = rng(seed);
  const cache = new Cache(mode);
  const end = 600_000;
  const ttl = 60_000;
  let db = 0;
  let setAt = 0;
  let told = 0; // newest version whose cache command has landed
  cache.entry = { kind: 'value', version: 0 };
  const events = []; // sorted by [t, seq], like Python's heap
  let seq = 0;
  const push = (t, kind, v = 0) => {
    seq += 1;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid][0] < t || (events[mid][0] === t && events[mid][1] < seq)) lo = mid + 1;
      else hi = mid;
    }
    events.splice(lo, 0, [t, seq, kind, v]);
  };

  push(r.exp(1000 / 500), 'read');
  push(r.exp(1000 / writesPerS), 'write');
  let staleMs = 0;
  let longest = 0;
  let staleSince = null;
  let lastT = 0;
  let refused = 0;
  while (events.length) {
    const [t, , kind, v] = events.shift();
    if (t > end) break;
    if (cache.entry && t - setAt > ttl) cache.entry = null; // expired
    const current = cache.get();
    if (current !== null && current < told) staleMs += t - lastT;
    lastT = t;
    if (kind === 'read') {
      if (cache.get() === null) push(t + r.exp(5), 'snapshot'); // the SELECT sees the database a moment later
      push(t + r.exp(1000 / 500), 'read');
    } else if (kind === 'snapshot') {
      push(t + r.exp(5) + r.exp(1), 'fill', db); // result returns, then SET to cache
    } else if (kind === 'fill') {
      if (cache.fill(v)) setAt = t;
      else refused += 1;
    } else if (kind === 'write') {
      push(t + r.exp(5), 'commit');
      push(t + r.exp(1000 / writesPerS), 'write');
    } else if (kind === 'commit') {
      db += 1;
      push(t + r.exp(1), 'cache-op', db);
    } else if (kind === 'cache-op') {
      cache.afterWrite(v);
      setAt = t;
      told = Math.max(told, v);
    }
    const now = cache.get();
    if (now !== null && now < told) {
      staleSince = staleSince === null ? t : staleSince;
    } else if (staleSince !== null) {
      longest = Math.max(longest, t - staleSince);
      staleSince = null;
    }
  }
  return [staleMs / end, longest, refused];
}

replay();
console.log('One key, 500 reads/s, 10 minutes, TTL 60 s: time the cache holds an outdated version');
console.log(`  ${'writes/s'.padEnd(10)}${'set on write'.padStart(22)}${'delete on write'.padStart(22)}${'versioned marker'.padStart(22)}`);
for (const w of [1, 5, 20]) {
  const cells = ['set', 'delete', 'versioned'].map((mode) => {
    const [share, longest] = simulate(mode, w);
    return `${(100 * share).toFixed(2)}% (max ${(longest / 1000).toFixed(2)} s)`.padStart(22);
  });
  console.log(`  ${String(w).padEnd(10)}${cells.join('')}`);
}
