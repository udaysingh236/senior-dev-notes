// Retries three ways, against a dependency that fails 5%, 20% or 100% of the time.
//
// 1. naive: retry at once, on any error
// 2. backoff: only transient errors, capped exponential backoff with full jitter, inside a deadline
// 3. budget: the same, plus a retry budget that lets retries add at most 10% to the load
//
// The dependency and the clock are fakes so the run takes a second, not minutes: `sleep` moves a
// virtual clock forward instead of waiting. The retry code itself is what you would ship.
//
// Run: node retries.mjs

/** Worth retrying: a timeout, a reset connection, 503, 429. May carry the server's Retry-After. */
export class TransientError extends Error {
  constructor(message = '', retryAfter = null) {
    super(message);
    this.retryAfter = retryAfter;
  }
}
/** Not worth retrying: 400, 403, 404, 422. A second try repeats the mistake. */
export class PermanentError extends Error {}

// --- 1. Naive: what most retry loops look like ---------------------------------------------------

export async function callNaive(fn, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) { // retries bugs and bad input too
      if (attempt === retries) throw err;
    }
  }
  // No wait between tries and no deadline: every client hits the server again at once.
}

// --- 2. Correct: classify, back off with full jitter, respect the deadline -----------------------

/** Full jitter: anywhere between 0 and the capped exponential (base, 2×base, 4×base...). */
export function backoffDelay(retry, base, cap, random = Math.random) {
  return random() * Math.min(cap, base * 2 ** (retry - 1));
}

/** Retries may add at most `ratio` extra load. Share one per client process and dependency. */
export class RetryBudget {
  constructor(ratio = 0.1, maxTokens = 10) {
    Object.assign(this, { ratio, maxTokens, tokens: maxTokens });
  }
  onRequest() { this.tokens = Math.min(this.maxTokens, this.tokens + this.ratio); } // earn a fraction
  trySpend() { // spend a whole one
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
// Node runs this on one thread, so no lock is needed; in a worker pool, keep one per worker.

const realSleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

export async function callWithRetries(fn, {
  deadline, // a performance.now()/1000 value: the caller's whole budget, in seconds
  retries = 3, base = 0.1, cap = 2.0, budget = null,
  random = Math.random, clock = () => performance.now() / 1000, sleep = realSleep,
}) {
  budget?.onRequest();
  for (let retry = 1; ; retry++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TransientError)) throw err; // PermanentError and bugs: no retry
      if (retry > retries) throw err;
      const delay = Math.max(err.retryAfter ?? 0, backoffDelay(retry, base, cap, random));
      if (clock() + delay >= deadline) throw err; // the caller will have given up by then
      if (budget && !budget.trySpend()) throw err; // many attempts are failing: fail fast
      await sleep(delay);
    }
  }
}

// --- The demo ------------------------------------------------------------------------------------

/** Mulberry32: a small seeded generator, so the run is the same every time. */
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

async function run(policy, failureRate, requests = 10_000) {
  const failures = mulberry32(7); // the same failures for every policy
  const jitter = mulberry32(8);
  let now = 0;
  const budget = policy === 'budget' ? new RetryBudget(0.1) : null;
  let attempts = 0;
  let ok = 0;
  const dependency = async () => {
    attempts++;
    if (failures() < failureRate) throw new TransientError('503 Service Unavailable');
    return '200 OK';
  };
  for (let i = 0; i < requests; i++) {
    try {
      if (policy === 'naive') await callNaive(dependency);
      else await callWithRetries(dependency, {
        deadline: now + 5, budget, random: jitter, clock: () => now, sleep: async (s) => { now += s; },
      });
      ok++;
    } catch (err) {
      if (!(err instanceof TransientError)) throw err;
    }
  }
  return [ok / requests, attempts / requests];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`${'failing'.padStart(8)}  ${'policy'.padEnd(8)} ${'succeeded'.padStart(10)} ${'attempts/request'.padStart(17)}`);
  for (const failureRate of [0.05, 0.2, 1]) {
    for (const policy of ['naive', 'backoff', 'budget']) {
      const [success, amplification] = await run(policy, failureRate);
      console.log(`${`${Math.round(failureRate * 100)}%`.padStart(8)}  ${policy.padEnd(8)} ${`${(success * 100).toFixed(2)}%`.padStart(10)} ${amplification.toFixed(2).padStart(17)}`);
    }
  }
}
