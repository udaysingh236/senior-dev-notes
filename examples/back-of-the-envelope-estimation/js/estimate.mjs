// Back-of-the-envelope estimate for a chat app, three ways.
// Run: node estimate.mjs
// All inputs are illustrative assumptions, written down at the top on purpose.

const SECONDS_PER_DAY = 24 * 60 * 60; // 86,400
const DAYS_PER_YEAR = 365;

// --- Assumptions: every estimate starts with a short, written list ---
const DAILY_USERS = 10_000_000; // people who open the app on a given day
const SENDS_PER_USER = 40; // messages each one sends a day
const FETCHES_PER_USER = 100; // times each one opens a chat or scrolls (one request each)
const MESSAGE_BYTES = 200; // one stored message: text plus ids, time, index share
const MESSAGES_PER_FETCH = 50; // one fetch returns up to 50 messages
const PEAK_FACTOR = 3; // busiest hour vs the day's average (illustrative)
const COPIES = 3; // replicas of every message
const REQS_PER_SERVER = 1_000; // what one app server serves at a safe 60% busy

const n = (x, digits = 0) =>
  x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Average only, and bytes mixed up with bits: both classic mistakes. */
function naive() {
  const requestsPerDay = DAILY_USERS * (SENDS_PER_USER + FETCHES_PER_USER);
  const perSecond = requestsPerDay / SECONDS_PER_DAY;
  const servers = perSecond / REQS_PER_SERVER;
  const outBytesPerS =
    ((DAILY_USERS * FETCHES_PER_USER) / SECONDS_PER_DAY) * MESSAGES_PER_FETCH * MESSAGE_BYTES;
  console.log('Naive (average traffic, bytes read as bits):');
  console.log(`  ${n(perSecond)} requests/s -> ${n(servers)} servers`);
  console.log(`  outgoing data: ${n(outBytesPerS / 1e6)} Mbit/s   <- wrong: that number was MB/s`);
}

/** Peak traffic, units carried on every line, copies counted. */
function careful() {
  const sendsPerDay = DAILY_USERS * SENDS_PER_USER;
  const fetchesPerDay = DAILY_USERS * FETCHES_PER_USER;
  const avg = (sendsPerDay + fetchesPerDay) / SECONDS_PER_DAY;
  const peak = avg * PEAK_FACTOR;
  const servers = peak / REQS_PER_SERVER;
  const peakFetches = (fetchesPerDay / SECONDS_PER_DAY) * PEAK_FACTOR;
  const outBytes = peakFetches * MESSAGES_PER_FETCH * MESSAGE_BYTES;
  const perDayGb = (sendsPerDay * MESSAGE_BYTES) / 1e9;
  const perYearTb = (perDayGb * DAYS_PER_YEAR) / 1e3;
  const perYearTbAllCopies = perYearTb * COPIES;
  console.log('\nCareful (peak, units, copies):');
  console.log(`  messages sent per day:    ${n(sendsPerDay)}`);
  console.log(`  requests per day:         ${n(sendsPerDay + fetchesPerDay)}`);
  console.log(`  average requests/s:       ${n(avg)}`);
  console.log(`  peak requests/s (x${PEAK_FACTOR}):    ${n(peak)}`);
  console.log(`  app servers at peak:      ${n(servers)}`);
  console.log(`  outgoing data at peak:    ${n(outBytes / 1e6)} MB/s = ${n((outBytes * 8) / 1e9, 1)} Gbit/s`);
  console.log(`  new data per day:         ${n(perDayGb)} GB (one copy)`);
  console.log(
    `  new data per year:        ${n(perYearTb, 1)} TB (one copy), ` +
      `${n(perYearTbAllCopies, 1)} TB with ${COPIES} copies`,
  );
}

/** The same estimate with round numbers: 86,400 s becomes 100,000 s. */
function inYourHead() {
  const perSecond = (10e6 * 140) / 1e5; // 1.4 billion requests a day / 100,000 s
  console.log('\nIn your head (a day is about 100,000 s):');
  console.log(
    `  ${n(perSecond)} requests/s average, ${n(perSecond * 3)} at peak, ${n((perSecond * 3) / 1000)} servers`,
  );
}

/** Production-shaped: each guess gets a low and a high; see which one moves the answer. */
function withRanges() {
  const low = { users: 8e6, sends: 20, fetches: 60, peak: 2 };
  const high = { users: 12e6, sends: 60, fetches: 150, peak: 5 };
  const base = { users: 10e6, sends: 40, fetches: 100, peak: 3 };
  const servers = (a) =>
    (((a.users * (a.sends + a.fetches)) / SECONDS_PER_DAY) * a.peak) / REQS_PER_SERVER;

  console.log('\nWith ranges (servers at peak):');
  console.log(`  low ${n(servers(low))}, likely ${n(servers(base))}, high ${n(servers(high))}`);
  for (const name of Object.keys(base)) {
    const lo = servers({ ...base, [name]: low[name] });
    const hi = servers({ ...base, [name]: high[name] });
    console.log(`  only '${name}' uncertain: ${n(lo)} to ${n(hi)}`);
  }
}

naive();
careful();
inYourHead();
withRanges();
