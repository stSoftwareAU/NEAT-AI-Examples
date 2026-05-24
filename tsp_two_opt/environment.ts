/**
 * tsp_two_opt environment — episode runner and 2-opt swap mechanics.
 *
 * Each episode starts from the deterministic nearest-neighbour tour for
 * the chosen TSPLIB instance (see {@link common/tsp_instances.ts}). The
 * controller is then asked to propose at most {@link DEFAULT_PROPOSAL_BUDGET}
 * 2-opt swaps; accepted swaps are applied in place to the running tour
 * and the post-budget improvement over the nearest-neighbour baseline
 * length is reported as fitness.
 *
 * A proposed swap `(i, j)` reverses the sub-tour `tour[i+1 .. j]`. The
 * pre/post edge lengths are evaluated in O(1) using only the four edges
 * touched by the reversal; the swap is *accepted* when the post-swap
 * length is strictly smaller than the pre-swap length. No-op proposals
 * (`i === j`) consume one budget tick but never mutate the tour.
 *
 * Fitness is the **fractional improvement** over the nearest-neighbour
 * seed length, measured in plain Euclidean space (see
 * `common/tsp_instances.ts` for why we cannot use the TSPLIB GEO-distance
 * optimum directly):
 *
 *   fitness = max(0, (nnLength − finalLength) / nnLength)
 *
 * - `0.0` — no improvement at all (e.g. budget burned on no-op swaps).
 * - `~0.3` — for burma14 this means the tour collapsed by roughly a
 *   third versus the nearest-neighbour seed.
 * - `1.0` — would require driving the tour length to zero, which is
 *   impossible; in practice fitness sits comfortably under `0.5`.
 *
 * Australian English in all docstrings.
 */
import {
  decodeProposal,
  edgeLengths,
  encodeObservation,
  K_LONGEST,
  longestEdgeIndices,
  type TwoOptProposal,
} from "./agent.ts";
import {
  euclideanDistance,
  nearestNeighbourTour,
  tourLength,
  type TspCity,
  type TspInstance,
} from "../common/tsp_instances.ts";

/** Default number of 2-opt swap proposals per episode. */
export const DEFAULT_PROPOSAL_BUDGET = 200;

/** Outcome of running a full 2-opt episode for a single creature. */
export interface EpisodeResult {
  /** The nearest-neighbour seed tour (constant for every episode). */
  readonly seedTour: ReadonlyArray<number>;
  /** Tour length of the seed (for reporting). */
  readonly seedLength: number;
  /** Tour produced after the 2-opt swap budget was exhausted. */
  readonly finalTour: ReadonlyArray<number>;
  /** Tour length after applying every accepted swap. */
  readonly finalLength: number;
  /** Published TSPLIB optimum for the chosen instance (for reporting). */
  readonly optimum: number;
  /**
   * Improvement ratio in `[0, 1]`. See module header for the formula.
   */
  readonly improvementRatio: number;
  /** Number of proposals issued (`<= proposalBudget`). */
  readonly proposalsIssued: number;
  /** Number of proposals actually accepted (strictly improved the tour). */
  readonly proposalsAccepted: number;
}

/** Per-step record kept for the SVG renderer's animated playhead. */
export interface StepFrame {
  /** Tour state after applying this proposal (or the unchanged tour on reject/noop). */
  readonly tour: ReadonlyArray<number>;
  /** Tour length after this proposal. */
  readonly length: number;
  /** True when the proposal was accepted and the tour mutated. */
  readonly accepted: boolean;
}

/**
 * Apply a 2-opt swap to `tour` in place: reverse the sub-array
 * `tour[i+1 .. j]`. `i < j` must hold. Returns `tour` for chaining.
 */
export function applyTwoOptSwap(
  tour: number[],
  i: number,
  j: number,
): number[] {
  if (i >= j) {
    throw new Error(`applyTwoOptSwap requires i < j, got i=${i} j=${j}`);
  }
  let lo = i + 1;
  let hi = j;
  while (lo < hi) {
    const tmp = tour[lo];
    tour[lo] = tour[hi];
    tour[hi] = tmp;
    lo++;
    hi--;
  }
  return tour;
}

