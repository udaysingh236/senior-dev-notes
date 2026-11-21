// Logging, from console.log to a production-shaped logger, in four steps:
// 1. Naive: services print free-text lines. Finding one customer's request means guessing.
// 2. Structured: every line is one JSON object with a request ID, so one search finds the story.
// 3. Redaction: secrets are masked before anything is written.
// 4. Non-blocking: a slow log destination slows every request, unless the app puts lines in a
//    bounded buffer that a background loop drains, and counts what it has to drop.
// Run: node logging-demo.mjs   (Node 20+, no dependencies)
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

// 1. Naive: print free text. ----------------------------------------------------------------
function naive() {
  const lines = [
    'checkout: placing order for asha@example.com',
    'checkout: placing order for ravi@example.com',
    'payments: charged card ending 4242',
    'payments: charged card ending 1881',
    'checkout: ERROR timeout talking to payments',
    'checkout: order placed',
  ];
  console.log(`  ${lines.length} lines. Which charge belongs to the order that failed? The lines cannot say.`);
  for (const line of lines) console.log('   ', line);
}

// 2. Structured: one JSON object per line, with the request ID added automatically. -------
const requestContext = new AsyncLocalStorage();
const SECRET_KEYS = new Set(['password', 'card_number', 'token', 'authorization']);

/** A tiny logger: fixed fields first, then the event's own fields, secrets masked. */
function makeLogger(service, write) {
  const log = (level, msg, fields = {}) => {
    const safe = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, SECRET_KEYS.has(k) ? '[REDACTED]' : v]),
    );
    const event = {
      time: new Date().toISOString().slice(11, 23),
      level,
      service,
      request_id: requestContext.getStore()?.requestId ?? '-',
      msg,
      ...safe,
    };
    write(JSON.stringify(event));
  };
  return { info: (m, f) => log('INFO', m, f), error: (m, f) => log('ERROR', m, f) };
}

function structured() {
  const store = [];
  const checkout = makeLogger('checkout', (l) => store.push(l));
  const payments = makeLogger('payments', (l) => store.push(l));

  const placeOrder = (requestId, orderId, paymentMs) =>
    requestContext.run({ requestId }, () => { // set once when the request arrives
      checkout.info('order received', { order_id: orderId });
      const charged = { order_id: orderId, amount_inr: 1499, took_ms: paymentMs };
      if (paymentMs > 2000) { // Checkout gives up at 2,000 ms; the charge finishes later
        checkout.error('payments timed out', { order_id: orderId, timeout_ms: 2000 });
        payments.info('card charged', charged);
      } else {
        payments.info('card charged', charged);
        checkout.info('order placed', { order_id: orderId });
      }
    });

  placeOrder('req-7f3a', 1041, 180);
  placeOrder('req-9c21', 1042, 2400);

  // "Search" the central store: every line for the request the customer complained about.
  const hits = store.filter((l) => JSON.parse(l).request_id === 'req-9c21');
  console.log(`  search request_id = req-9c21 -> ${hits.length} lines:`);
  for (const l of hits) console.log('   ', l);
}

// 3. Redaction: never let a secret reach a log line. ----------------------------------------
function redaction() {
  const log = makeLogger('login', (l) => console.log('   ', l));
  requestContext.run({ requestId: 'req-11aa' }, () => {
    log.info('login attempt', { user: 'asha', password: 'hunter2' });
  });
}

// 4. A slow destination: waiting for it vs a bounded buffer drained in the background. ------
const sendSlowly = () => sleep(20); // a log server across a slow network: 20 ms per line

async function handleRequests(logLine, requests, linesPerRequest) {
  const start = performance.now();
  for (let r = 0; r < requests; r++) {
    for (let n = 0; n < linesPerRequest; n++) await logLine({ request: r, step: n });
  }
  return (performance.now() - start) / requests; // ms per request
}

async function slowDestination() {
  // Waiting: every request waits until each of its lines has been sent.
  let ms = await handleRequests(() => sendSlowly(), 20, 4);
  console.log(`  blocking:     ${ms.toFixed(1).padStart(6)} ms per request (4 lines x 20 ms each)`);

  // Non-blocking: lines go into a buffer of 50; a background loop sends them.
  const buffer = [];
  let sent = 0;
  let dropped = 0;
  let open = true;
  const drain = (async () => {
    while (open || buffer.length) {
      if (buffer.length) { buffer.shift(); await sendSlowly(); sent++; } else await sleep(1);
    }
  })();
  const enqueue = (line) => {
    if (buffer.length >= 50) dropped++; // never make the request wait for the logs
    else buffer.push(line);
  };
  ms = await handleRequests(enqueue, 20, 4);
  open = false;
  await drain;
  console.log(`  non-blocking: ${ms.toFixed(3).padStart(6)} ms per request; of 80 lines, ${sent} sent,`
    + ` ${dropped} dropped because the buffer of 50 was full`);
}

console.log('1. Naive: free-text lines from two services');
naive();
console.log('2. Structured: JSON lines with a request ID');
structured();
console.log('3. Redaction');
redaction();
console.log('4. A destination that takes 20 ms per line');
await slowDestination();
