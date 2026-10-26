// How latency grows with utilisation: a queue simulated request by request.
//
// One server, random (Poisson) arrivals, 10 ms of work per request on average. For each utilisation
// it simulates 200,000 requests and prints the measured mean latency next to the formula, then
// checks Little's law and compares four separate queues with one shared queue for four servers.
//
// Run: node queue-lab.mjs

const S = 10; // mean service time, ms
const N = 200_000;

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

/** Returns [mean latency in ms, time-averaged number in the system] for one shared FIFO queue. */
function simulate(utilisation, servers = 1, fixedService = false, seed = 42) {
  const r = rng(seed);
  const arrivalGap = S / (utilisation * servers);
  const freeAt = new Array(servers).fill(0); // when each server becomes free
  let t = 0;
  let totalLatency = 0;
  const events = []; // [time, +1 for an arrival or -1 for a departure]
  for (let i = 0; i < N; i++) {
    t += r.exp(arrivalGap);
    let k = 0; // the server that frees up first
    for (let j = 1; j < servers; j++) if (freeAt[j] < freeAt[k]) k = j;
    const start = Math.max(t, freeAt[k]);
    const service = fixedService ? S : r.exp(S);
    freeAt[k] = start + service;
    totalLatency += freeAt[k] - t;
    events.push([t, 1], [freeAt[k], -1]);
  }
  // Count how many requests are in the system at every moment, and average it over time.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let area = 0;
  let count = 0;
  let last = 0;
  for (const [when, change] of events) {
    area += count * (when - last);
    count += change;
    last = when;
  }
  return [totalLatency / N, area / last];
}

const pct = (u) => `${Math.round(u * 100)}%`;
console.log('One server, 10 ms of work per request on average');
console.log(`${'utilisation'.padStart(11)}  ${'measured'.padStart(9)}  ${'formula S/(1-u)'.padStart(15)}  ${'fixed-time work'.padStart(15)}`);
for (const u of [0.5, 0.7, 0.8, 0.9, 0.95]) {
  const [mean] = simulate(u);
  const [fixed] = simulate(u, 1, true);
  console.log(`${pct(u).padStart(11)}  ${mean.toFixed(1).padStart(7)} ms  ${(S / (1 - u)).toFixed(1).padStart(12)} ms  ${fixed.toFixed(1).padStart(12)} ms`);
}

const [mean, inSystem] = simulate(0.8);
console.log(`\nLittle's law at 80%: 0.08 requests/ms x ${mean.toFixed(1)} ms = ${(0.08 * mean).toFixed(2)} predicted in the system; counted over time: ${inSystem.toFixed(2)}`);

console.log('\nFour servers at 80% each');
const [separate] = simulate(0.8); // each server with its own queue is one M/M/1
const [shared] = simulate(0.8, 4);
console.log(`  four separate queues: ${separate.toFixed(1)} ms`);
console.log(`  one shared queue:     ${shared.toFixed(1)} ms`);
