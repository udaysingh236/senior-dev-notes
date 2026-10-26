// Weighted round robin, two ways, for weights a=5, b=1, c=1.
//
//   blocks   send each backend `weight` requests in a row: a a a a a b c
//   smooth   nginx's rule: every pick, add each backend's weight to its counter, choose the highest
//            counter, and subtract the total weight from the winner. Same shares, spread out.
//
// Run: node weighted.mjs

function blocks(weights, picks) {
  const cycle = Object.entries(weights).flatMap(([name, w]) => Array(w).fill(name));
  return Array.from({ length: picks }, (_, i) => cycle[i % cycle.length]);
}

function smooth(weights, picks, trace = false) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const current = Object.fromEntries(Object.keys(weights).map((name) => [name, 0]));
  const order = [];
  for (let i = 0; i < picks; i++) {
    for (const [name, w] of Object.entries(weights)) current[name] += w;
    let best = null; // ties go to the first listed
    for (const name of Object.keys(current)) if (best === null || current[name] > current[best]) best = name;
    if (trace) {
      const counters = Object.entries(current).map(([n, c]) => `${n}=${String(c).padStart(2)}`).join('  ');
      console.log('  counters', counters, ' ->', best);
    }
    current[best] -= total;
    order.push(best);
  }
  return order;
}

const weights = { a: 5, b: 1, c: 1 };
console.log('blocks:', blocks(weights, 7).join(' '));
console.log('smooth, step by step:');
console.log('smooth:', smooth(weights, 7, true).join(' '));
