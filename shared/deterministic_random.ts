/**
 * A seeded pseudo-random number generator (PRNG) for deterministic data generation.
 *
 * Uses a splitmix32-style algorithm to produce reproducible sequences
 * of numbers in the range [0, 1). Given the same seed, the sequence
 * is identical across runs and platforms.
 */
export function createDeterministicRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
