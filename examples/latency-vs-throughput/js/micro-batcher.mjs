// A micro-batcher in front of a backend with a fixed cost per call, measured with real timers.
//
// The backend handles one call at a time (one disk, one connection) and each call costs 2 ms plus
// 0.05 ms per item. Writes arrive at random at a fixed rate (an open load: arrivals do not wait for
// earlier writes to finish). Two writers:
//
//   one at a time   one backend call per write
//   batched         collect what is waiting; if only one or two writes are queued, wait up to 2 ms
//                   for company; then send up to 100 in one call
//
// Run: node micro-batcher.mjs   (timings vary a little from run to run; Node's timers are coarser
// than Python's, so absolute numbers differ between the two)

import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const OVERHEAD_MS = 2;
const PER_ITEM_MS = 0.05;

class Backend {
  calls = 0;
  #tail = Promise.resolve(); // one call at a time: each call waits for the previous one

  write(items) {
    const run = this.#tail.then(async () => {
      this.calls++;
      await sleep(OVERHEAD_MS + PER_ITEM_MS * items.length);
    });
    this.#tail = run;
    return run;
  }
}

class Batcher {
  pending = []; // [item, resolve]
  #wake = null;

  constructor(backend, windowMs = 2, maxBatch = 100) {
    Object.assign(this, { backend, windowMs, maxBatch, stopped: false });
    this.loop = this.run();
  }

  write(item) {
    return new Promise((resolve) => {
      this.pending.push([item, resolve]);
      this.#wake?.(); // resolves when the batch containing this write is stored
    });
  }

  async run() {
    while (!this.stopped) {
      if (!this.pending.length) await new Promise((r) => (this.#wake = r));
      this.#wake = null;
      if (this.stopped) return;
      if (this.pending.length < 3) await sleep(this.windowMs); // a lone write waits a little for company
      const batch = this.pending.splice(0, this.maxBatch);
      await this.backend.write(batch.map(([item]) => item));
      for (const [, resolve] of batch) resolve();
    }
  }

  stop() {
    this.stopped = true;
    this.#wake?.();
  }
}

/** Seeded exponential gaps (mulberry32), so both runs offer the same arrivals. */
function gaps(seed, rate) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return -Math.log(1 - ((t ^ (t >>> 14)) >>> 0) / 4294967296) / rate;
  };
}

async function runLoad(rate, batched, seconds = 2) {
  const backend = new Backend();
  const batcher = batched ? new Batcher(backend) : null;
  const next = gaps(42, rate);
  const latencies = [];
  const one = async (i) => {
    const start = performance.now();
    await (batcher ? batcher.write(i) : backend.write([i]));
    latencies.push(performance.now() - start);
  };

  const begin = performance.now();
  const tasks = [];
  for (let at = next(); at < seconds; at += next()) {
    // open load: start each write on schedule, whatever the others are doing
    const wait = begin + at * 1000 - performance.now();
    if (wait > 0) await sleep(wait);
    tasks.push(one(tasks.length));
  }
  await Promise.all(tasks);
  const took = (performance.now() - begin) / 1000;
  batcher?.stop();
  latencies.sort((a, b) => a - b);
  const q = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  const label = batched ? 'batched' : 'one at a time';
  return `  ${label.padEnd(13)} ${(latencies.length / took).toFixed(0).padStart(6)} writes/s   p50 ${q(50).toFixed(1).padStart(7)} ms   p99 ${q(99).toFixed(1).padStart(7)} ms   ${backend.calls} backend calls`;
}

for (const rate of [100, 400, 1000]) {
  console.log(`${rate} writes/s offered for 2 s:`);
  console.log(await runLoad(rate, false));
  console.log(await runLoad(rate, true));
}
