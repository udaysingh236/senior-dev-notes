// Six rate limiting algorithms, in-process, no dependencies.
//
// Every limiter takes an injectable clock (a function returning seconds), so the same code
// runs against real time in a server and against a fake clock in tests and compare.mjs.
// Each tryAcquire() returns a decision the HTTP layer can turn into a 429 with Retry-After.
//
// Run the self-checks:  node limiters.mjs
import { fileURLToPath } from 'node:url';

/** @typedef {() => number} Clock  seconds */
/** @typedef {{ allowed: boolean, remaining: number, retryAfter: number, delay: number }} Decision */

const monotonic = () => performance.now() / 1000;
const EPS = 1e-9;

/** @returns {Decision} */
const decision = (allowed, remaining, retryAfter = 0, delay = 0) => ({ allowed, remaining, retryAfter, delay });

/**
 * Bucket of `capacity` tokens, refilled at `rate` tokens per second. One request = one token.
 * The refill is computed lazily from elapsed time, so the state is two numbers.
 */
export class TokenBucket {
  constructor(capacity, rate, clock = monotonic) {
    Object.assign(this, { capacity, rate, clock });
    this.tokens = capacity; // start full: a new client may burst immediately
    this.updated = clock();
  }

  tryAcquire(cost = 1) {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.updated); // never refill backwards if the clock jumps
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.updated = now;
    // A tiny tolerance: ten refills of 0.1 add up to 0.9999999999999999, not 1.
    if (this.tokens + EPS >= cost) {
      this.tokens = Math.max(0, this.tokens - cost);
      return decision(true, Math.floor(this.tokens));
    }
    return decision(false, 0, (cost - this.tokens) / this.rate);
  }
}

/**
 * Leaky bucket as a queue: requests wait their turn and leave at exactly `rate` per second.
 * We track `nextFree`, the moment the next request may run, instead of a real queue.
 */
export class LeakyBucketQueue {
  constructor(capacity, rate, clock = monotonic) {
    Object.assign(this, { capacity, rate, clock });
    this.nextFree = clock();
  }

  tryAcquire() {
    const now = this.clock();
    const start = Math.max(this.nextFree, now);
    const waiting = (start - now) * this.rate; // requests already queued ahead of this one
    if (waiting + 1 > this.capacity + EPS) {
      return decision(false, 0, (waiting + 1 - this.capacity) / this.rate);
    }
    this.nextFree = start + 1 / this.rate;
    return decision(true, Math.floor(this.capacity - waiting - 1), 0, start - now);
  }
}

/**
 * Generic cell rate algorithm: a token bucket stored as ONE timestamp. `tat` (theoretical
 * arrival time) moves forward one interval per request; allow while it is at most `burst`
 * intervals ahead of now.
 */
export class GCRA {
  constructor(burst, rate, clock = monotonic) {
    this.interval = 1 / rate;
    this.tolerance = burst * this.interval;
    this.clock = clock;
    this.tat = clock();
  }

  tryAcquire() {
    const now = this.clock();
    const newTat = Math.max(this.tat, now) + this.interval;
    const allowAt = newTat - this.tolerance;
    if (now + EPS < allowAt) return decision(false, 0, allowAt - now);
    this.tat = newTat;
    return decision(true, Math.floor((this.tolerance - (newTat - now)) / this.interval + EPS));
  }
}

/** At most `limit` requests per window of `window` seconds, windows aligned to the clock. */
export class FixedWindow {
  constructor(limit, window, clock = monotonic) {
    Object.assign(this, { limit, window, clock });
    this.current = -1;
    this.count = 0;
  }

  tryAcquire() {
    const now = this.clock();
    const number = Math.floor(now / this.window);
    if (number !== this.current) [this.current, this.count] = [number, 0]; // new window
    if (this.count < this.limit) {
      this.count += 1;
      return decision(true, this.limit - this.count);
    }
    return decision(false, 0, (number + 1) * this.window - now);
  }
}

/** Exact: keep the timestamp of every accepted request in the last `window` seconds. */
export class SlidingLog {
  constructor(limit, window, clock = monotonic) {
    Object.assign(this, { limit, window, clock });
    this.log = [];
  }

