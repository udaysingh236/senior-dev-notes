// Many balancers, one pool: how each picking rule copes with a slow backend and a partial view.
//
// Eight backends serve one request at a time, 10 ms of work on average (random, exponential).
// Backend 0 is three times slower. Requests arrive at random, each through one of B balancers.
// Every rule sees the same arrivals and the same work per request. Rules:
//
//   round robin       each balancer cycles through the backends on its own
//   least (stale)     everyone reads one shared table of in-flight counts, refreshed every 500 ms,
//                     and picks the smallest
//   P2C (stale)       the same stale table, but compare two random backends
//   P2C (own)         each balancer compares two random backends by its own in-flight requests
//   peak EWMA (own)   each balancer compares two by (its latency estimate) x (its in-flight + 1)
//
// Run: node fleet.mjs

const N = 8;
const SERVICE_MS = 10;
const SLOW = 3;
const CAPACITY = (N - 1) / SERVICE_MS + 1 / (SERVICE_MS * SLOW); // requests per ms the pool can finish

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
  return { exp: (mean) => -Math.log(1 - next()) * mean, below: (n) => Math.floor(next() * n) };
}

function two(r) {
  const a = r.below(N);
  const b = r.below(N - 1);
  return [a, b >= a ? b + 1 : b];
}

/** Latency estimate: jumps up to a slower sample at once, eases down on faster ones,
 *  and fades towards zero while no samples arrive, so a backend that was slow gets retried. */
class PeakEwma {
  static TAU_MS = 1000;
  static ALPHA = 0.3;
  value = SERVICE_MS;
  at = 0;
  read(now) { // fades towards zero between samples
    return this.value * Math.exp(-(now - this.at) / PeakEwma.TAU_MS);
  }
  observe(sample, now) {
    const current = this.read(now); // up at once, down slowly
    this.value = sample > current ? sample : current + PeakEwma.ALPHA * (sample - current);
    this.at = now;
  }
}

function pickPeakEwma(ewma, own, now, r) {
  const [a, b] = two(r); // two different random backends
  const cost = (i) => ewma[i].read(now) * (own[i] + 1);
  return cost(a) <= cost(b) ? a : b;
}

/** A binary min-heap of [finish time, backend, balancer, latency], ordered like Python's tuples. */
class Heap {
  items = [];
  less(a, b) {
    for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }
  push(x) {
    const h = this.items;
    h.push(x);
    for (let i = h.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop() {
    const h = this.items;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
  peek() {
    return this.items[0];
  }
}

/** Returns [p50 ms, p99 ms, % of requests sent to the slow backend]. refreshMs 0 = a live table. */
function run(rule, balancers, load, refreshMs = 500, seconds = 60) {
  const arrivals = rng(7);
  const work = rng(11);
  const r = rng(42);
  const freeAt = new Array(N).fill(0);
  const inflight = new Array(N).fill(0); // true counts
  const own = Array.from({ length: balancers }, () => new Array(N).fill(0)); // each balancer's own counts
  const ewma = Array.from({ length: balancers }, () => Array.from({ length: N }, () => new PeakEwma()));
  let table = new Array(N).fill(0); // the shared, stale view
  let nextRefresh = 0;
  const rr = Array.from({ length: balancers }, (_, b) => b % N);
  const done = new Heap();
  const latencies = [];
  const sent = new Array(N).fill(0);
  const finishUntil = (when) => {
    while (done.peek() && done.peek()[0] <= when) {
      const [at, k, b, lat] = done.pop();
      inflight[k] -= 1;
      own[b][k] -= 1;
      ewma[b][k].observe(lat, at);
    }
  };
  let t = 0;
  while (t < seconds * 1000) {
    t += arrivals.exp(1 / (load * CAPACITY));
    const lb = arrivals.below(balancers);
    const base = work.exp(SERVICE_MS);

    while (refreshMs && nextRefresh <= t) {
      finishUntil(nextRefresh);
      table = inflight.slice();
      nextRefresh += refreshMs;
    }
    finishUntil(t);
    if (!refreshMs) table = inflight; // a live view: every balancer reads the true counts

    let k;
    if (rule === 'round robin') {
      k = rr[lb];
      rr[lb] = (k + 1) % N;
    } else if (rule === 'least (stale)') {
      const low = Math.min(...table);
      const ties = [];
      for (let i = 0; i < N; i++) if (table[i] === low) ties.push(i);
      k = ties[r.below(ties.length)];
    } else if (rule === 'P2C (stale)') {
      const [a, b] = two(r);
      k = table[a] <= table[b] ? a : b;
    } else if (rule === 'P2C (own)') {
      const [a, b] = two(r);
      k = own[lb][a] <= own[lb][b] ? a : b;
    } else {
      k = pickPeakEwma(ewma[lb], own[lb], t, r);
    }

    const service = base * (k === 0 ? SLOW : 1);
    const start = Math.max(t, freeAt[k]);
    freeAt[k] = start + service;
    inflight[k] += 1;
    own[lb][k] += 1;
    sent[k] += 1;
    done.push([freeAt[k], k, lb, freeAt[k] - t]);
    if (t > 5000) latencies.push(freeAt[k] - t); // skip the first 5 s while queues settle
  }
  latencies.sort((a, b) => a - b);
  const total = sent.reduce((a, b) => a + b, 0);
  return [latencies[Math.floor(latencies.length / 2)], latencies[Math.floor(latencies.length * 0.99)], (100 * sent[0]) / total];
}

const f = (x, w) => x.toFixed(1).padStart(w);
const rules = ['round robin', 'least (stale)', 'P2C (stale)', 'P2C (own)', 'peak EWMA (own)'];
console.log("8 backends, 10 ms of work each; backend 0 is 3x slower (its fair share is 4.5%)");
for (const balancers of [1, 50]) {
  console.log(`\n${balancers} balancer${balancers > 1 ? 's' : ''}, 70% of pool capacity, shared table 500 ms old:`);
  for (const rule of rules) {
    const [p50, p99, slow] = run(rule, balancers, 0.7);
    console.log(`  ${rule.padEnd(16)} p50 ${f(p50, 7)} ms   p99 ${f(p99, 8)} ms   slow backend got ${f(slow, 4)}%`);
  }
}
console.log('\nOne balancer, 70% load: p99 as the shared table gets older');
for (const refresh of [0, 20, 100, 500]) {
  const least = run('least (stale)', 1, 0.7, refresh)[1];
  const p2c = run('P2C (stale)', 1, 0.7, refresh)[1];
  console.log(`  ${(refresh ? `${refresh} ms old` : 'live').padStart(10)}   least ${f(least, 7)} ms   P2C ${f(p2c, 6)} ms`);
}
