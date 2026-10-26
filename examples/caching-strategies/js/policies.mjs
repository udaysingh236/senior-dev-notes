// Four eviction policies on the same traffic: LRU, LFU, W-TinyLFU (simplified) and S3-FIFO.
//
// The traffic: 10,000 keys with Zipf popularity (the k-th most popular key gets 1/k of the
// traffic of the first). Three scenarios:
//
//   steady   only the Zipf traffic
//   scans    a batch job reads keys nobody else reads, one for every two normal requests
//   shift    halfway through, popularity flips: the coldest keys become the hottest
//
// The hit ratio counts only the normal traffic; the scan's own reads miss under every policy.
// "Best static" is the hit ratio of a cache that always holds exactly the most popular keys.
//
// Run: node policies.mjs

const KEYS = 10_000;
const REQUESTS = 200_000;
const SEED = 7;

/** mulberry32, the same generator as the Python version, so both print the same numbers. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit integer hash, identical in both languages. */
function mix(x) {
  x >>>= 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const first = (map) => map.keys().next().value;

class Lru {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Map(); // a Map remembers insertion order
  }
  access(key) {
    if (this.items.has(key)) {
      this.items.delete(key); // re-insert: most recently used goes to the back
      this.items.set(key, true);
      return true;
    }
    this.items.set(key, true);
    if (this.items.size > this.capacity) this.items.delete(first(this.items)); // LRU is at the front
    return false;
  }
}

/** Exact LFU in O(1): one bucket of keys per hit count. Counts are never aged. */
class Lfu {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = new Map();
    this.buckets = new Map();
    this.min = 0;
  }
  bucket(c) {
    if (!this.buckets.has(c)) this.buckets.set(c, new Map());
    return this.buckets.get(c);
  }
  access(key) {
    if (this.count.has(key)) {
      const c = this.count.get(key);
      const b = this.buckets.get(c);
      b.delete(key);
      if (!b.size) {
        this.buckets.delete(c);
        if (this.min === c) this.min = c + 1;
      }
      this.count.set(key, c + 1);
      this.bucket(c + 1).set(key, true);
      return true;
    }
    if (this.count.size >= this.capacity) {
      const b = this.buckets.get(this.min);
      const victim = first(b);
      b.delete(victim);
      if (!b.size) this.buckets.delete(this.min);
      this.count.delete(victim);
    }
    this.count.set(key, 1);
    this.bucket(1).set(key, true);
    this.min = 1;
    return false;
  }
}

/** Count-min sketch: 4 rows of 4-bit counters. Estimate = the smallest of the 4 counters.
 *  Every 10 x capacity increments all counters are halved, so old popularity fades. */
class Sketch {
  constructor(capacity) {
    this.width = 1;
    while (this.width < capacity * 4) this.width *= 2;
    this.rows = Array.from({ length: 4 }, () => new Uint8Array(this.width));
    this.added = 0;
    this.resetAt = 10 * capacity;
  }
  slot(key, i) {
    return mix(key * 4 + i) & (this.width - 1);
  }
  add(key) {
    for (let i = 0; i < 4; i++) {
      const j = this.slot(key, i);
      if (this.rows[i][j] < 15) this.rows[i][j] += 1;
    }
    this.added += 1;
    if (this.added >= this.resetAt) {
      for (const row of this.rows) for (let j = 0; j < row.length; j++) row[j] >>= 1;
      this.added = Math.floor(this.added / 2);
    }
  }
  estimate(key) {
    let m = 15;
    for (let i = 0; i < 4; i++) m = Math.min(m, this.rows[i][this.slot(key, i)]);
    return m;
  }
}

/** A 1% LRU window, then a main area (20% probation, 80% protected). A key leaving the
 *  window gets into the main area only if the sketch says it is more popular than the key
 *  the main area would evict. */
class WTinyLfu {
  constructor(capacity) {
    this.windowCap = Math.max(1, Math.floor(capacity / 100));
    this.mainCap = capacity - this.windowCap;
    this.protectedCap = Math.floor((this.mainCap * 8) / 10);
    this.window = new Map();
    this.probation = new Map();
    this.protected = new Map();
    this.sketch = new Sketch(capacity);
  }
  access(key) {
    this.sketch.add(key);
    for (const area of [this.window, this.protected]) {
      if (area.has(key)) {
        area.delete(key);
        area.set(key, true);
        return true;
      }
    }
    if (this.probation.has(key)) { // second hit in the main area: promote
      this.probation.delete(key);
      this.protected.set(key, true);
      if (this.protected.size > this.protectedCap) {
        const demoted = first(this.protected);
        this.protected.delete(demoted);
        this.probation.set(demoted, true);
      }
      return true;
    }
    this.window.set(key, true);
    if (this.window.size > this.windowCap) {
      const candidate = first(this.window);
      this.window.delete(candidate);
      if (this.probation.size + this.protected.size < this.mainCap) {
        this.probation.set(candidate, true);
      } else {
        const area = this.probation.size ? this.probation : this.protected;
        const victim = first(area);
        if (this.sketch.estimate(candidate) > this.sketch.estimate(victim)) {
          area.delete(victim);
          this.probation.set(candidate, true);
        } // else: the candidate is dropped and the victim stays
      }
    }
    return false;
  }
}

