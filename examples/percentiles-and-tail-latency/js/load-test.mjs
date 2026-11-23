// Coordinated omission: a load test that waits for each answer hides a 1-second freeze.
//
// A server answers each request in 10 ms, one at a time. From t = 5.0 s to t = 6.0 s it freezes
// (think: a long garbage-collection pause). The test wants to send one request every 20 ms
// (50 a second) for 10 seconds. Simulated time, so it runs instantly and prints the same every time.
//
// Run: node load-test.mjs

const SERVICE_MS = 10;
const INTERVAL_MS = 20;
const RUN_MS = 10_000;
const FREEZE_START = 5_000;
const FREEZE_END = 6_000;

/** When a request that arrives at `arrive` gets its answer (one request at a time). */
function serverFinish(arrive, serverFreeAt) {
  let start = Math.max(arrive, serverFreeAt);
  if (start >= FREEZE_START && start < FREEZE_END) start = FREEZE_END; // frozen: nothing starts
  let finish = start + SERVICE_MS;
  if (start < FREEZE_START && FREEZE_START < finish) finish += FREEZE_END - FREEZE_START; // paused mid-way
  return finish;
}

function p(values, pct) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(Math.ceil((pct / 100) * ordered.length), 1) - 1];
}

/** Naive tester: send, WAIT for the answer, then send the next one.
 *  Latency is measured from when the request was actually sent. */
function closedLoop() {
  const latencies = [];
  let now = 0;
  let freeAt = 0;
  while (now < RUN_MS) {
    const done = serverFinish(now, freeAt);
    freeAt = done;
    latencies.push(done - now);
    now = Math.max(now + INTERVAL_MS, done); // cannot send the next one before this answer
  }
  return latencies;
}

/** Correct tester: send on schedule whatever happens (like real users do).
 *  Latency is measured from when the request was SUPPOSED to be sent. */
function openLoop() {
  const latencies = [];
  let freeAt = 0;
  for (let planned = 0; planned < RUN_MS; planned += INTERVAL_MS) {
    const done = serverFinish(planned, freeAt);
    freeAt = done;
    latencies.push(done - planned);
  }
  return latencies;
}

const f = (v) => v.toFixed(0).padStart(5);
for (const [name, lat] of [['waits for each answer', closedLoop()], ['sends on schedule', openLoop()]]) {
  const slow = lat.filter((x) => x > 100).length;
  console.log(
    `${name.padEnd(22)} ${String(lat.length).padStart(4)} requests   p50 ${f(p(lat, 50))} ms   ` +
      `p99 ${f(p(lat, 99))} ms   max ${f(Math.max(...lat))} ms   over 100 ms: ${slow}`,
  );
}
