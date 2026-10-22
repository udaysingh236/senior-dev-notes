// Seat holds that expire, and a payment callback that is safe to receive twice.
//
// A booking takes seats out of the quota as a *hold* before the user pays. The hold expires if the
// payment does not arrive in time, and the seats go back. The bank's callback can arrive twice, late,
// or never, so every outcome is recorded by payment ID and a reconciliation job sweeps up the rest.
//
// Run: node seat-hold.mjs

const HOLD_SECONDS = 15 * 60; // illustrative: long enough to pay, short enough not to hoard seats

class Quota {
  available;
  bookings = new Map();
  outcomes = new Map(); // paymentId -> what we did, so repeats get the same answer
  #nextId = 1;
  #nextPnr = 4_512_000_001;

  constructor(seats) { this.available = seats; }

  releaseExpired(now) {
    for (const b of this.bookings.values()) {
      if (b.status === 'HELD' && now >= b.expiresAt) {
        b.status = 'EXPIRED';
        this.available += b.party; // the seats go back for the next person
      }
    }
  }

  hold(party, now) {
    this.releaseExpired(now);
    if (this.available < party) return null; // check and take together, nothing in between
    this.available -= party;
    const b = { id: this.#nextId++, party, expiresAt: now + HOLD_SECONDS, status: 'HELD', pnr: null };
    this.bookings.set(b.id, b);
    return b;
  }

  /** Called by the payment gateway, at least once, maybe late. Must be idempotent. */
  onPayment(bookingId, paymentId, now) {
    if (this.outcomes.has(paymentId)) return this.outcomes.get(paymentId); // a repeat: same answer
    this.releaseExpired(now);
    const b = this.bookings.get(bookingId);
    if (b.status === 'EXPIRED' && this.available >= b.party) {
      this.available -= b.party; // paid late, but seats are still free: take them again
      b.status = 'HELD';
    }
    let outcome;
    if (b.status === 'HELD') {
      b.status = 'CONFIRMED';
      b.pnr = String(this.#nextPnr++);
      outcome = `ticket PNR ${b.pnr}`;
    } else {
      outcome = 'no seats left: refund'; // money arrived, seats did not: give it back
    }
    this.outcomes.set(paymentId, outcome);
    return outcome;
  }

  /** Every few minutes: ask the gateway which payments succeeded, and settle any we missed. */
  reconcile(paidAtGateway, now) {
    return [...paidAtGateway]
      .filter(([, paymentId]) => !this.outcomes.has(paymentId))
      .map(([bookingId, paymentId]) => `booking ${bookingId}: ${this.onPayment(bookingId, paymentId, now)}`);
  }
}

const q = new Quota(6);
const asha = q.hold(2, 0);
const ben = q.hold(4, 5);
console.log(`10:00:05 Asha holds 2, Ben holds 4. Seats left: ${q.available}`);
console.log(`10:00:05 Chen asks for 2: ${q.hold(2, 5) ? 'held' : 'not available'}`);

console.log(`10:02:00 Asha's bank calls back:      ${q.onPayment(asha.id, 'pay_A1', 120)}`);
console.log(`10:02:03 the same callback, retried:  ${q.onPayment(asha.id, 'pay_A1', 123)}`);

// Ben's bank is slow. His hold runs out at 10:15:05 and the seats go back.
const chen = q.hold(2, HOLD_SECONDS + 10);
const dev = q.hold(2, HOLD_SECONDS + 12);
console.log(`10:15:12 Ben's hold expired; Chen and Dev hold 2 each. Seats left: ${q.available}`);
console.log(`10:16:00 Ben's payment finally arrives:  ${q.onPayment(ben.id, 'pay_B7', 960)}`);
console.log(`10:17:00 Chen pays:                     ${q.onPayment(chen.id, 'pay_C3', 1020)}`);

// Dev paid, but the callback was lost on the way. Reconciliation finds it.
for (const line of q.reconcile(new Map([[asha.id, 'pay_A1'], [dev.id, 'pay_D9']]), 1100)) {
  console.log(`10:18:20 reconciliation, ${line}`);
}