  tryAcquire() {
    const now = this.clock();
    while (this.log.length && this.log[0] <= now - this.window) this.log.shift();
    if (this.log.length < this.limit) {
      this.log.push(now);
      return decision(true, this.limit - this.log.length);
    }
    return decision(false, 0, this.log[0] + this.window - now);
  }
}

/**
 * Approximate sliding window from two fixed-window counters:
 * estimate = previous * (share of previous window still inside the sliding window) + current.
 * It assumes the previous window's requests were evenly spread.
 */
export class SlidingWindowCounter {
  constructor(limit, window, clock = monotonic) {
    Object.assign(this, { limit, window, clock });
    this.current = -1;
    this.currentCount = 0;
    this.previousCount = 0;
  }

  estimate(now) {
    const number = Math.floor(now / this.window);
    if (number !== this.current) {
      // Moved on by one window: current becomes previous. Moved on by more: both empty.
      this.previousCount = number === this.current + 1 ? this.currentCount : 0;
      [this.current, this.currentCount] = [number, 0];
    }
    const elapsed = (now - number * this.window) / this.window; // 0 at the start, ~1 at the end
    return this.previousCount * (1 - elapsed) + this.currentCount;
  }

  tryAcquire() {
    const now = this.clock();
    const estimate = this.estimate(now);
    if (estimate + 1 <= this.limit + EPS) {
      this.currentCount += 1;
      return decision(true, Math.floor(this.limit - estimate - 1));
    }
    const need = estimate + 1 - this.limit; // the estimate falls as the previous window slides out
    const wait = this.previousCount
      ? (need / this.previousCount) * this.window
      : (this.current + 1) * this.window - now;
    return decision(false, 0, wait);
  }
}

/** A clock you move by hand, so tests and comparisons are exact and instant. */
export function fakeClock(start = 0) {
  const clock = () => clock.now;
  clock.now = start;
  return clock;
}

function selfCheck() {
  const clock = fakeClock();
  const count = (limiter, n) => Array.from({ length: n }, () => limiter.tryAcquire()).filter((d) => d.allowed).length;

  const bucket = new TokenBucket(10, 5, clock);
  const burst = count(bucket, 40);
  clock.now += 1;
  console.log(`token bucket  C=10 r=5/s: burst of 40 -> ${burst} pass, one second later ${count(bucket, 40)} more`);

  clock.now = 0;
  const gcra = new GCRA(10, 5, clock);
  const gBurst = count(gcra, 40);
  clock.now += 1;
  console.log(`GCRA          burst=10 r=5/s: burst of 40 -> ${gBurst} pass, one second later ${count(gcra, 40)} more`);

  clock.now = 9.9;
  const window = new FixedWindow(10, 10, clock);
  const first = count(window, 10);
  clock.now = 10;
  const second = count(window, 10);
  console.log(`fixed window  10 per 10 s: ${first} at t=9.9 s + ${second} at t=10.0 s = ${first + second} in 0.1 s`);

  clock.now = 0;
  const counter = new SlidingWindowCounter(100, 60, clock);
  counter.estimate(60); // roll into window 1
  counter.currentCount = 80;
  counter.estimate(120); // roll into window 2: previous = 80
  counter.currentCount = 30;
  clock.now = 120 + 0.4 * 60;
  console.log(`sliding counter: prev 80, curr 30, 40% in -> estimate ${counter.estimate(clock.now).toFixed(1)}`);

  clock.now = 0;
  const leaky = new LeakyBucketQueue(5, 1, clock);
  const results = Array.from({ length: 8 }, () => leaky.tryAcquire());
  const delays = results.filter((r) => r.allowed).map((r) => Number(r.delay.toFixed(1)));
  console.log(`leaky queue   5 slots, 1/s: burst of 8 -> waits [${delays.join(', ')}], ${results.filter((r) => !r.allowed).length} rejected`);
}

// Run the self-checks only when this file is executed directly, not when it is imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) selfCheck();
