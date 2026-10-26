// Subsetting: each frontend connects to only k of the backends. Two ways to choose the k.
//
//   deterministic  frontends are grouped in rounds; each round shuffles the backend list with the
//                  round number as the seed and deals it out in slices of k, so in every round each
//                  backend lands in exactly one slice
//   rendezvous     each frontend scores every backend with a hash of (frontend, backend) and keeps
//                  the k highest scores: a random choice, but a stable one
//
// For each it prints how many frontends each backend gets (the even answer is F * k / M), then
// removes one backend and counts the connections frontends must open to new backends.
//
// Run: node subsets.mjs

const F = 300; // frontends
const M = 300; // backends
const K = 10; // subset size

/** mulberry32, the same generator as the Python version, so both print the same numbers. */
function shuffle(items, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A 32-bit integer hash (the murmur3 finaliser). */
function mix(x) {
  x >>>= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function deterministicSubset(frontend, backends) {
  const count = Math.floor(backends.length / K); // slices per round
  const round = Math.floor(frontend / count);
  const slice = frontend % count;
  const dealt = shuffle(backends, round + 1); // every frontend in a round shuffles the same way
  return new Set(dealt.slice(slice * K, (slice + 1) * K));
}

function rendezvousSubset(frontend, backends) {
  const score = (b) => mix(frontend * 100_003 + b);
  return new Set([...backends].sort((a, b) => score(b) - score(a)).slice(0, K));
}

function report(name, choose) {
  const backends = Array.from({ length: M }, (_, i) => i);
  const before = Array.from({ length: F }, (_, f) => choose(f, backends));
  const load = new Array(M).fill(0);
  for (const subset of before) for (const b of subset) load[b] += 1;
  const after = Array.from({ length: F }, (_, f) => choose(f, backends.slice(1))); // backend 0 is removed
  let opened = 0;
  for (let f = 0; f < F; f++) for (const b of after[f]) if (!before[f].has(b)) opened += 1;
  const pad = (x, w) => String(x).padStart(w);
  console.log(
    `  ${name.padEnd(14)} frontends per backend: min ${pad(Math.min(...load), 2)}  max ${pad(Math.max(...load), 2)}` +
      `   remove one backend: ${pad(opened, 4)} new connections`,
  );
}

console.log(`${F} frontends, ${M} backends, each frontend connects to ${K} (even answer: ${(F * K) / M} per backend)`);
report('deterministic', deterministicSubset);
report('rendezvous', rendezvousSubset);
