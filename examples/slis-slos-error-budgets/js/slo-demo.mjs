// SLIs, SLOs and error budgets on one month of a checkout service, minute by minute.
// Same month as python/slo_demo.py: 30 days, 25 requests a minute, SLO 99.9%, a 5-minute blip,
// a 20-minute outage, a 3-day slow leak and 0.02% background errors.
// Prints the error budget, what each problem spent, and when each alert first fires.
// Run: node slo-demo.mjs   (Node 20+, no dependencies)

const DAY = 24 * 60;
const MINUTES = 30 * DAY; // 43,200 minutes in 30 days
const PER_MINUTE = 25; // requests a minute
const SLO = 0.999; // 99.9% of requests must be good
const BACKGROUND = 0.0002;

const INCIDENTS = [
  { name: '5-minute blip, 5% errors', start: 3 * DAY + 600, minutes: 5, errorRate: 0.05 },
  { name: '20-minute outage, 100% errors', start: 10 * DAY + 840, minutes: 20, errorRate: 1.0 },
  { name: '3-day slow leak, 0.3% errors', start: 18 * DAY, minutes: 3 * DAY, errorRate: 0.003 },
];

/** Expected failed requests in each minute of the month. */
function badRequestsPerMinute() {
  const bad = new Array(MINUTES).fill(PER_MINUTE * BACKGROUND);
  for (const inc of INCIDENTS) {
    for (let m = inc.start; m < inc.start + inc.minutes; m++) bad[m] = PER_MINUTE * inc.errorRate;
  }
  return bad;
}

/** Error rate over the last `window` minutes, divided by the allowed error rate (1 - SLO). */
function burnRate(prefix, end, window) {
  const start = Math.max(0, end - window);
  const errors = prefix[end] - prefix[start];
  const requests = (end - start) * PER_MINUTE;
  return errors / requests / (1 - SLO);
}

// Burn-rate alerts: name, burn rate, long window, short window (minutes).
const ALERTS = [
  ['page: 14.4x over 1 h and 5 min', 14.4, 60, 5],
  ['page: 6x over 6 h and 30 min', 6, 360, 30],
  ['ticket: 1x over 3 days and 6 h', 1, 3 * DAY, 360],
];

const pct = (x) => `${Math.round(x * 100)}%`.padStart(4);
const bad = badRequestsPerMinute();
const total = MINUTES * PER_MINUTE;
const budget = total * (1 - SLO); // failed requests we may have this month
console.log(`Requests this month: ${total.toLocaleString('en-US')}. SLO 99.9%: error budget = ${budget.toLocaleString('en-US', { maximumFractionDigits: 0 })} failed requests`);
console.log(`  as time: ${MINUTES.toLocaleString('en-US')} minutes x 0.1% = ${(MINUTES * (1 - SLO)).toFixed(1)} minutes of full outage`);
const quietMinutes = MINUTES - INCIDENTS.reduce((s, inc) => s + inc.minutes, 0); // minutes with no incident
const spentBackground = quietMinutes * PER_MINUTE * BACKGROUND;
console.log(`  background 0.02%: ${spentBackground.toFixed(0).padStart(6)} failed (${pct(spentBackground / budget)} of budget)`);
for (const inc of INCIDENTS) {
  const spent = inc.minutes * PER_MINUTE * inc.errorRate;
  console.log(`  ${inc.name.padEnd(31)}: ${spent.toFixed(0).padStart(6)} failed (${pct(spent / budget)} of budget)`);
}
const used = bad.reduce((s, b) => s + b, 0);
console.log(`  month total: ${used.toLocaleString('en-US', { maximumFractionDigits: 0 })} failed, SLI = ${((1 - used / total) * 100).toFixed(4)}%, budget left = ${Math.round((1 - used / budget) * 100)}%`);

const prefix = [0];
for (const b of bad) prefix.push(prefix[prefix.length - 1] + b);

function firstFire(check, start, end) {
  for (let m = start + 1; m <= end; m++) if (check(m)) return `fires after ${m - start} min`;
  return 'never fires';
}

const naive = (m) => burnRate(prefix, m, 5) * (1 - SLO) > 0.01; // error rate > 1% over 5 min
console.log('When does each alert fire? (counted from the start of each problem)');
for (const inc of INCIDENTS) {
  console.log(`  ${inc.name}`);
  const end = inc.start + inc.minutes + 360;
  console.log(`    naive: errors > 1% over 5 min   ${firstFire(naive, inc.start, end)}`);
  for (const [name, rate, longW, shortW] of ALERTS) {
    const check = (m) => burnRate(prefix, m, longW) >= rate && burnRate(prefix, m, shortW) >= rate;
    console.log(`    ${name.padEnd(31)}  ${firstFire(check, inc.start, end)}`);
  }
}
