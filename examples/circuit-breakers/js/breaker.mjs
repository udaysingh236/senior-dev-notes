// Circuit breakers two ways, in front of a Reviews service that goes down for 20 seconds.
//
// 1. naive: count every failure ever, and stop calling after 10
// 2. breaker: closed / open / half-open, deciding from the last 20 calls
//
// The page service makes 200 calls a second to Reviews. Reviews is healthy (1 call in 1,000
// fails) until t = 10 s, then every call hangs until the 300 ms timeout, then it recovers at
// t = 30 s. Time is simulated; the breaker itself is what you would ship.
//
// Run: node breaker.mjs

/** Seeded generator shared with the Python twin, so both print the same numbers. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. Naive: count failures, stop after 10 -----------------------------------------------

export class NaiveBreaker {
  constructor(maxFailures = 10) {
    this.maxFailures = maxFailures;
    this.failures = 0; // never reset, never forgets
  }
  allow() {
    return this.failures < this.maxFailures; // once off, off for ever
  }
  record(ok) {
    if (!ok) this.failures += 1;
  }
}

// --- 2. A circuit breaker: closed, open, half-open ------------------------------------------

/**
 * Opens when at least `threshold` of the last `window` calls failed.
 * closed: calls go through; open: refused at once for `openMs`; half_open: one trial call.
 */
export class CircuitBreaker {
  constructor({ window = 20, threshold = 0.5, openMs = 5000, onChange = () => {} } = {}) {
    Object.assign(this, { window, threshold, openMs, onChange });
    this.state = 'closed';
    this.outcomes = []; // true = failed; the last `window` calls
    this.openedAt = 0;
    this.trialInFlight = false;
  }

  #move(state, nowMs) {
    this.state = state;
    this.onChange(state, nowMs);
  }

  /** Ask before every call. false means: do not call, use the fallback. */
  allow(nowMs) {
    if (this.state === 'open' && nowMs - this.openedAt >= this.openMs) this.#move('half_open', nowMs);
    if (this.state === 'closed') return true;
    if (this.state === 'half_open' && !this.trialInFlight) {
      this.trialInFlight = true; // this call is the trial
      return true;
    }
    return false;
  }

  /** Report how an allowed call ended. `trial` marks the half-open trial call. */
  record(ok, nowMs, trial = false) {
    if (trial) {
      this.trialInFlight = false;
      if (ok) {
        this.outcomes = []; // start counting afresh
        this.#move('closed', nowMs);
      } else {
        this.openedAt = nowMs;
        this.#move('open', nowMs);
      }
      return;
    }
    if (this.state !== 'closed') return; // started before the breaker opened; ignore it
    this.outcomes.push(!ok);
    if (this.outcomes.length > this.window) this.outcomes.shift();
    const full = this.outcomes.length === this.window; // never decide from fewer calls
    const failed = this.outcomes.filter(Boolean).length;
    if (full && failed / this.window >= this.threshold) {
      this.openedAt = nowMs;
      this.#move('open', nowMs);
    }
  }
}

// --- The simulation: 200 calls a second against a Reviews service that goes down -------------

const GAP_MS = 5; // one call every 5 ms = 200 calls a second
const TIMEOUT_MS = 300; // the page's timeout on Reviews
const DOWN_FROM = 10_000;
const UP_AT = 30_000;

/** [succeeded, how long the call held a worker] for a call starting at startMs. */
function reviews(startMs, rand, outage) {
  if (outage && startMs >= DOWN_FROM && startMs < UP_AT) return [false, TIMEOUT_MS];
  if (rand() < 0.001) return [false, 40]; // the odd healthy-day error
  return [true, 20 + 40 * rand()]; // 20-60 ms, 40 ms on average
}

function run(breaker, label, { outage = true, endMs = 40_000 } = {}) {
  const rand = mulberry32(7);
  const pending = []; // [ends at, ok, was the trial]
  let calls = 0;
  let refused = 0;
  let waitMsInOutage = 0;
  for (let t = 0; t < endMs; t += GAP_MS) {
    pending.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    while (pending.length && pending[0][0] <= t) {
      const [ends, ok, trial] = pending.shift();
      breaker?.record(ok, ends, trial);
    }
    if (!breaker || breaker.allow(t)) {
      const trial = breaker?.state === 'half_open';
      const [ok, held] = reviews(t, rand, outage);
      pending.push([t + held, ok, trial]);
      calls += 1;
      if (outage && t >= DOWN_FROM && t < UP_AT) waitMsInOutage += held;
    } else {
      refused += 1; // fallback: page without reviews, at once
    }
  }
  const n = (x, w) => x.toLocaleString('en-US').padStart(w);
  const outageS = (UP_AT - DOWN_FROM) / 1000;
  const waiting = `   workers waiting on Reviews in the outage: ${(waitMsInOutage / 1000 / outageS).toFixed(1).padStart(5)}`;
  console.log(`${label.padEnd(10)} calls made ${n(calls, 7)}   refused ${n(refused, 7)}` + (outage ? waiting : ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (state, now) => console.log(`  t=${(now / 1000).toFixed(3).padStart(6)}s  breaker -> ${state}`);
  console.log('40 s, Reviews down from 10 s to 30 s');
  run(null, 'none');
  run(new NaiveBreaker(), 'naive');
  console.log('Circuit breaker (last 20 calls, open at 50%, 5 s open):');
  run(new CircuitBreaker({ onChange: log }), 'breaker');
  console.log('\n10 healthy minutes, 1 call in 1,000 fails, no outage at all');
  run(new NaiveBreaker(), 'naive', { outage: false, endMs: 600_000 });
  run(new CircuitBreaker({ onChange: log }), 'breaker', { outage: false, endMs: 600_000 });
}