/**
 * O(1) change in tour length produced by reversing `tour[i+1 .. j]`.
 * Returns `postLength − preLength`; negative means the swap improves
 * the tour, so accept it iff the return value is `< 0`.
 */
export function twoOptDelta(
  cities: ReadonlyArray<TspCity>,
  tour: ReadonlyArray<number>,
  i: number,
  j: number,
): number {
  const n = tour.length;
  // The reversal removes edges (tour[i], tour[i+1]) and (tour[j], tour[j+1])
  // and replaces them with (tour[i], tour[j]) and (tour[i+1], tour[j+1]).
  // When (i, j) wraps the whole tour the delta collapses to 0.
  const a = tour[i];
  const b = tour[i + 1];
  const c = tour[j];
  const d = tour[(j + 1) % n];
  if (b === c || a === d) return 0;
  const removed = euclideanDistance(cities[a], cities[b]) +
    euclideanDistance(cities[c], cities[d]);
  const added = euclideanDistance(cities[a], cities[c]) +
    euclideanDistance(cities[b], cities[d]);
  return added - removed;
}

/**
 * Behavioural contract for the controller passed to {@link runEpisode}.
 *
 * The runner calls `activate(observation)` once per proposal step, then
 * decodes the output via {@link decodeProposal}. We keep this signature
 * narrow so tests can drop in a synthetic controller without spinning
 * up a real NEAT-AI {@link import("@stsoftware/neat-ai").Creature}.
 */
export interface PolicyLike {
  activate(input: Float32Array): Float32Array | number[];
  clearState?: () => void;
}

/**
 * 2-opt swap acceptance rule (issue #482).
 *
 * - `"strict"` — accept iff `delta < 0` (the original rule used on
 *   `burma14` and `ulysses22`). Default.
 * - `"mh"` — Metropolis-Hastings: improving swaps (`delta < 0`) are
 *   always accepted; worsening swaps (`delta >= 0`) are accepted with
 *   probability `exp(-delta / (T · seedLength))`. Used by the
 *   `pcb442` hybrid orchestrator so the search can climb out of local
 *   optima. At `T → 0` the rule degenerates back to strict-improvement.
 */
export type TwoOptAcceptanceMode = "strict" | "mh";

/** Options for {@link runEpisode}. */
export interface RunEpisodeOptions {
  /** Number of proposals to issue. Default {@link DEFAULT_PROPOSAL_BUDGET}. */
  proposalBudget?: number;
  /** When true the runner records a {@link StepFrame} per proposal. */
  recordFrames?: boolean;
  /** Acceptance rule for proposed 2-opt swaps. Default {@link "strict"}. */
  acceptanceMode?: TwoOptAcceptanceMode;
  /**
   * Dimensionless MH temperature (only consulted when `acceptanceMode`
   * is `"mh"`). The accept probability for a worsening swap is
   * `exp(-delta / (temperature · seedLength))` so the temperature is
   * comparable across instances of different scales. Defaults to `0`
   * (strict-improvement behaviour, no MH lift).
   */
  temperature?: number;
  /**
   * Optional deterministic `[0, 1)` RNG for MH accept tests. When
   * omitted, `Math.random` is used. Tests pass a seeded PRNG so the
   * acceptance trace is reproducible.
   */
  random?: () => number;
}

/** Full record of an episode, including optional per-step frames. */
export interface EpisodeRecord extends EpisodeResult {
  /** Per-proposal frame log (only populated when `recordFrames` is true). */
  readonly frames: ReadonlyArray<StepFrame>;
}

/**
 * Run one full 2-opt improvement episode against `instance`. Seeds the
 * tour from {@link nearestNeighbourTour}, then loops for `proposalBudget`
 * ticks: encode observation, ask the policy, decode the proposal,
 * accept iff it strictly improves the tour. Returns the final length,
 * improvement ratio, and (when requested) the per-proposal frame log.
 */
