// A leader and followers in one process, with a simulated clock, to show three things:
// 1. Naive: the app writes to two databases itself, and one write fails -> the copies differ.
// 2. Replication through a log: asynchronous loses the changes still in flight when the leader
//    crashes; synchronous loses none, but every commit waits one round trip.
// 3. Read-your-writes: remember the log position of your last write, and only read from a
//    follower that has reached it.
// Times are simulated milliseconds, so the output is the same on every run.
// Run: node replication-demo.mjs

// 1. The naive fix: the application writes every change to two databases. ------------------
function naiveDualWrite() {
  const dbA = new Map();
  const dbB = new Map();
  const changes = [['order-1', 'Pune'], ['order-2', 'Delhi'], ['order-1', 'Mumbai']];
  changes.forEach(([key, value], i) => {
    const number = i + 1;
    dbA.set(key, value);
    if (number === 3) { // the second database times out on the third write
      console.log(`  write ${number} to dbB failed: timeout (dbA already has it)`);
      return;
    }
    dbB.set(key, value);
  });
  console.log('  dbA:', Object.fromEntries(dbA));
  console.log('  dbB:', Object.fromEntries(dbB));
  const agree = [...dbA].every(([k, v]) => dbB.get(k) === v) && dbA.size === dbB.size;
  console.log(`  copies agree? ${agree}`);
}

// 2. Replication through a log. -------------------------------------------------------------
class Node {
  constructor(name, oneWayMs = 0) {
    this.name = name;
    this.oneWayMs = oneWayMs; // network delay from the leader
    this.log = [];
    this.rows = new Map();
  }
  /** How many log entries this node has applied. */
  get position() { return this.log.length; }
  apply(entry) {
    this.log.push(entry);
    const [key, value] = entry;
    this.rows.set(key, value);
  }
}

class Leader extends Node {
  constructor(followers, synchronous) {
    super('leader');
    this.followers = followers;
    this.synchronous = synchronous;
    this.inFlight = []; // { arrivesAt, follower, entry }
  }
  /** Apply a change, send it to every follower, and return [log position, commit time]. */
  write(key, value, now) {
    const entry = [key, value];
    this.apply(entry);
    for (const follower of this.followers) {
      this.inFlight.push({ arrivesAt: now + follower.oneWayMs, follower, entry });
    }
    if (!this.synchronous) return [this.position, now]; // reply at once
    // Synchronous: wait until the nearest follower has it and its "got it" has come back.
    const nearest = Math.min(...this.followers.map((f) => f.oneWayMs));
    return [this.position, now + 2 * nearest];
  }
  /** Hand every change whose travel time is over to its follower, in order. */
  deliverUntil(now) {
    const arrived = this.inFlight.filter((m) => m.arrivesAt <= now);
    this.inFlight = this.inFlight.filter((m) => m.arrivesAt > now);
    arrived.sort((a, b) => a.arrivesAt - b.arrivesAt);
    for (const { follower, entry } of arrived) follower.apply(entry);
  }
}

function crashTest(synchronous) {
  const follower = new Node('follower', 40);
  const leader = new Leader([follower], synchronous);
  let now = 0;
  let waited = 0;
  for (let n = 1; n <= 5; n++) {
    const [, committedAt] = leader.write(`order-${n}`, 'placed', now);
    waited += committedAt - now; // time the customer waited for "saved"
    now = committedAt + 1;
    if (synchronous) leader.deliverUntil(committedAt);
  }
  leader.deliverUntil(now); // the leader crashes at this moment
  const lost = leader.position - follower.position;
  const mode = synchronous ? 'synchronous ' : 'asynchronous';
  console.log(`  ${mode}: waited ${String(waited).padStart(3)} ms for 5 commits, leader crashes`
    + ` at t=${now} ms, follower has ${follower.position} of 5, lost ${lost}`);
}

// 3. Read-your-writes: route a read to a follower only if it has reached your last write. ---
function read(key, leader, follower, minPosition) {
  if (follower.position >= minPosition) return [follower.name, follower.rows.get(key)];
  return [leader.name, leader.rows.get(key)]; // the follower is behind: ask the leader
}

function readYourWrites() {
  const follower = new Node('follower', 40);
  const leader = new Leader([follower], false);
  leader.write('address:42', 'Pune', 0);
  leader.deliverUntil(100); // long ago: everyone agrees on Pune
  const [myPosition] = leader.write('address:42', 'Mumbai', 100);

  for (const t of [105, 145]) {
    leader.deliverUntil(t);
    const naive = follower.rows.get('address:42');
    const [servedBy, value] = read('address:42', leader, follower, myPosition);
    console.log(`  t=${t} ms: follower alone says ${`'${naive}'`.padEnd(9)}`
      + ` | with position check: '${value}' from the ${servedBy}`);
  }
}

console.log('1. Naive: the app writes to two databases');
naiveDualWrite();
console.log('2. Replication through a log, follower 40 ms away');
crashTest(false);
crashTest(true);
console.log('3. Read-your-writes, address changed from Pune to Mumbai at t=100 ms');
readYourWrites();
