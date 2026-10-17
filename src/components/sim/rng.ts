import type { Rng } from './types';

/**
 * Mulberry32: a tiny, fast 32-bit PRNG. Not for cryptography, but plenty for simulations,
 * and it makes every run reproducible from its seed.
 */
export function createRng(seed = 42): Rng {
  let state = seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    exponential: (mean) => -Math.log(1 - next()) * mean,
  };
}
