// A latency histogram: count requests into buckets, merge servers, estimate percentiles.
//
// This is the production shape: each server keeps a few counters instead of every request,
// the counters from many servers add up, and the percentile is estimated from the totals.
//
// Run: node histogram.mjs

// Upper edges of the buckets, in ms. The last bucket catches everything slower.
const BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];

class Histogram {
  counts = new Array(BOUNDS_MS.length).fill(0);

  record(ms) {
    this.counts[BOUNDS_MS.findIndex((upper) => ms <= upper)] += 1;
  }

  merge(other) {
    // Merging is adding counts bucket by bucket. This is why histograms
    // combine and finished percentiles do not.
    this.counts = this.counts.map((c, i) => c + other.counts[i]);
  }

  /** Find the bucket holding the p-th percentile, then guess linearly inside it. */
  percentile(p) {
    const target = (p / 100) * this.counts.reduce((a, b) => a + b, 0); // at or below the answer
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const count = this.counts[i];
      if (seen + count >= target && count > 0) {
        const lower = i > 0 ? BOUNDS_MS[i - 1] : 0;
        const upper = BOUNDS_MS[i];
        if (upper === Infinity) return lower; // cannot guess inside an open-ended bucket
        return lower + ((upper - lower) * (target - seen)) / count;
      }
      seen += count;
    }
    return 0;
  }
}

function exactPercentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(Math.ceil((p / 100) * ordered.length), 1) - 1];
}

function mulberry32(seed) { // same generator as percentiles.mjs, so Python prints the same numbers
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(7);

// Server A: 9,000 requests, all fast. Server B: 1,000 requests, 150 of them slow (a bad disk).
const servers = {
  A: Array.from({ length: 9000 }, () => 20 + 30 * rand()),
  B: Array.from({ length: 1000 }, (_, i) => (i < 150 ? 600 + 300 * rand() : 20 + 30 * rand())),
};

const fleet = new Histogram();
const allValues = [];
const perServerP99 = [];
const ms = (v) => v.toFixed(0).padStart(6);
for (const [name, values] of Object.entries(servers)) {
  const h = new Histogram();
  for (const v of values) h.record(v);
  fleet.merge(h);
  allValues.push(...values);
  perServerP99.push(h.percentile(99));
  console.log(`server ${name}: ${String(values.length).padStart(5)} requests   p99 about ${ms(h.percentile(99))} ms`);
}

console.log(`\naverage of the two p99s      ${ms((perServerP99[0] + perServerP99[1]) / 2)} ms   <- wrong: no request took this`);
console.log(`p99 of the merged histogram  ${ms(fleet.percentile(99))} ms   <- estimate from bucket counts`);
console.log(`exact p99 of all requests    ${ms(exactPercentile(allValues, 99))} ms   <- needs every value`);
console.log(`\nbucket counts kept: ${BOUNDS_MS.length} numbers per server instead of ${allValues.length.toLocaleString('en-US')} values`);
