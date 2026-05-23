/**
 * tsp_two_opt agent — observation builder and action decoder for a learned
 * 2-opt local-search heuristic.
 *
 * Each episode begins on a nearest-neighbour seed tour and the evolved
 * controller proposes 2-opt swaps that try to improve it within a fixed
 * proposal budget. To keep the network topology constant across TSP
 * instances of different sizes, both the observation vector and the action
 * vector index only into the {@link K_LONGEST} longest edges of the
 * current tour (the rest of the tour is invisible to the policy).
 *
 * Observation (length {@link INPUT_COUNT}, all values in `[0, 1]` once
 * normalised by the bounding-box diagonal):
 *
 *  0. Mean edge length of the current tour.
 *  1. Maximum edge length of the current tour.
 *  2. Population standard deviation of edge lengths.
 *  3. Proposals remaining, normalised by the swap budget.
 *  4. …4 + K_LONGEST − 1: lengths of the {@link K_LONGEST} longest edges
 *     in descending order.
 *  4 + K_LONGEST …4 + 4·K_LONGEST − 1: per-longest-edge sliding window of
 *     length 3 — `[prev_edge_len, this_edge_len, next_edge_len]` for each
 *     of the K longest edges (edge wraps around the closed tour).
 *
 * Action (length {@link OUTPUT_COUNT}): two softmax-style argmax slots
 * over the K-longest list — the first K outputs pick edge `a`, the next K
 * pick edge `b`. The chosen pair `(a, b)` maps to tour-position indices
 * `(i, j) = sortedLongest[a], sortedLongest[b]`; the proposed 2-opt swap
 * reverses the sub-tour `tour[i+1..j]` (with `i < j`). When `a == b` the
 * proposal collapses to a no-op and the environment discards it without
 * mutating the tour. This action space keeps the network's output count
 * fixed at `2 · K_LONGEST` regardless of instance size.
 *
 * Australian English in all docstrings.
 */
import { boundingBoxDiagonal, euclideanDistance, type TspCity } from "../common/tsp_instances.ts";

/**
 * Number of "longest edges" surfaced to the policy. The action space is
 * `2 · K_LONGEST` and the observation includes the K_LONGEST edge
 * lengths plus a 3-wide window around each, so the input and output
 * counts are derived from this single constant.
 */
export const K_LONGEST = 5;

/** Width of the sliding window of edge lengths around each candidate edge. */
export const WINDOW_WIDTH = 3;

/** Number of observation inputs the network consumes per tick. */
export const INPUT_COUNT = 3 + 1 + K_LONGEST + K_LONGEST * WINDOW_WIDTH;

/**
 * Number of action outputs. The first {@link K_LONGEST} outputs pick
 * edge `a`; the next {@link K_LONGEST} pick edge `b`. The network's
 * argmax over each half selects the proposal.
 */
export const OUTPUT_COUNT = 2 * K_LONGEST;

/**
 * A 2-opt swap proposal. `i` and `j` are positions in the current tour
 * (`0 <= i < j < n`). When `i === j` the proposal is a no-op and should
 * be discarded by the environment.
 */
export interface TwoOptProposal {
  /** First edge position in the current tour. */
  readonly i: number;
  /** Second edge position in the current tour (must satisfy `j > i`). */
  readonly j: number;
  /** True when the proposal collapsed to `i === j` and is a no-op. */
  readonly noop: boolean;
}

/**
 * Compute the closed-tour edge lengths for a permutation. Edge `i`
 * connects city `tour[i]` to city `tour[(i + 1) mod n]`.
 */
export function edgeLengths(
  cities: ReadonlyArray<TspCity>,
  tour: ReadonlyArray<number>,
): number[] {
  const n = tour.length;
  const lengths = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = cities[tour[i]];
    const b = cities[tour[(i + 1) % n]];
    lengths[i] = euclideanDistance(a, b);
  }
  return lengths;
}

/**
 * Indices of the {@link K_LONGEST} longest edges in the supplied
 * `lengths` array, sorted descending by length. Ties are broken by
 * lower edge index so the result is deterministic. When `lengths.length`
 * is shorter than {@link K_LONGEST}, the remainder of the result is
 * filled with the modulo-wrapped first edge so the output array length
 * is constant — this only matters for tiny pathological tests and
 * never bites the production instances.
 */
