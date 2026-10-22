// Where the time goes when a browser fetches one HTML response on a new connection.
//
// A latency budget in round trips: the naive estimate (size / bandwidth) against a model that
// counts DNS, connection set-up, the request, server work and TCP slow start. No network needed.
//
// Run: node latency-budget.mjs

const MSS = 1460; // bytes of payload in one TCP packet
const INITCWND = 10; // packets in the first round trip of data (RFC 6928)

/** Round trips of data a fresh connection needs: the window doubles every round trip. */
function dataRounds(sizeBytes, initcwnd = INITCWND) {
  let packets = Math.ceil(sizeBytes / MSS);
  let rounds = 0;
  for (let window = initcwnd; packets > 0; window *= 2) {
    packets -= window;
    rounds++;
  }
  return rounds;
}

/** What most people estimate: bytes divided by bandwidth. */
const naiveMs = (sizeKB, mbps) => (sizeKB * 1000 * 8) / (mbps * 1000);

/**
 * First byte to last byte of one response on a new connection.
 * setupRtts: 2 for TCP + TLS 1.3, 1 for QUIC, 0 for a connection that is already open.
 * originRtt: for an edge that forwards to the origin on its own open, warm connection.
 */
function fetchMs(sizeKB, rtt, mbps, { server = 50, dns = 40, setupRtts = 2, originRtt = 0 } = {}) {
  const rounds = dataRounds(sizeKB * 1000);
  const wire = naiveMs(sizeKB, mbps); // the bandwidth term: only matters once the window is large
  return dns + setupRtts * rtt + rtt + originRtt + server + (rounds - 1) * rtt + wire;
}

const size = 100; // KB of HTML
console.log(`${size} KB of HTML on a new connection, TCP + TLS 1.3, 50 ms of server work\n`);
console.log(`${'RTT'.padStart(6)} ${'bandwidth'.padStart(10)} ${'naive'.padStart(8)} ${'real'.padStart(8)}`);
for (const rtt of [20, 75, 150]) {
  for (const mbps of [10, 100, 1000]) {
    console.log(`${String(rtt).padStart(4)} ms ${String(mbps).padStart(5)} Mbit/s ${naiveMs(size, mbps).toFixed(1).padStart(5)} ms ${fetchMs(size, rtt, mbps).toFixed(0).padStart(5)} ms`);
  }
}

console.log(`\nRound trips of data for a fresh window of ${INITCWND} packets:`);
for (const kb of [14, 15, 30, 100, 1000]) console.log(`  ${String(kb).padStart(4)} KB -> ${dataRounds(kb * 1000)}`);

const direct = fetchMs(30, 150, 100);
const edge = fetchMs(30, 20, 100, { originRtt: 150 });
console.log('\n30 KB page that no cache can hold, user 150 ms from the origin:');
console.log(`  direct:                        ${direct.toFixed(0)} ms`);
console.log(`  through an edge 20 ms away:    ${edge.toFixed(0)} ms`);
