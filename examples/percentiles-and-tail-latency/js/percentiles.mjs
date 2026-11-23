// Average vs percentiles, then fan-out: why one slow call in 100 slows most pages.
//
// Run: node percentiles.mjs

// ---- 1. The ten requests from the page -------------------------------------------------------
const tenMs = [45, 52, 40, 2000, 48, 55, 42, 60, 50, 45];

/** The naive summary: add everything up, divide by how many. */
const average = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/** Nearest-rank percentile: sort, then take the value at rank ceil(p/100 * n). */
function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b); // numeric sort, not the default text sort
  const rank = Math.ceil((p / 100) * ordered.length); // 1-based rank
  return ordered[Math.max(rank, 1) - 1];
}

const ms = (v, w = 7) => v.toFixed(1).padStart(w);
console.log('ten requests, sorted:', `[${[...tenMs].sort((a, b) => a - b).join(', ')}]`);
console.log(`average  ${ms(average(tenMs))} ms   <- nobody waited this long`);
for (const p of [50, 90, 100]) console.log(`p${String(p).padEnd(3)}     ${ms(percentile(tenMs, p))} ms`);

// ---- 2. A seeded random generator, identical in the Python and JavaScript versions ------------
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);

/** One backend call: 99 in 100 take 20-50 ms, 1 in 100 takes 500-1,500 ms. */
function oneCall() {
  if (rand() < 0.01) return 500 + 1000 * rand();
  return 20 + 30 * rand();
}

// ---- 3. Fan-out: a page waits for its slowest call ---------------------------------------------
const PAGES = 100_000;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`\n${PAGES.toLocaleString('en-US')} pages, each calling N backends in parallel (page time = slowest call)`);
console.log('    N   page p50   page p99   pages over 100 ms   predicted 1 - 0.99^N');
for (const n of [1, 10, 100]) {
  const pages = [];
  for (let i = 0; i < PAGES; i++) {
    let slowest = 0;
    for (let c = 0; c < n; c++) slowest = Math.max(slowest, oneCall());
    pages.push(slowest);
  }
  const slow = pages.filter((t) => t > 100).length / PAGES;
  console.log(
    `  ${String(n).padStart(3)}   ${percentile(pages, 50).toFixed(0).padStart(5)} ms   ` +
      `${percentile(pages, 99).toFixed(0).padStart(5)} ms   ${pct(slow).padStart(16)}   ${pct(1 - 0.99 ** n).padStart(18)}`,
  );
}

// ---- 4. Hedging: if a call is not back after 50 ms, ask a second copy and take the first answer
function hedgedCall(hedgeAfterMs = 50) {
  const first = oneCall();
  if (first <= hedgeAfterMs) return [first, 1];
  const second = hedgeAfterMs + oneCall(); // the backup starts late
  return [Math.min(first, second), 2];
}

console.log('\nN = 10 with hedging after 50 ms');
let calls = 0;
const hedgedPages = [];
for (let i = 0; i < PAGES; i++) {
  let slowest = 0;
  for (let c = 0; c < 10; c++) {
    const [t, sent] = hedgedCall();
    calls += sent;
    slowest = Math.max(slowest, t);
  }
  hedgedPages.push(slowest);
}
const slowHedged = hedgedPages.filter((t) => t > 100).length / PAGES;
console.log(
  `   10   ${percentile(hedgedPages, 50).toFixed(0).padStart(5)} ms   ${percentile(hedgedPages, 99).toFixed(0).padStart(5)} ms   ` +
    `${pct(slowHedged).padStart(16)}   extra calls sent: ${pct(calls / (PAGES * 10) - 1)}`,
);