export function longestEdgeIndices(lengths: ReadonlyArray<number>): number[] {
  const indexed = lengths.map((len, idx) => ({ len, idx }));
  indexed.sort((a, b) => (b.len - a.len) || (a.idx - b.idx));
  const out: number[] = [];
  for (let k = 0; k < K_LONGEST; k++) {
    const pick = indexed[k % indexed.length];
    out.push(pick.idx);
  }
  return out;
}

/** Mean of a non-empty numeric array. */
function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Population standard deviation of a non-empty numeric array. */
function stddev(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sq = 0;
  for (const v of values) {
    const d = v - m;
    sq += d * d;
  }
  return Math.sqrt(sq / values.length);
}

/**
 * Build the observation vector for the current tour. `proposalsLeft`
 * and `proposalBudget` together encode the budget channel; the
 * normalisation constant `diag` is the bounding-box diagonal returned
 * by {@link boundingBoxDiagonal} (capped at `1` so single-city
 * pathological cases do not divide by zero).
 */
export function encodeObservation(
  cities: ReadonlyArray<TspCity>,
  tour: ReadonlyArray<number>,
  proposalsLeft: number,
  proposalBudget: number,
): Float32Array {
  const diagRaw = boundingBoxDiagonal(cities);
  const diag = diagRaw > 0 ? diagRaw : 1;
  const lengths = edgeLengths(cities, tour);
  const longest = longestEdgeIndices(lengths);
  const n = lengths.length;

  const obs = new Float32Array(INPUT_COUNT);
  obs[0] = mean(lengths) / diag;
  obs[1] = Math.max(...lengths) / diag;
  obs[2] = stddev(lengths) / diag;
  obs[3] = proposalBudget > 0 ? proposalsLeft / proposalBudget : 0;

  // K_LONGEST longest edge lengths, normalised.
  for (let k = 0; k < K_LONGEST; k++) {
    obs[4 + k] = lengths[longest[k]] / diag;
  }

  // Sliding window of length WINDOW_WIDTH centred on each longest edge.
  const base = 4 + K_LONGEST;
  for (let k = 0; k < K_LONGEST; k++) {
    const centre = longest[k];
    for (let w = 0; w < WINDOW_WIDTH; w++) {
      const offset = w - Math.floor(WINDOW_WIDTH / 2);
      const idx = ((centre + offset) % n + n) % n;
      obs[base + k * WINDOW_WIDTH + w] = lengths[idx] / diag;
    }
  }
  return obs;
}

/**
 * Decode the network's output vector into a 2-opt proposal. The first
 * {@link K_LONGEST} outputs pick edge `a` (argmax); the next
 * {@link K_LONGEST} outputs pick edge `b`. The chosen K-longest slots
 * are converted to current-tour positions via `sortedLongest`. If
 * `a === b` (collapsed proposal) the returned proposal has `noop = true`
 * and `i === j`; otherwise positions are sorted so `i < j`.
 */
export function decodeProposal(
  outputs: ArrayLike<number>,
  sortedLongest: ReadonlyArray<number>,
): TwoOptProposal {
  const a = argmax(outputs, 0, K_LONGEST);
  const b = argmax(outputs, K_LONGEST, K_LONGEST);
  const posA = sortedLongest[a];
  const posB = sortedLongest[b];
  if (posA === posB) {
    return { i: posA, j: posA, noop: true };
  }
  const i = Math.min(posA, posB);
  const j = Math.max(posA, posB);
  return { i, j, noop: false };
}

/**
 * Argmax over `outputs[offset .. offset + length)`. Ties favour the
 * lower index so the decoding is deterministic.
 */
function argmax(outputs: ArrayLike<number>, offset: number, length: number): number {
  let bestIdx = 0;
  let best = outputs[offset];
  for (let i = 1; i < length; i++) {
    const v = outputs[offset + i];
    if (v > best) {
      best = v;
      bestIdx = i;
    }
  }
  return bestIdx;
}
