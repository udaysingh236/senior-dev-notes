// 600 clients fail at the same moment (say, a connection reset during a deploy) and retry with
// exponential backoff: retry k waits about 0.5 s × 2^(k-1), at most 6 retries. The server completes
// 60 attempts per 100 ms slot; attempts beyond that in a slot fail and back off again.
// The same model draws the jitter diagram on the page. Run: node jitter-storm.mjs

/** Mulberry32: a small seeded generator, so every run (and the Python twin) gives the same numbers. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLIENTS = 600, PER_SLOT = 60, SLOT_MS = 100, BASE_MS = 500, MAX_RETRIES = 6, SLOTS = 120;

const waits = {
  none: (d) => d, // everyone waits exactly the same
  '±20%': (d, r) => d * (0.8 + 0.4 * r()), // gRPC's jitter
  full: (d, r) => r() * d, // anywhere from 0 to d
};

function storm(kind) {
  const r = mulberry32(7);
  let pending = Array.from({ length: CLIENTS }, () => ({ at: 0, retry: 0 }));
  let done = 0, attempts = 0, lastDone = 0, peak = 0;
  for (let slot = 0; slot < SLOTS; slot++) {
    const lo = slot * SLOT_MS, hi = lo + SLOT_MS;
    const here = pending.filter((c) => c.at >= lo && c.at < hi);
    pending = pending.filter((c) => c.at >= hi);
    attempts += here.length;
    if (slot > 0) peak = Math.max(peak, here.length);
    for (let i = here.length - 1; i > 0; i--) { // shuffle: who gets served is random
      const j = Math.floor(r() * (i + 1));
      [here[i], here[j]] = [here[j], here[i]];
    }
    here.forEach((c, i) => {
      if (i < PER_SLOT) { done++; lastDone = hi; return; }
      const retry = c.retry + 1;
      if (retry > MAX_RETRIES) return;
      pending.push({ at: hi + waits[kind](BASE_MS * 2 ** (retry - 1), r), retry });
    });
  }
  return { done, attempts, lastDone, peak };
}

console.log('jitter   done in 12 s   last success   attempts   busiest retry slot');
for (const kind of Object.keys(waits)) {
  const s = storm(kind);
  console.log(`${kind.padEnd(8)} ${String(s.done).padStart(6)}/600 ${String(s.lastDone / 1000 + ' s').padStart(12)} ${s.attempts.toLocaleString('en-US').padStart(10)} ${String(s.peak).padStart(14)}`);
}
