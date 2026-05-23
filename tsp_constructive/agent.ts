/**
 * TSP-constructive agent: per-step observation builder and action decoder.
 *
 * Each step the agent picks the next city to visit from the `K = 5`
 * nearest **unvisited** cities. The observation encodes:
 *
 *   - For each of the `K` candidate slots (in nearest-first order):
 *     - `dx` — `(candidate.x − current.x) / boundingBoxDiagonal`.
 *     - `dy` — `(candidate.y − current.y) / boundingBoxDiagonal`.
 *   - One scalar "fewer-than-K unvisited cities left" flag (`1` when there
 *     are strictly fewer than `K` unvisited candidates, `0` otherwise).
 *     This lets the network learn that the late-tour slots are not
 *     meaningful neighbours but padding.
 *   - The heading vector from the previous step — `(prevDx, prevDy)`
 *     normalised by the diagonal. Zero on the first step.
 *
 * Action decoding: softmax over the `K` output channels picks the
 * candidate slot to visit. Padded slots (when fewer than `K` unvisited
 * cities remain) are masked to `-Infinity` before the argmax so a
 * sloppy network can never "pick" a non-existent city.
 *
 * The encoding is fully deterministic — the same `(cities, currentIndex,
 * visited, previousHeading)` tuple always produces the same Float32Array.
 */

import { boundingBoxDiagonal, euclideanDistance, type TspCity } from "../common/tsp_instances.ts";

/** Number of nearest unvisited candidates the agent can pick from per step. */
export const K_NEAREST = 5;

/**
 * Per-candidate channel count: `(dx, dy)` for each of the `K` slots.
 * Plus a single "padded" scalar and the two-component previous-heading
 * vector.
 */
export const INPUT_COUNT = K_NEAREST * 2 + 1 + 2;

/** One output per nearest-unvisited slot. */
export const OUTPUT_COUNT = K_NEAREST;

/** A single candidate considered at a given step. */
export interface Candidate {
  /** Index into the `cities` array. */
  readonly cityIndex: number;
  /** Euclidean distance from the current city — used for nearest-first sort. */
  readonly distance: number;
}

/**
 * Return the `K_NEAREST` nearest unvisited cities to `currentIndex`,
 * ordered by ascending distance. Ties are broken by ascending city
 * index so the same input always produces the same order. Length may
 * be less than `K_NEAREST` near the end of a tour.
 */
export function kNearestUnvisited(
  cities: ReadonlyArray<TspCity>,
  currentIndex: number,
  visited: ReadonlyArray<boolean>,
  k: number = K_NEAREST,
): Candidate[] {
  if (cities.length !== visited.length) {
    throw new Error(
      `visited length ${visited.length} does not match cities length ${cities.length}`,
    );
  }
  const here = cities[currentIndex];
  if (!here) {
    throw new Error(`currentIndex ${currentIndex} out of range for ${cities.length} cities`);
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < cities.length; i++) {
    if (visited[i]) continue;
    if (i === currentIndex) continue;
    candidates.push({ cityIndex: i, distance: euclideanDistance(here, cities[i]) });
  }
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.cityIndex - b.cityIndex;
  });
  return candidates.slice(0, k);
}

/**
 * Encode the per-step observation as a {@link Float32Array} of length
 * {@link INPUT_COUNT}. Padded slots (when fewer than `K_NEAREST`
 * candidates exist) carry zero `dx`/`dy`, and the "padded" flag is set
 * to `1`.
 *
 * `diagonal` is normally {@link boundingBoxDiagonal} of `cities`; the
 * caller may pass a cached value to avoid recomputing it every step.
 */
export function encodeObservation(
  cities: ReadonlyArray<TspCity>,
  currentIndex: number,
  candidates: ReadonlyArray<Candidate>,
  previousHeading: readonly [number, number],
  diagonal: number = boundingBoxDiagonal(cities),
): Float32Array {
  if (!Number.isFinite(diagonal) || diagonal <= 0) {
    throw new Error(`boundingBoxDiagonal must be positive and finite, got ${diagonal}`);
  }
  const here = cities[currentIndex];
  if (!here) {
    throw new Error(`currentIndex ${currentIndex} out of range for ${cities.length} cities`);
  }
  const out = new Float32Array(INPUT_COUNT);
  for (let slot = 0; slot < K_NEAREST; slot++) {
    const cand = candidates[slot];
    if (cand !== undefined) {
      const there = cities[cand.cityIndex];
      out[slot * 2] = (there.x - here.x) / diagonal;
      out[slot * 2 + 1] = (there.y - here.y) / diagonal;
    } else {
      out[slot * 2] = 0;
      out[slot * 2 + 1] = 0;
    }
  }
  // Padded-flag: 1 when fewer than K candidates exist.
  out[K_NEAREST * 2] = candidates.length < K_NEAREST ? 1 : 0;
  // Previous-step heading (normalised). Zero on the first step.
  out[K_NEAREST * 2 + 1] = previousHeading[0] / diagonal;
  out[K_NEAREST * 2 + 2] = previousHeading[1] / diagonal;
  return out;
}

/**
 * Pick the candidate slot index produced by the network. Padded slots
 * (those past `candidates.length`) are masked out, so the returned
 * index is always a valid index into `candidates`. Ties favour the
 * lowest (nearest) slot — purely deterministic.
 *
 * The softmax is not strictly necessary for argmax, but the issue calls
 * for "softmax over the K candidate slots → pick that nearest-unvisited
 * city". Argmax over raw outputs and argmax after a monotonic softmax
 * produce the same index, so we keep the path cheap.
 */
export function decodeAction(
  outputs: ArrayLike<number>,
  candidates: ReadonlyArray<Candidate>,
): number {
  if (candidates.length === 0) {
    throw new Error("decodeAction requires at least one candidate");
  }
  let bestSlot = 0;
  let bestScore = -Infinity;
  for (let slot = 0; slot < candidates.length; slot++) {
    const value = slot < outputs.length ? outputs[slot] : -Infinity;
    if (value > bestScore) {
      bestScore = value;
      bestSlot = slot;
    }
  }
  return bestSlot;
}
