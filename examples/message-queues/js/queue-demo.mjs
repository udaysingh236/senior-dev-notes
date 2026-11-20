// A message queue with leases, acks and a dead-letter queue, and five things that go wrong.
//
// Time is simulated (seconds passed in by the caller), so every run prints the same output.
// Run: node queue-demo.mjs

/** Receiving hides a message for `visibilityS` seconds (its lease). Ack deletes it.
 *  A lease that runs out puts the message back. Too many receives sends it to the DLQ. */
class Queue {
  constructor({ visibilityS = 30, maxReceives = 5 } = {}) {
    this.visibilityS = visibilityS;
    this.maxReceives = maxReceives;
    this.waiting = [];
    this.inFlight = new Map(); // receipt -> { msg, leaseEnd }
    this.deadLetters = [];
    this.nextId = 1;
    this.nextReceipt = 1;
  }

  send(body) {
    const msg = { id: this.nextId++, body, receives: 0 };
    this.waiting.push(msg); // a real broker writes it to disk before answering
    return msg.id;
  }

  #expireLeases(now) {
    for (const [receipt, { msg, leaseEnd }] of this.inFlight) {
      if (now >= leaseEnd) { // nobody acked in time: give it to someone else
        this.inFlight.delete(receipt);
        this.waiting.unshift(msg);
      }
    }
  }

  receive(now) {
    this.#expireLeases(now);
    while (this.waiting.length) {
      const msg = this.waiting.shift();
      if (msg.receives >= this.maxReceives) { // tried enough: park it
        this.deadLetters.push(msg);
        continue;
      }
      msg.receives += 1;
      const receipt = this.nextReceipt++;
      this.inFlight.set(receipt, { msg, leaseEnd: now + this.visibilityS });
      return { receipt, msg };
    }
    return null;
  }

  /** Delete for good. false if the lease already ran out (someone else may have it). */
  ack(receipt, now) {
    this.#expireLeases(now);
    return this.inFlight.delete(receipt);
  }

  /** Heartbeat: "still working on it", the lease restarts from now. */
  extend(receipt, now) {
    this.inFlight.get(receipt).leaseEnd = now + this.visibilityS;
  }

  size() {
    return this.waiting.length + this.inFlight.size;
  }
}

const emails = []; // what the email provider actually sent
const pad = (v, n) => String(v).padStart(n);

function sendEmail(orderId, now) {
  emails.push(`t=${pad(now, 5)}s confirmation for order ${orderId}`);
}

function show(title, q) {
  console.log(title);
  for (const line of emails) console.log('   ', line);
  console.log(`    emails sent: ${emails.length}, left in queue: ${q.size()}, dead letters: ${q.deadLetters.length}`);
  emails.length = 0;
}

// 1. Ack first, then work: a crash loses the message.
let q = new Queue();
q.send({ orderId: 1042 });
let got = q.receive(0);
q.ack(got.receipt, 0); // "got it" before doing anything
// ...the worker crashes here, before sending the email
show('1. Ack on receive, worker crashes before sending', q);

// 2. Work first, then ack: a crash after sending means the email goes twice.
q = new Queue();
q.send({ orderId: 1042 });
got = q.receive(0);
sendEmail(got.msg.body.orderId, 1);
// ...worker A crashes here, before its ack. 30 s later the lease runs out.
got = q.receive(31); // worker B
sendEmail(got.msg.body.orderId, 32);
q.ack(got.receipt, 32);
show('2. Ack after sending, worker A crashes between send and ack', q);

// 3. Same crash, idempotent consumer: remember which orders were already emailed.
const alreadySent = new Set(); // in production: a table with a unique key, see the page

function handle(msg, now) {
  const { orderId } = msg.body;
  if (alreadySent.has(orderId)) return; // a duplicate delivery: do nothing, but still ack it
  sendEmail(orderId, now);
  alreadySent.add(orderId);
}

q = new Queue();
q.send({ orderId: 1042 });
got = q.receive(0);
handle(got.msg, 1);
// ...worker A crashes before its ack
got = q.receive(31);
handle(got.msg, 32);
q.ack(got.receipt, 32);
show('3. Same crash, idempotent consumer', q);

// 4. No crash at all, but the work takes 45 s and the lease is 30 s.
q = new Queue();
q.send({ orderId: 1042 });
const a = q.receive(0); // worker A starts a slow send
const b = q.receive(30); // lease ran out at 30 s: worker B gets it too
sendEmail(b.msg.body.orderId, 40);
q.ack(b.receipt, 40);
sendEmail(a.msg.body.orderId, 45);
const late = q.ack(a.receipt, 45);
show(`4. Work takes 45 s, lease is 30 s (worker A's ack accepted: ${late ? 'True' : 'False'})`, q);

q = new Queue();
q.send({ orderId: 1042 });
got = q.receive(0);
for (const t of [10, 20, 30, 40]) q.extend(got.receipt, t); // heartbeat every 10 s while working
sendEmail(got.msg.body.orderId, 45);
q.ack(got.receipt, 45);
show('   Same slow send, worker extends its lease every 10 s', q);

// 5. A poison message: every attempt crashes the worker.
q = new Queue({ visibilityS: 30, maxReceives: 5 });
q.send({ orderId: '10x42' }); // a bad order id that makes the handler crash
console.log('5. Poison message, lease 30 s, max 5 receives');
let t = 0;
while (q.deadLetters.length === 0) {
  got = q.receive(t);
  if (got) console.log(`    t=${pad(t, 4)}s attempt ${got.msg.receives}: handler crashes, no ack`);
  t += 30;
}
console.log(`    t=${pad(t - 30, 4)}s next receive moves order ${q.deadLetters[0].body.orderId} to the dead-letter queue`);

// 6. A sale: 300 orders a second for 10 minutes, workers send 100 emails a second.
console.log('6. Backlog: 300 orders/s for 600 s, then 40/s; workers send 100 emails/s');
let backlog = 0, peak = 0, peakAt = 0, drainedAt = null;
for (let second = 1; second <= 3600; second++) {
  const arrivals = second <= 600 ? 300 : 40;
  backlog = Math.max(0, backlog + arrivals - 100);
  if (backlog > peak) { peak = backlog; peakAt = second; }
  if (second > 600 && backlog === 0 && drainedAt === null) drainedAt = second;
}
console.log(`    peak backlog ${peak.toLocaleString('en-US')} messages at t=${peakAt} s`);
console.log(`    backlog empty again at t=${drainedAt} s (${Math.floor(drainedAt / 60)} min ${drainedAt % 60} s)`);
console.log(`    an order placed at t=600 s waits ${peak / 100} s for its email`);
