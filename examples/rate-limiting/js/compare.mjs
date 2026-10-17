// Run every limiter on the same traffic and measure what actually got through.
//
// All six are configured as "10 requests per 10 seconds" (bucket of 10 refilling at 1 per
// second). For each traffic pattern we print how many requests were accepted and the most
// that got through in any 10 s span and in any 1 s span.
//
// Run:  node compare.mjs
import {
  GCRA, FixedWindow, LeakyBucketQueue, SlidingLog, SlidingWindowCounter, TokenBucket, fakeClock,
} from './limiters.mjs';

const LIMIT = 10;
const WINDOW = 10;
const RATE = LIMIT / WINDOW; // 1 request per second

const makeLimiters = (clock) => ({
  'token bucket': new TokenBucket(LIMIT, RATE, clock),
  GCRA: new GCRA(LIMIT, RATE, clock),
  'leaky bucket (queue)': new LeakyBucketQueue(LIMIT, RATE, clock),
  'fixed window': new FixedWindow(LIMIT, WINDOW, clock),
  'sliding log': new SlidingLog(LIMIT, WINDOW, clock),
  'sliding counter': new SlidingWindowCounter(LIMIT, WINDOW, clock),
});

/** Most timestamps inside any half-open interval [t, t + span). */
function peak(times, span) {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  sorted.forEach((t, end) => {
    while (t - sorted[start] >= span - 1e-9) start++;
    best = Math.max(best, end - start + 1);
  });
  return best;
}

/** Ten requests just before a window boundary, ten right on it. */
const boundaryAttack = () => [...Array(10).fill(9.9), ...Array(10).fill(10)];

/** A burst of 6 requests every 2 seconds for a minute: 3 req/s on average, 3x the limit. */
function burstyOverload() {
  const times = [];
  for (let start = 0; start < 60; start += 2) {
    for (let i = 0; i < 6; i++) times.push(Math.round((start + i * 0.05) * 100) / 100);
  }
  return times;
}

/** Ten at the very end of one window, then one every 0.1 s through the next. */
const lateBurstThenSteady = () => [
  ...Array(10).fill(9.9),
  ...Array.from({ length: 100 }, (_, i) => Math.round((10 + i * 0.1) * 10) / 10),
];

function run(name, arrivals) {
  const clock = fakeClock();
  const limiters = makeLimiters(clock);
  const passed = Object.fromEntries(Object.keys(limiters).map((k) => [k, []]));
  for (const t of arrivals) {
    clock.now = t;
    for (const [label, limiter] of Object.entries(limiters)) {
      const d = limiter.tryAcquire();
      // For the queue, what reaches the server is when the request leaves the queue.
      if (d.allowed) passed[label].push(t + d.delay);
    }
  }
  console.log(`\n${name}: ${arrivals.length} requests`);
  console.log(`  ${'algorithm'.padEnd(22)}${'accepted'.padStart(9)}${'peak in 10 s'.padStart(14)}${'peak in 1 s'.padStart(13)}`);
  for (const [label, times] of Object.entries(passed)) {
    console.log(`  ${label.padEnd(22)}${String(times.length).padStart(9)}${String(peak(times, 10)).padStart(14)}${String(peak(times, 1)).padStart(13)}`);
  }
}

run('Boundary attack', boundaryAttack());
run('Bursty overload (6 every 2 s for 60 s)', burstyOverload());
run('Late burst, then steady', lateBurstThenSteady());
