// The way most of us first fetch a page: one call, no timeout, one number at the end.
//
// Node 20+, no dependencies. Run:  node naive-fetch.mjs
//
// It works, and it tells you nothing. When the page is slow you cannot see which step was slow,
// and when a step never answers, you wait for whatever default the library happens to have.

async function naiveFetch(url) {
  const started = performance.now();
  const response = await fetch(url); // no timeout of our own
  const body = await response.text();
  const elapsed = performance.now() - started;
  console.log(`${url}: ${response.status}, ${body.length} bytes in ${elapsed.toFixed(0)} ms. Which part was slow? No idea.`);
}

await naiveFetch('https://example.com/');

// 10.255.255.1 is a private address that nothing answers on most networks, so the TCP
// handshake never completes. Start the naive fetch and check on it after 5 seconds.
const started = performance.now();
const pending = naiveFetch('http://10.255.255.1/').catch((err) => {
  console.log(`http://10.255.255.1/: failed after ${((performance.now() - started) / 1000).toFixed(1)} s: ${err.cause?.code ?? err.message}`);
});
const waited = await Promise.race([pending.then(() => false), new Promise((r) => setTimeout(r, 5000, true))]);
if (waited) {
  console.log(`http://10.255.255.1/: still waiting after ${((performance.now() - started) / 1000).toFixed(1)} s, with no error and no idea why. Giving up on it.`);
  process.exit(0);
}
