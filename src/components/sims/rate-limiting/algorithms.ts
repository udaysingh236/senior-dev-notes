// The five rate limiting algorithms the sim runs. Same logic as examples/rate-limiting/, but
// with time passed in (simulated seconds) and state left public so the renderer can draw it.

export type AlgorithmId = 'token-bucket' | 'leaky-bucket' | 'fixed-window' | 'sliding-log' | 'sliding-counter';

export interface Outcome {
  allowed: boolean;
  /** Seconds until a request could pass; 0 when allowed. */
  retryAfter: number;
  /** Leaky bucket only: seconds this request waits in the queue before it reaches the API. */
  delay: number;
  /** Short reason for the event log. */
  note: string;
}

export interface Limiter {
  readonly id: AlgorithmId;
  tryAcquire(now: number): Outcome;
}

const EPS = 1e-9;
const s1 = (n: number) => `${n.toFixed(1)} s`;

export class TokenBucket implements Limiter {
  readonly id = 'token-bucket';
  readonly capacity: number;
  readonly rate: number;
  tokens: number;
  updated = 0;

  constructor(capacity: number, rate: number) {
    this.capacity = capacity;
    this.rate = rate;
    this.tokens = capacity;
  }

  /** Tokens at `now`, without changing state (for drawing). */
  level(now: number): number {
    return Math.min(this.capacity, this.tokens + Math.max(0, now - this.updated) * this.rate);
  }

  tryAcquire(now: number): Outcome {
    this.tokens = this.level(now);
    this.updated = now;
    if (this.tokens + EPS >= 1) {
      this.tokens = Math.max(0, this.tokens - 1);
      return { allowed: true, retryAfter: 0, delay: 0, note: `${Math.floor(this.tokens)} tokens left` };
    }
    const wait = (1 - this.tokens) / this.rate;
    return { allowed: false, retryAfter: wait, delay: 0, note: `bucket empty, next token in ${s1(wait)}` };
  }
}

export class LeakyBucketQueue implements Limiter {
  readonly id = 'leaky-bucket';
  readonly capacity: number;
  readonly rate: number;
  nextFree = 0;

  constructor(capacity: number, rate: number) {
    this.capacity = capacity;
    this.rate = rate;
  }

  /** Requests waiting in the queue at `now`. */
  waiting(now: number): number {
    return Math.max(0, (this.nextFree - now) * this.rate);
  }

  tryAcquire(now: number): Outcome {
    const start = Math.max(this.nextFree, now);
    const ahead = (start - now) * this.rate;
    if (ahead + 1 > this.capacity + EPS) {
      return { allowed: false, retryAfter: (ahead + 1 - this.capacity) / this.rate, delay: 0, note: 'queue full' };
    }
    this.nextFree = start + 1 / this.rate;
    const delay = start - now;
    return { allowed: true, retryAfter: 0, delay, note: delay > EPS ? `queued, waits ${s1(delay)}` : 'sent straight through' };
  }
}

export class FixedWindow implements Limiter {
  readonly id = 'fixed-window';
  readonly limit: number;
  readonly window: number;
  current = 0;
  count = 0;

  constructor(limit: number, window: number) {
    this.limit = limit;
    this.window = window;
  }

  /** Count in the window that contains `now` (zero if that window has not started counting). */
  countAt(now: number): number {
    return Math.floor(now / this.window) === this.current ? this.count : 0;
  }

  tryAcquire(now: number): Outcome {
    const n = Math.floor(now / this.window);
    if (n !== this.current) [this.current, this.count] = [n, 0];
    if (this.count < this.limit) {
      this.count++;
      return { allowed: true, retryAfter: 0, delay: 0, note: `${this.count} of ${this.limit} this window` };
    }
    const wait = (n + 1) * this.window - now;
    return { allowed: false, retryAfter: wait, delay: 0, note: `window full, resets in ${s1(wait)}` };
  }
}

export class SlidingLog implements Limiter {
  readonly id = 'sliding-log';
  readonly limit: number;
  readonly window: number;
  log: number[] = [];

  constructor(limit: number, window: number) {
    this.limit = limit;
    this.window = window;
  }

  prune(now: number): void {
    while (this.log.length && this.log[0] <= now - this.window) this.log.shift();
  }

  tryAcquire(now: number): Outcome {
    this.prune(now);
    if (this.log.length < this.limit) {
      this.log.push(now);
      return { allowed: true, retryAfter: 0, delay: 0, note: `${this.log.length} of ${this.limit} in the last ${this.window} s` };
    }
    const wait = this.log[0] + this.window - now;
    return { allowed: false, retryAfter: wait, delay: 0, note: `log full, oldest leaves in ${s1(wait)}` };
  }
}

export class SlidingWindowCounter implements Limiter {
  readonly id = 'sliding-counter';
  readonly limit: number;
  readonly window: number;
  current = 0;
  currentCount = 0;
  previousCount = 0;

  constructor(limit: number, window: number) {
    this.limit = limit;
    this.window = window;
  }

  /** Rolls the windows forward to `now`. */
  roll(now: number): void {
    const n = Math.floor(now / this.window);
    if (n === this.current) return;
    this.previousCount = n === this.current + 1 ? this.currentCount : 0;
    [this.current, this.currentCount] = [n, 0];
  }

  /** Share of the previous window still inside the sliding window, from 1 down to 0. */
  weight(now: number): number {
    return 1 - (now - Math.floor(now / this.window) * this.window) / this.window;
  }

  estimate(now: number): number {
    this.roll(now);
    return this.previousCount * this.weight(now) + this.currentCount;
  }

  tryAcquire(now: number): Outcome {
    const est = this.estimate(now);
    if (est + 1 <= this.limit + EPS) {
      this.currentCount++;
      return { allowed: true, retryAfter: 0, delay: 0, note: `estimate ${(est + 1).toFixed(1)} of ${this.limit}` };
    }
    const need = est + 1 - this.limit;
    const wait = this.previousCount ? (need / this.previousCount) * this.window : (this.current + 1) * this.window - now;
    return { allowed: false, retryAfter: wait, delay: 0, note: `estimate ${est.toFixed(1)} of ${this.limit} is full` };
  }
}

/** Builds a limiter. Buckets get capacity = limit and rate = limit / window. */
export function makeLimiter(id: AlgorithmId, limit: number, window: number): Limiter {
  const rate = limit / window;
  switch (id) {
    case 'token-bucket':
      return new TokenBucket(limit, rate);
    case 'leaky-bucket':
      return new LeakyBucketQueue(limit, rate);
    case 'fixed-window':
      return new FixedWindow(limit, window);
    case 'sliding-log':
      return new SlidingLog(limit, window);
    case 'sliding-counter':
      return new SlidingWindowCounter(limit, window);
  }
}
