"""Seat holds that expire, and a payment callback that is safe to receive twice.

A booking takes seats out of the quota as a *hold* before the user pays. The hold expires if the
payment does not arrive in time, and the seats go back. The bank's callback can arrive twice, late,
or never, so every outcome is recorded by payment ID and a reconciliation job sweeps up the rest.

Run: python seat_hold.py
"""
from dataclasses import dataclass
from itertools import count

HOLD_SECONDS = 15 * 60  # illustrative: long enough to pay, short enough not to hoard seats


@dataclass
class Booking:
    id: int
    party: int
    expires_at: float
    status: str = "HELD"  # HELD -> CONFIRMED, or HELD -> EXPIRED
    pnr: str | None = None


class Quota:
    def __init__(self, seats: int) -> None:
        self.available = seats
        self.bookings: dict[int, Booking] = {}
        self.outcomes: dict[str, str] = {}  # payment_id -> what we did, so repeats get the same answer
        self.ids, self.pnrs = count(1), count(4_512_000_001)

    def release_expired(self, now: float) -> None:
        for b in self.bookings.values():
            if b.status == "HELD" and now >= b.expires_at:
                b.status = "EXPIRED"
                self.available += b.party  # the seats go back for the next person

    def hold(self, party: int, now: float) -> Booking | None:
        self.release_expired(now)
        if self.available < party:  # check and take together, nothing in between
            return None
        self.available -= party
        b = Booking(next(self.ids), party, now + HOLD_SECONDS)
        self.bookings[b.id] = b
        return b

    def on_payment(self, booking_id: int, payment_id: str, now: float) -> str:
        """Called by the payment gateway, at least once, maybe late. Must be idempotent."""
        if payment_id in self.outcomes:
            return self.outcomes[payment_id]  # a repeat: same answer, no second ticket
        self.release_expired(now)
        b = self.bookings[booking_id]
        if b.status == "EXPIRED" and self.available >= b.party:
            self.available -= b.party  # paid late, but seats are still free: take them again
            b.status = "HELD"
        if b.status == "HELD":
            b.status, b.pnr = "CONFIRMED", str(next(self.pnrs))
            outcome = f"ticket PNR {b.pnr}"
        else:
            outcome = "no seats left: refund"  # money arrived, seats did not: give it back
        self.outcomes[payment_id] = outcome
        return outcome

    def reconcile(self, paid_at_gateway: dict[int, str], now: float) -> list[str]:
        """Every few minutes: ask the gateway which payments succeeded, and settle any we missed."""
        return [f"booking {b}: {self.on_payment(b, p, now)}"
                for b, p in paid_at_gateway.items() if p not in self.outcomes]

def main() -> None:
    q = Quota(seats=6)
    asha = q.hold(2, now=0)
    ben = q.hold(4, now=5)
    print(f"10:00:05 Asha holds 2, Ben holds 4. Seats left: {q.available}")
    print(f"10:00:05 Chen asks for 2: {'held' if q.hold(2, now=5) else 'not available'}")

    print(f"10:02:00 Asha's bank calls back:      {q.on_payment(asha.id, 'pay_A1', now=120)}")
    print(f"10:02:03 the same callback, retried:  {q.on_payment(asha.id, 'pay_A1', now=123)}")

    # Ben's bank is slow. His hold runs out at 10:15:05 and the seats go back.
    chen = q.hold(2, now=HOLD_SECONDS + 10)
    dev = q.hold(2, now=HOLD_SECONDS + 12)
    print(f"10:15:12 Ben's hold expired; Chen and Dev hold 2 each. Seats left: {q.available}")
    print(f"10:16:00 Ben's payment finally arrives:  {q.on_payment(ben.id, 'pay_B7', now=960)}")
    print(f"10:17:00 Chen pays:                     {q.on_payment(chen.id, 'pay_C3', now=1020)}")

    # Dev paid, but the callback was lost on the way. Reconciliation finds it.
    for line in q.reconcile({asha.id: "pay_A1", dev.id: "pay_D9"}, now=1100):
        print(f"10:18:20 reconciliation, {line}")


if __name__ == "__main__":
    main()
