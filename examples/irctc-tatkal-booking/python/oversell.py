"""1,000 people try to book the last 120 Tatkal seats at once.

The naive version checks availability, waits for something slow (a database round trip, a fare
calculation), then subtracts. Everyone checks before anyone subtracts, so it sells seats it does
not have. The safe version checks and takes in one step, with nothing in between.

Run: python oversell.py
"""
import asyncio
import random

SEATS = 120
USERS = 1_000


class NaiveInventory:
    def __init__(self, seats: int) -> None:
        self.available = seats

    async def book(self, party: int) -> bool:
        if self.available >= party:  # check...
            await asyncio.sleep(random.uniform(0, 0.01))  # ...something slow happens here...
            self.available -= party  # ...then act on a number that may be stale
            return True
        return False


class AtomicInventory:
    def __init__(self, seats: int) -> None:
        self.available = seats

    async def book(self, party: int) -> bool:
        await asyncio.sleep(random.uniform(0, 0.01))  # the slow part happens before, not between
        # Check and take with no await in between. In SQL this is one statement:
        #   UPDATE quota SET available = available - :party
        #   WHERE train = :t AND class = :c AND available >= :party
        if self.available >= party:
            self.available -= party
            return True
        return False


async def rush(inventory) -> tuple[int, int]:
    parties = [random.choice([1, 2, 2, 3, 4, 4]) for _ in range(USERS)]
    results = await asyncio.gather(*(inventory.book(p) for p in parties))
    sold = sum(p for p, ok in zip(parties, results) if ok)
    return sold, sum(results)


async def main() -> None:
    random.seed(7)
    for name, inv in [("naive ", NaiveInventory(SEATS)), ("atomic", AtomicInventory(SEATS))]:
        sold, bookings = await rush(inv)
        print(f"{name}: {bookings:4d} bookings, {sold:4d} seats sold of {SEATS}, available now {inv.available}")


if __name__ == "__main__":
    asyncio.run(main())
