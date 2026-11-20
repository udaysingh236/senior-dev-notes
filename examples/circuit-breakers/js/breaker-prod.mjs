// A production-shaped circuit breaker. What it adds to breaker.mjs:
// - a time window: the last 10 seconds in 1-second buckets, so old calls fall out on their own
// - a minimum number of calls before it may open
// - a classifier: timeouts, connection errors and 5xx count; 4xx (the caller's mistake) do not
// - slow calls count as failures
// - several trial calls in half-open, all of which must succeed
// - an open time that doubles after each failed trial, capped, with jitter
// - a state-change hook for metrics and alerts
//
// Run: node breaker-prod.mjs
import { mulberry32 } from './breaker.mjs';

/** status null means no answer: a timeout or a connection error. */
export function countsAsFailure(status, elapsedMs, slowMs) {
  if (status === null || status >= 500) return true;
  if (status >= 400) return false; // bad input, wrong ID, no permission: Reviews is fine
  return elapsedMs >= slowMs;
}

export class ProductionBreaker {
  constructor({
    windowS = 10, minCalls = 20, threshold = 0.5, slowMs = 1000, trials = 3,
    openMs = 5000, maxOpenMs = 60_000, jitter = 0.2, rand = Math.random, onChange = () => {},
  } = {}) {
    this.buckets = Array.from({ length: windowS }, () => ({ second: -1, calls: 0, failures: 0 }));
    Object.assign(this, { minCalls, threshold, slowMs, trials, openMs, maxOpenMs, jitter, rand, onChange });
    this.state = 'closed';
    this.openUntil = 0;
    this.failedTrials = 0;
    this.trialsStarted = 0;
    this.trialsPassed = 0;
  }

  // -- the window ------------------------------------------------------------------------------
  #bucket(nowMs) {
    const second = Math.floor(nowMs / 1000);
    const b = this.buckets[second % this.buckets.length];
    if (b.second !== second) Object.assign(b, { second, calls: 0, failures: 0 }); // wipe an old second
    return b;
  }

  #totals(nowMs) {
    const oldest = Math.floor(nowMs / 1000) - this.buckets.length + 1;
    const live = this.buckets.filter((b) => b.second >= oldest);
    return [live.reduce((s, b) => s + b.calls, 0), live.reduce((s, b) => s + b.failures, 0)];
  }

  // -- the states ------------------------------------------------------------------------------
  #open(nowMs, why) {
    let wait = Math.min(this.maxOpenMs, this.openMs * 2 ** this.failedTrials);
    wait *= 1 - this.jitter + 2 * this.jitter * this.rand(); // ±20% by default
    this.state = 'open';
    this.openUntil = nowMs + wait;
    this.onChange('open', nowMs, `${why}; trying again in ${(wait / 1000).toFixed(1)} s`);
  }

  allow(nowMs) {
    if (this.state === 'open' && nowMs >= this.openUntil) {
      Object.assign(this, { state: 'half_open', trialsStarted: 0, trialsPassed: 0 });
      this.onChange('half_open', nowMs, `letting ${this.trials} trial calls through`);
    }
    if (this.state === 'closed') return true;
    if (this.state === 'half_open' && this.trialsStarted < this.trials) {
      this.trialsStarted += 1;
      return true;
    }
    return false;
  }

  record(status, elapsedMs, nowMs) {
    const failed = countsAsFailure(status, elapsedMs, this.slowMs);
    if (this.state === 'half_open') {
      if (failed) {
        this.failedTrials += 1;
        this.#open(nowMs, 'a trial call failed');
      } else if (++this.trialsPassed === this.trials) {
        this.state = 'closed';
        this.failedTrials = 0;
        for (const b of this.buckets) b.second = -1; // forget the outage
        this.onChange('closed', nowMs, 'every trial call succeeded');
      }
      return;
    }
    if (this.state !== 'closed') return;
    const b = this.#bucket(nowMs);
    b.calls += 1;
    b.failures += failed ? 1 : 0;
    const [calls, failures] = this.#totals(nowMs);
    if (calls >= this.minCalls && failures / calls >= this.threshold) {
      this.#open(nowMs, `${failures} of the last ${calls} calls failed`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (state, now, why) => console.log(`  t=${(now / 1000).toFixed(2).padStart(6)}s  -> ${state.padEnd(9)} (${why})`);

  console.log('1. Every call returns 404 for 10 s (the caller asks for products that do not exist)');
  let br = new ProductionBreaker({ onChange: log });
  for (let i = 0; i < 2000; i++) {
    br.allow(i * 5);
    br.record(404, 30, i * 5);
  }
  console.log(`  still ${br.state}`);

  console.log('2. Quiet traffic: 2 calls a second, and 3 of the first 4 fail');
  br = new ProductionBreaker({ onChange: log });
  [503, 503, 200, 503, ...Array(16).fill(200)].forEach((status, i) => {
    br.allow(i * 500);
    br.record(status, 40, i * 500);
  });
  console.log(`  still ${br.state}: 4 calls are too few to judge`);

  console.log('3. 200 calls a second; Reviews answers in 2.5 s (slow, not dead) from 10 s to 40 s');
  br = new ProductionBreaker({ rand: mulberry32(3), onChange: log });
  const pending = []; // [ends at, elapsed]
  for (let i = 0; i < 60_000 / 5; i++) {
    const t = i * 5;
    pending.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    while (pending.length && pending[0][0] <= t) {
      const [ends, elapsed] = pending.shift();
      br.record(200, elapsed, ends);
    }
    if (br.allow(t)) {
      const elapsed = t >= 10_000 && t < 40_000 ? 2500 : 40;
      pending.push([t + elapsed, elapsed]);
    }
  }
}