export function runEpisode(
  policy: PolicyLike,
  instance: TspInstance,
  options: RunEpisodeOptions = {},
): EpisodeRecord {
  const proposalBudget = options.proposalBudget ?? DEFAULT_PROPOSAL_BUDGET;
  const acceptanceMode: TwoOptAcceptanceMode = options.acceptanceMode ?? "strict";
  const temperature = options.temperature ?? 0;
  const random = options.random ?? Math.random;
  const cities = instance.cities;

  const seedTour = nearestNeighbourTour(cities, 0);
  const seedLength = tourLength(cities, seedTour);

  const tour = seedTour.slice();
  const frames: StepFrame[] = [];
  let accepted = 0;
  let issued = 0;
  let currentLength = seedLength;

  // MH temperature is scaled by the seed length so the same dimensionless
  // `temperature` value translates across instances of different scales
  // (pcb442 tour ~50 000, burma14 tour ~32). At `temperature === 0` the
  // rule collapses to strict-improvement regardless of `acceptanceMode`.
  const mhScale = temperature > 0 ? temperature * Math.max(1e-9, seedLength) : 0;

  for (let step = 0; step < proposalBudget; step++) {
    issued++;
    const lengths = edgeLengths(cities, tour);
    const sortedLongest = longestEdgeIndices(lengths);
    const observation = encodeObservation(
      cities,
      tour,
      proposalBudget - step,
      proposalBudget,
    );

    policy.clearState?.();
    const out = policy.activate(observation);
    const outputs = out instanceof Float32Array ? out : new Float32Array(out);

    const proposal: TwoOptProposal = decodeProposal(outputs, sortedLongest);
    let wasAccepted = false;
    if (!proposal.noop) {
      const delta = twoOptDelta(cities, tour, proposal.i, proposal.j);
      const accept = shouldAcceptSwap(delta, acceptanceMode, mhScale, random);
      if (accept) {
        applyTwoOptSwap(tour, proposal.i, proposal.j);
        currentLength += delta;
        accepted++;
        wasAccepted = true;
      }
    }
    if (options.recordFrames) {
      frames.push({ tour: tour.slice(), length: currentLength, accepted: wasAccepted });
    }
  }

  const finalLength = currentLength;
  // Fractional improvement over the nearest-neighbour seed length (in
  // Euclidean space). Always bounded in `[0, 1]` — the runner never
  // accepts a swap that lengthens the tour, so finalLength <= seedLength.
  let improvementRatio = 0;
  if (seedLength > 0) {
    improvementRatio = (seedLength - finalLength) / seedLength;
  }
  if (improvementRatio < 0) improvementRatio = 0;
  if (improvementRatio > 1) improvementRatio = 1;

  return {
    seedTour,
    seedLength,
    finalTour: tour,
    finalLength,
    optimum: instance.optimum,
    improvementRatio,
    proposalsIssued: issued,
    proposalsAccepted: accepted,
    frames,
  };
}

/**
 * Decide whether a proposed 2-opt swap is accepted given its `delta`
 * (post-swap minus pre-swap tour length), the acceptance `mode`, the
 * pre-scaled MH denominator `mhScale` (= `temperature · seedLength`),
 * and an injected `random` source.
 *
 * - Strictly improving swaps (`delta < 0`) are always accepted.
 * - Strict mode rejects every non-improving swap (this matches the
 *   original `burma14` / `ulysses22` rule).
 * - MH mode accepts a worsening swap with probability
 *   `exp(-delta / mhScale)`. When `mhScale` is `0` the probability is
 *   `0` (`T → 0` degenerates to strict-improvement).
 *
 * Exported for unit tests so the acceptance edge cases can be exercised
 * without spinning up a full episode.
 */
export function shouldAcceptSwap(
  delta: number,
  mode: TwoOptAcceptanceMode,
  mhScale: number,
  random: () => number,
): boolean {
  if (delta < 0) return true;
  if (mode !== "mh" || mhScale <= 0) return false;
  const probability = Math.exp(-delta / mhScale);
  return random() < probability;
}

// Re-export K_LONGEST so callers do not have to reach into agent.ts just
// to know the action-space width.
export { K_LONGEST };