/** Small FIFO (10%), main FIFO (90%) and a ghost FIFO of recently evicted keys (no values).
 *  A hit only bumps a 2-bit counter; nothing moves on a hit. */
class S3Fifo {
  constructor(capacity) {
    this.capacity = capacity;
    this.smallCap = Math.max(1, Math.floor(capacity / 10));
    this.small = [];
    this.main = [];
    this.freq = new Map();
    this.ghost = new Map();
    this.ghostCap = capacity - this.smallCap;
  }
  access(key) {
    if (this.freq.has(key)) {
      this.freq.set(key, Math.min(this.freq.get(key) + 1, 3));
      return true;
    }
    while (this.small.length + this.main.length >= this.capacity) {
      if (this.small.length >= this.smallCap || !this.main.length) this.evictSmall();
      else this.evictMain();
    }
    this.freq.set(key, 0);
    if (this.ghost.has(key)) { // seen recently and evicted too early: straight to main
      this.ghost.delete(key);
      this.main.push(key);
    } else {
      this.small.push(key);
    }
    return false;
  }
  evictSmall() {
    const key = this.small.shift();
    if (this.freq.get(key) > 0) { // used again while in small: keep it
      this.freq.set(key, 0);
      this.main.push(key);
    } else { // a one-hit wonder: drop it, remember only the key
      this.freq.delete(key);
      this.ghost.set(key, true);
      if (this.ghost.size > this.ghostCap) this.ghost.delete(first(this.ghost));
    }
  }
  evictMain() {
    for (;;) {
      const key = this.main.shift();
      if (this.freq.get(key) > 0) { // second chance: reinsert with one less
        this.freq.set(key, this.freq.get(key) - 1);
        this.main.push(key);
      } else {
        this.freq.delete(key);
        return;
      }
    }
  }
}

const POLICIES = { LRU: Lru, LFU: Lfu, 'W-TinyLFU': WTinyLfu, 'S3-FIFO': S3Fifo };

function zipfCdf(n) {
  const cdf = [];
  let total = 0;
  for (let k = 1; k <= n; k++) {
    total += 1 / k;
    cdf.push(total);
  }
  return cdf.map((c) => c / total);
}

function bisectRight(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < a[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** [key, counts] pairs. counts=false for the batch job's reads. */
function traffic(scenario) {
  const next = rng(SEED);
  const cdf = zipfCdf(KEYS);
  const out = [];
  let scanKey = KEYS;
  for (let i = 0; i < REQUESTS; i++) {
    if (scenario === 'scans' && i % 2 === 1) out.push([scanKey++, false]); // a batch job interleaved with the traffic
    let rank = bisectRight(cdf, next());
    if (scenario === 'shift' && i >= REQUESTS / 2) rank = KEYS - 1 - rank;
    out.push([rank, scenario !== 'shift' || i >= REQUESTS / 2]);
  }
  return out;
}

function run(policy, requests) {
  let hits = 0;
  let counted = 0;
  const warm = Math.floor(requests.length / 10); // skip the first 10% while the cache fills
  requests.forEach(([key, counts], i) => {
    const hit = policy.access(key);
    if (counts && i >= warm) {
      counted += 1;
      hits += hit ? 1 : 0;
    }
  });
  return hits / counted;
}

const cdf = zipfCdf(KEYS);
for (const scenario of ['steady', 'scans', 'shift']) {
  console.log(`\n${scenario}: hit ratio of the normal traffic`);
  console.log(`  ${'cache size'.padEnd(12)}${Object.keys(POLICIES).map((n) => n.padStart(11)).join('')}${'best static'.padStart(13)}`);
  for (const pct of [1, 5, 10]) {
    const capacity = (KEYS * pct) / 100;
    const requests = traffic(scenario);
    const row = Object.values(POLICIES).map((Make) => `${(100 * run(new Make(capacity), requests)).toFixed(1).padStart(10)}%`).join('');
    console.log(`  ${`${pct}% of keys`.padEnd(12)}${row}${(100 * cdf[capacity - 1]).toFixed(1).padStart(12)}%`);
  }
}
