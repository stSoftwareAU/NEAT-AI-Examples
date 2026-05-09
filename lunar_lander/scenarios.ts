/**
 * Deterministic scenario sampler for the lunar-lander example.
 *
 * Issue #195: a champion that simply memorises a single trajectory must
 * not pass evaluation. Two safeguards live here:
 *
 *   1. **Wider distribution** — every component (position, velocity,
 *      tilt, fuel, and the pad's horizontal centre) is sampled around
 *      the canonical entry across a substantially wider range than the
 *      legacy {@link perturbedInitialState} sampler. See
 *      {@link WIDE_RANGES} in `physics.ts`.
 *   2. **Disjoint training and validation pools** — given a single base
 *      seed, this module derives two non-overlapping pools of per-
 *      scenario seeds. A controller that overfits training seeds cannot
 *      see validation seeds during evolution, so its validation score
 *      reflects generalisation rather than memorisation.
 *
 * The output is byte-deterministic for any fixed `(baseSeed, training,
 * validation)` tuple.
 */
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  type LanderScenario,
  type LanderState,
  type LanderTerrain,
  perturbedScenario,
} from "./physics.ts";

/** Default training-pool size. */
export const DEFAULT_TRAINING_COUNT = 1000;

/** Default validation-pool size. */
export const DEFAULT_VALIDATION_COUNT = 200;

/** A seeded scenario: starting state + terrain + the seed that produced them. */
export interface SeededScenario {
  /** The 32-bit seed used to draw this scenario. */
  seed: number;
  /** Initial lander state. */
  state: LanderState;
  /** Terrain (notably `padX`, which varies between scenarios). */
  terrain: LanderTerrain;
}

/** Disjoint training/validation seed pools and their realised scenarios. */
export interface ScenarioPools {
  /** 32-bit seeds used for training scenarios. */
  trainingSeeds: number[];
  /** 32-bit seeds used for validation scenarios; disjoint from training. */
  validationSeeds: number[];
  /** Realised training scenarios, in seed order. */
  training: SeededScenario[];
  /** Realised validation scenarios, in seed order. */
  validation: SeededScenario[];
}

/**
 * Build disjoint training and validation seed pools and the matching
 * lander scenarios. The procedure is deterministic: for any given
 * `baseSeed`, the same `trainingCount` and `validationCount` produce
 * byte-identical pools.
 *
 * Seeds are drawn from a splitmix32-style PRNG seeded by `baseSeed`,
 * with a `Set` rejecting duplicates so the training and validation
 * pools never share a seed.
 *
 * Each scenario is built by feeding its own seed into a fresh PRNG and
 * passing that to {@link perturbedScenario}. Per-scenario isolation
 * means a scenario's state does not depend on its position in the
 * pool.
 *
 * @param baseSeed Master seed driving the seed-pool draw.
 * @param trainingCount Number of training scenarios (default 1000).
 * @param validationCount Number of validation scenarios (default 200).
 * @param magnitude Scale factor passed to {@link perturbedScenario}.
 */
export function generateScenarioPools(
  baseSeed: number,
  trainingCount: number = DEFAULT_TRAINING_COUNT,
  validationCount: number = DEFAULT_VALIDATION_COUNT,
  magnitude: number = 1.0,
): ScenarioPools {
  if (!Number.isFinite(baseSeed)) {
    throw new Error(`baseSeed must be finite, got ${baseSeed}`);
  }
  if (
    !Number.isInteger(trainingCount) || trainingCount < 0 ||
    !Number.isInteger(validationCount) || validationCount < 0
  ) {
    throw new Error(
      `pool counts must be non-negative integers, got training=${trainingCount} validation=${validationCount}`,
    );
  }
  if (!(magnitude > 0)) {
    throw new Error(`magnitude must be positive, got ${magnitude}`);
  }

  const seedDraw = createDeterministicRandom(baseSeed);
  const used = new Set<number>();
  const drawSeed = (): number => {
    // Reject duplicates so training and validation pools cannot share
    // a seed. With a 32-bit PRNG and pool sizes of O(10^3) collisions
    // are vanishingly rare, but the explicit check is a guarantee, not
    // an optimisation.
    let attempts = 0;
    while (true) {
      const r = Math.floor(seedDraw() * 0x1_0000_0000) >>> 0;
      if (!used.has(r)) {
        used.add(r);
        return r;
      }
      if (++attempts > 1024) {
        throw new Error("seed draw failed to find a unique 32-bit value");
      }
    }
  };

  const trainingSeeds: number[] = [];
  for (let i = 0; i < trainingCount; i++) trainingSeeds.push(drawSeed());
  const validationSeeds: number[] = [];
  for (let i = 0; i < validationCount; i++) validationSeeds.push(drawSeed());

  const buildScenario = (seed: number): SeededScenario => {
    const random = createDeterministicRandom(seed);
    const scenario: LanderScenario = perturbedScenario(random, magnitude);
    return { seed, state: scenario.state, terrain: scenario.terrain };
  };

  return {
    trainingSeeds,
    validationSeeds,
    training: trainingSeeds.map(buildScenario),
    validation: validationSeeds.map(buildScenario),
  };
}
