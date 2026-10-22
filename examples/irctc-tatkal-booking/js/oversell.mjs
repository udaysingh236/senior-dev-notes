// 1,000 people try to book the last 120 Tatkal seats at once.
//
// The naive version checks availability, awaits something slow (a database round trip, a fare
// calculation), then subtracts. Everyone checks before anyone subtracts, so it sells seats it does
// not have. The safe version checks and takes in one step, with no await in between.
//
// Run: node oversell.mjs

const SEATS = 120;
const USERS = 1_000;

// A small seeded generator, so every run prints the same numbers.
let state = 7;
const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class NaiveInventory {
  constructor(seats) { this.available = seats; }

  async book(party) {
    if (this.available >= party) { // check...
      await sleep(random() * 10); // ...something slow happens here...
      this.available -= party; // ...then act on a number that may be stale
      return true;
    }
    return false;
  }
}

class AtomicInventory {
  constructor(seats) { this.available = seats; }

  async book(party) {
    await sleep(random() * 10); // the slow part happens before, not between
    // Check and take with no await in between. In SQL this is one statement:
    //   UPDATE quota SET available = available - $party
    //   WHERE train = $t AND class = $c AND available >= $party
    if (this.available >= party) {
      this.available -= party;
      return true;
    }
    return false;
  }
}

async function rush(inventory) {
  const parties = Array.from({ length: USERS }, () => [1, 2, 2, 3, 4, 4][Math.floor(random() * 6)]);
  const results = await Promise.all(parties.map((p) => inventory.book(p)));
  const sold = parties.reduce((sum, p, i) => sum + (results[i] ? p : 0), 0);
  return { sold, bookings: results.filter(Boolean).length };
}

for (const [name, inv] of [['naive ', new NaiveInventory(SEATS)], ['atomic', new AtomicInventory(SEATS)]]) {
  const { sold, bookings } = await rush(inv);
  console.log(`${name}: ${String(bookings).padStart(4)} bookings, ${String(sold).padStart(4)} seats sold of ${SEATS}, available now ${inv.available}`);
}
