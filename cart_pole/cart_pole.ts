/**
 * Cart-Pole Balancing Example
 *
 * Evolves a NEAT-AI creature to balance an inverted pole on a moving
 * cart — the classic neuroevolution control benchmark. The physics
 * simulator (see `physics.ts`) is pure TypeScript. The evolutionary
 * loop is now driven entirely by NEAT-AI's class-shaped
 * `Creature.evolveRL()` API (issue #236, depends on
 * `stSoftwareAU/NEAT-AI#2630` and library version `5.0.0`).
 *
 * Inputs (per timestep): `[x, v, theta, omega]`.
 * Output: a single scalar in `[-1, 1]` (HARD_TANH default). When
 * `>= 0` the controller pushes right, otherwise left.
 * Score: the **mean** number of timesteps the pole stays upright across
 * `episodesPerCreature` perturbed-start trials, capped at `MAX_STEPS`
 * per trial. The task is "solved" when the mean reaches
 * `SOLVED_THRESHOLD`.
 *
 * 🌱 **Generation 1 starts from random noise.** The seed passed to
 * `Creature.evolveRL()` is a brand-new `new Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` — the library's uniform-random minimal genome. No
 * topology is hand-specified; structural mutation is owned by NEAT-AI.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  EpisodeAdapter,
  type EvolveRLOptions,
  safeWriteJson,
  type StepResult,
} from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  captureSnapshot,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import {
  type EpisodeAdapter as LocalEpisodeAdapter,
  runEpisode,
} from "../common/episode_runner.ts";
import {
  type CartPoleParams,
  type CartPoleState,
  DEFAULT_PARAMS,
  encodeState,
  initialState,
  isFailed,
  perturbedInitialState,
  step,
} from "./physics.ts";
import { renderRunSVG } from "./svg.ts";

/** Number of input observables (`x`, `v`, `theta`, `omega`). */
export const INPUT_COUNT = 4;

/** Number of output channels (the action scalar). */
export const OUTPUT_COUNT = 1;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = 500;

/**
 * Score threshold (mean steps across the perturbed-start trial suite)
 * at or above which the controller is declared "solved". 480 of 500
 * means the controller balances for at least 96% of the time on average
 * — a high bar that still tolerates the occasional unlucky start.
 *
 * Equivalent to a `targetError = 1 - SOLVED_THRESHOLD / MAX_STEPS = 0.04`
 * under the audit-mandated NEAT-AI stop-condition convention. With
 * `Creature.evolveRL()` the cumulative episode reward is mapped to
 * NEAT-AI's non-negative `error` slot via `defaultRewardToError`:
 * `error = max(0, -reward)`. The {@link CartPoleAdapter} normalises
 * rewards into `[-1, 0]` so the resulting error sits in `[0, 1]` as
 * required by `NeatOptions.targetError` — the caller's `0.04` value
 * therefore maps straight onto the upstream API without rescaling.
 */
export const SOLVED_THRESHOLD = 480;

/** Cart-pole action — `+1` pushes the cart right, `-1` pushes it left. */
export type CartPoleAction = 1 | -1;

/** Configuration options for {@link evolveCartPoleController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /**
   * NEAT-AI standard target-error stop condition (audit issue #220).
   * Evolution halts as soon as the champion's mean balance score reaches
   * `MAX_STEPS * (1 - targetError)`. Default `0.04` (mean steps ≥ 480 =
   * {@link SOLVED_THRESHOLD}). The value is mapped onto the absolute
   * error-units consumed by `EvolveRLOptions.targetError` inside this
   * function — the caller still talks in the historical normalised
   * fraction so existing tests and CLI surface remain unchanged.
   */
  targetError: number;
  /**
   * NEAT-AI standard wall-clock stop condition (audit issue #220).
   * Evolution halts when the elapsed time since the loop began exceeds
   * `timeoutMinutes` minutes (default `5`). Whichever of `targetError`
   * and `timeoutMinutes` fires first wins.
   */
  timeoutMinutes: number;
  /**
   * Optional generation cap (NEAT-AI's standard `iterations` option).
   * When supplied, the loop will also stop once `generation` reaches
   * this value — useful for fast unit tests that need a deterministic
   * generation count without depending on wall-clock timing. Defaults
   * to `Infinity` so production runs are bounded only by `targetError`
   * and `timeoutMinutes`.
   */
  iterations?: number;
  /**
   * Standard deviation of the weight/bias perturbation noise. Forwarded
   * to NEAT-AI's `mutationAmount` so existing CLI surfaces keep working.
   */
  mutationStrength: number;
  /**
   * Probability that any given gene is perturbed each generation.
   * Forwarded to NEAT-AI's `mutationRate`.
   */
  mutationRate: number;
  /**
   * Per-creature probability of receiving an add-neuron structural
   * mutation. Kept on the public API for backwards compatibility but is
   * no longer used directly — NEAT-AI owns mutation policy under
   * `evolveRL()`. Documented here so historical callers keep
   * type-checking; the value is ignored.
   */
  addNeuronRate?: number;
  /**
   * Number of independent perturbed-start trials each candidate is
   * scored on (mean across trials). Defaults to `1`. Maps to
   * `EvolveRLOptions.episodesPerCreature`.
   */
  trials?: number;
  /**
   * Half-width of the uniform `[-m, +m]` perturbation applied to each
   * component of the initial state. Defaults to `0`.
   */
  initialPerturbation?: number;
  /**
   * Seed for sampling the per-evaluation initial-state perturbations.
   * No longer applied directly — NEAT-AI rotates a per-generation seed
   * set derived from `EvolveRLOptions.seed`. Retained on the public API
   * for backwards compatibility.
   */
  trialSeed?: number;
  /**
   * Magnitude of the in-episode wobble disturbance force (newtons)
   * applied to the cart in addition to the controller's action force.
   * Default `0` (no wobble — textbook cart-pole). Non-zero values make
   * the task non-trivial so a uniform-random NEAT generation 1 cannot
   * already solve it (issue #160).
   */
  disturbanceMagnitude?: number;
  /**
   * Per-step probability (in `[0, 1]`) that a wobble disturbance fires.
   * Default `0`. Only consulted when `disturbanceMagnitude > 0`.
   */
  disturbanceProbability?: number;
  /**
   * Seed for the deterministic disturbance PRNG. No longer applied
   * directly — the wobble seed is derived from each episode's seed
   * inside the adapter so episodes within a generation see different
   * wobble patterns yet remain deterministic across runs.
   */
  disturbanceSeed?: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, a snapshot of the
   * seed creature is captured if generation `1` is a checkpoint, and a
   * snapshot of the final champion is captured if `result.generations`
   * is a checkpoint. Mid-run intermediate generations are no longer
   * captured because `Creature.evolveRL()` does not expose mid-run
   * creature exports — see issue #236 for the migration trade-offs.
   */
  snapshotConfig?: SnapshotConfig;
}

/** Options controlling multi-trial perturbed scoring of a single creature. */
export interface ScoreOptions {
  /** Number of trials to run; the returned score is the mean. Default 1. */
  trials?: number;
  /**
   * Seed for sampling per-trial initial-state perturbations. Identical
   * inputs always produce identical scores.
   */
  trialSeed?: number;
  /** Half-width of the uniform `[-m, +m]` perturbation. Default 0. */
  initialPerturbation?: number;
  /** Wobble disturbance magnitude (newtons). Default `0`. */
  disturbanceMagnitude?: number;
  /** Wobble disturbance probability `[0, 1]`. Default `0`. */
  disturbanceProbability?: number;
  /** Deterministic disturbance PRNG seed. */
  disturbanceSeed?: number;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best score reached by the champion (mean across trials). */
  bestScore: number;
  /** Number of generations run before stopping. */
  generations: number;
  /** True when the champion's mean reached {@link SOLVED_THRESHOLD}. */
  solved: boolean;
  /** Wall-clock duration of the evolution loop in milliseconds. */
  wallclockMs: number;
  /**
   * Why the evolution loop terminated:
   * - `"target"` — champion reached the `targetError`-derived score.
   * - `"timeout"` — `timeoutMinutes` elapsed before the target fired.
   * - `"iterations"` — the optional generation cap was hit first.
   */
  stopReason: "target" | "timeout" | "iterations";
}

/**
 * Sensible defaults for the demonstration runner.
 *
 * `targetError = 0.04` makes the target balance score `MAX_STEPS * (1 -
 * 0.04) = 480 = SOLVED_THRESHOLD`. Inside
 * {@link evolveCartPoleController} this is converted to the absolute
 * error scale `MAX_STEPS - SOLVED_THRESHOLD = 20` consumed by
 * `EvolveRLOptions.targetError`.
 */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 60,
  targetError: 1 - SOLVED_THRESHOLD / MAX_STEPS,
  timeoutMinutes: 5,
  mutationStrength: 0.6,
  mutationRate: 0.5,
  // Retained for backwards compatibility — NEAT-AI owns structural
  // mutation under evolveRL().
  addNeuronRate: 0.03,
  // Score every candidate against ten perturbed starts so the search
  // cannot win by getting lucky on a single symmetric launch.
  trials: 10,
  initialPerturbation: 0.1,
  trialSeed: 24680,
  // Wobble keeps cart-pole genuinely non-trivial so evolution from
  // uniform-random noise is visible.
  disturbanceMagnitude: 18,
  disturbanceProbability: 0.3,
  disturbanceSeed: 13579,
};

/** Adapter configuration consumed by {@link CartPoleAdapter}. */
export interface CartPoleAdapterOptions {
  /** Half-width of the uniform `[-m, +m]` perturbation. Default `0`. */
  initialPerturbation?: number;
  /** Wobble disturbance magnitude (newtons). Default `0`. */
  disturbanceMagnitude?: number;
  /** Wobble disturbance probability `[0, 1]`. Default `0`. */
  disturbanceProbability?: number;
  /** Cap on the number of physics ticks per episode. Default {@link MAX_STEPS}. */
  maxStepsPerEpisode?: number;
}

/** State threaded through each episode by {@link CartPoleAdapter}. */
export interface CartPoleEpisodeState {
  /** Current physics state. */
  physics: CartPoleState;
  /** 1-based step index of the just-completed step (`0` after `reset`). */
  stepIdx: number;
}

/**
 * Cart-pole episode adapter for `Creature.evolveRL()`. Each `step()`
 * advances the deterministic physics simulator, encodes the observation
 * as a `Float32Array`, and emits a reward that maps directly onto
 * NEAT-AI's non-negative `error` slot via `defaultRewardToError`:
 *
 * - Non-terminal step: reward `0`.
 * - Terminal step (cart out of bounds or pole past failure angle):
 *   reward `-(MAX_STEPS - stepIdx) / MAX_STEPS`. The
 *   `defaultRewardToError` mapping (`error = max(0, -reward)`) then
 *   yields a normalised `error = 1 - stepsSurvived / MAX_STEPS`.
 * - Truncated episode (the library's `maxSteps()` cap fires before any
 *   failure): cumulative reward `0` → `error = 0`. This is the
 *   "solved" case.
 *
 * Across `episodesPerCreature` trials the mean cumulative reward is
 * therefore `-(1 - meanSteps / MAX_STEPS)`, so
 * `EvolveRLOptions.targetError = 1 - SOLVED_THRESHOLD / MAX_STEPS =
 * 0.04` stops evolution as soon as the champion balances for an
 * average of `SOLVED_THRESHOLD` steps across the per-generation seed
 * set.
 */
export class CartPoleAdapter extends EpisodeAdapter<CartPoleEpisodeState, CartPoleAction> {
  /** Half-width of the per-component initial-state perturbation. */
  readonly initialPerturbation: number;
  /** Physics params (with disturbance fields plumbed through). */
  readonly params: CartPoleParams;
  /** Per-episode step cap. */
  readonly maxStepsPerEpisode: number;

  /**
   * Deterministic wobble PRNG for the current episode. Reseeded by
   * {@link reset} so two episodes with the same `rngSeed` produce
   * identical wobble patterns.
   */
  private wobbleRng?: () => number;

  constructor(options: CartPoleAdapterOptions = {}) {
    super();
    this.initialPerturbation = options.initialPerturbation ?? 0;
    this.maxStepsPerEpisode = options.maxStepsPerEpisode ?? MAX_STEPS;
    const magnitude = options.disturbanceMagnitude ?? 0;
    const probability = options.disturbanceProbability ?? 0;
    if (magnitude > 0 && probability > 0) {
      this.params = {
        ...DEFAULT_PARAMS,
        disturbanceMagnitude: magnitude,
        disturbanceProbability: probability,
      };
    } else {
      this.params = DEFAULT_PARAMS;
    }
  }

  override get observationLength(): number {
    return INPUT_COUNT;
  }

  override maxSteps(): number {
    return this.maxStepsPerEpisode;
  }

  override reset(
    rngSeed: number,
  ): { observation: Float32Array; state: CartPoleEpisodeState } {
    const initRng = createDeterministicRandom(rngSeed >>> 0);
    // Wobble RNG seeded with a different bit pattern so the initial
    // sampling and the in-episode disturbance stream do not correlate.
    this.wobbleRng = this.params.disturbanceMagnitude > 0
      ? createDeterministicRandom(((rngSeed >>> 0) ^ 0x9E3779B1) >>> 0)
      : undefined;
    const physics = this.initialPerturbation > 0
      ? perturbedInitialState(initRng, this.initialPerturbation)
      : initialState();
    return {
      observation: encodeState(physics),
      state: { physics, stepIdx: 0 },
    };
  }

  override decodeAction(
    creatureOutput: Float32Array,
    _state: CartPoleEpisodeState,
  ): CartPoleAction {
    return creatureOutput[0] >= 0 ? 1 : -1;
  }

  override step(
    state: CartPoleEpisodeState,
    action: CartPoleAction,
  ): StepResult<Float32Array> & { state: CartPoleEpisodeState } {
    const newPhysics = step(state.physics, action, this.params, this.wobbleRng);
    const newStepIdx = state.stepIdx + 1;
    const terminated = isFailed(newPhysics);
    // Reward shaping (normalised): zero everywhere except the terminal
    // step, where we emit `-(MAX_STEPS - stepIdx) / MAX_STEPS` so
    // `defaultRewardToError` yields `error = 1 - stepsSurvived / MAX_STEPS`.
    // A clean truncation by the step cap therefore scores `error = 0`,
    // and `NeatOptions.targetError = 0.04` corresponds to mean steps
    // ≥ 480 = SOLVED_THRESHOLD.
    const reward = terminated
      ? -(this.maxStepsPerEpisode - newStepIdx) / this.maxStepsPerEpisode
      : 0;
    return {
      state: { physics: newPhysics, stepIdx: newStepIdx },
      observation: encodeState(newPhysics),
      reward,
      terminated,
      truncated: false,
    };
  }
}

/** Adapter for the shared local rollout helper (scoring / replay path). */
function cartPoleAdapter(
  start: CartPoleState,
  params: CartPoleParams = DEFAULT_PARAMS,
  random?: () => number,
): LocalEpisodeAdapter<CartPoleState, CartPoleAction> {
  return {
    initialState: start,
    encode: encodeState,
    decode: (out) => (out[0] >= 0 ? 1 : -1),
    step: (s, a) => step(s, a, params, random),
    isTerminal: isFailed,
  };
}

/** Build {@link CartPoleParams} from a {@link ScoreOptions}. */
function paramsFromOptions(options?: ScoreOptions): CartPoleParams {
  const magnitude = options?.disturbanceMagnitude ?? 0;
  const probability = options?.disturbanceProbability ?? 0;
  if (magnitude <= 0 || probability <= 0) return DEFAULT_PARAMS;
  return {
    ...DEFAULT_PARAMS,
    disturbanceMagnitude: magnitude,
    disturbanceProbability: probability,
  };
}

/** Build the per-evaluation deterministic disturbance PRNG. */
function disturbanceRng(options?: ScoreOptions): (() => number) | undefined {
  const magnitude = options?.disturbanceMagnitude ?? 0;
  const probability = options?.disturbanceProbability ?? 0;
  if (magnitude <= 0 || probability <= 0) return undefined;
  return createDeterministicRandom(options?.disturbanceSeed ?? 0);
}

/**
 * Score a creature by running the cart-pole simulator. Used by tests
 * and the runner's post-evolution replay path.
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  options?: ScoreOptions,
): number {
  const trials = options?.trials ?? 1;
  const perturbation = options?.initialPerturbation ?? 0;
  const params = paramsFromOptions(options);
  const wobbleEnabled = (options?.disturbanceMagnitude ?? 0) > 0 &&
    (options?.disturbanceProbability ?? 0) > 0;
  const wobbleBaseSeed = options?.disturbanceSeed ?? 0;

  if (trials <= 1 && perturbation === 0 && !wobbleEnabled) {
    return runEpisode(creature, cartPoleAdapter(initialState(), params), { maxSteps }).steps;
  }

  const random = createDeterministicRandom(options?.trialSeed ?? 0);
  let total = 0;
  for (let t = 0; t < trials; t++) {
    const start = perturbation > 0 ? perturbedInitialState(random, perturbation) : initialState();
    const wobble = wobbleEnabled
      ? createDeterministicRandom((wobbleBaseSeed + t * 0x9E3779B1) >>> 0)
      : undefined;
    total += runEpisode(creature, cartPoleAdapter(start, params, wobble), { maxSteps }).steps;
  }
  return total / trials;
}

/** Score a hand-crafted "always push toward the pole's tilt" policy. */
export function scoreTiltDirectionPolicy(maxSteps: number = MAX_STEPS): number {
  let state: CartPoleState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    const action = state.theta >= 0 ? 1 : -1;
    state = step(state, action);
    if (isFailed(state)) {
      return stepIdx + 1;
    }
  }
  return maxSteps;
}

/** Replay a creature's run for visualisation. */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  options?: ScoreOptions,
): CartPoleState[] {
  const params = paramsFromOptions(options);
  const wobble = disturbanceRng(options);
  return runEpisode(creature, cartPoleAdapter(initialState(), params, wobble), { maxSteps }).trace;
}

/** Per-generation aggregate accumulated from `onEpisodeTrials` events. */
interface GenerationBucket {
  meanRewards: number[];
  bestReward: number;
  bestNeurons: number;
  bestSynapses: number;
}

/**
 * Run NEAT-AI's first-class reinforcement-learning evolution loop
 * against a {@link CartPoleAdapter}. Mutation, crossover, elitism,
 * plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #236).
 *
 * Per-generation telemetry is reconstructed by:
 *
 * 1. Accumulating per-creature `meanReward` via `onEpisodeTrials`.
 * 2. Reading champion topology counts from the optional
 *    `evolverl_milestone` events when `statistics: true` is enabled.
 * 3. Firing the caller's `options.onGeneration` callback from each
 *    `generation_complete` training event with the aggregated data.
 *
 * Snapshot capture is reduced to gen-1 (the seed creature) and the
 * final generation (the champion after `evolveRL` returns) because the
 * upstream API does not expose mid-run creature exports.
 */
export async function evolveCartPoleController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const adapter = new CartPoleAdapter({
    initialPerturbation: options.initialPerturbation,
    disturbanceMagnitude: options.disturbanceMagnitude,
    disturbanceProbability: options.disturbanceProbability,
    maxStepsPerEpisode: MAX_STEPS,
  });

  const seedCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const seedExport = seedCreature.exportJSON();
  const seedNeurons = seedExport.neurons.length + (seedExport.input ?? INPUT_COUNT);
  const seedSynapses = seedExport.synapses.length;

  // Capture the seed creature as the gen-1 snapshot so the existing
  // multi-panel SVG renderer still has at least one early-generation
  // panel to draw alongside the final champion.
  if (options.snapshotConfig?.checkpoints.includes(1)) {
    captureSnapshot(options.snapshotConfig, 1, seedExport, 0);
  }

  const generationData = new Map<number, GenerationBucket>();
  let latestBestNeurons = seedNeurons;
  let latestBestSynapses = seedSynapses;
  let bestSteps = 0;
  let lastObservedGeneration = 0;
  let solvedAtGen = -1;

  // EvolveRL normalised target error — the adapter emits rewards in
  // `[-1, 0]`, so `defaultRewardToError` produces an error in `[0, 1]`
  // equal to `1 - meanSteps / MAX_STEPS`. The caller's `targetError`
  // value already lives in that range, so it passes through unchanged.
  // Negative values (used by tests to force the wall-clock backstop)
  // are clamped to `0`, which is the smallest legal value.
  const absoluteTargetError = Math.max(0, options.targetError);

  const loopStart = Date.now();

  const evolveOptions: EvolveRLOptions = {
    seed: options.seed >>> 0,
    populationSize: options.populationSize,
    mutationRate: options.mutationRate,
    // NEAT-AI 5.0.0 owns mutation magnitude internally — we no longer
    // map the historical `mutationStrength` onto `mutationAmount`
    // (which is an *integer* count of mutations per offspring, not a
    // perturbation magnitude). The default policy is appropriate for
    // cart-pole.
    targetError: absoluteTargetError,
    timeoutMinutes: options.timeoutMinutes,
    iterations: options.iterations,
    episodesPerCreature: options.trials ?? 10,
    statistics: true,
    onEpisodeTrials: (event) => {
      let bucket = generationData.get(event.generation);
      if (!bucket) {
        bucket = {
          meanRewards: [],
          bestReward: Number.NEGATIVE_INFINITY,
          bestNeurons: latestBestNeurons,
          bestSynapses: latestBestSynapses,
        };
        generationData.set(event.generation, bucket);
      }
      bucket.meanRewards.push(event.meanReward);
      if (event.meanReward > bucket.bestReward) {
        bucket.bestReward = event.meanReward;
      }
    },
    onTrainingEvent: (event) => {
      if (event.kind === "evolverl_milestone") {
        latestBestNeurons = event.bestNeurons;
        latestBestSynapses = event.bestSynapses;
        const bucket = generationData.get(event.generation);
        if (bucket) {
          bucket.bestNeurons = event.bestNeurons;
          bucket.bestSynapses = event.bestSynapses;
        }
        return;
      }
      if (event.kind !== "generation_complete") return;

      lastObservedGeneration = event.generation;
      const bucket = generationData.get(event.generation);
      // Surface generation numbers as zero-based to match the historical
      // GenerationInfo contract.
      const generation0 = event.generation - 1;
      let bestStepsThisGen: number;
      let meanStepsThisGen: number;
      let neurons: number;
      let synapses: number;
      if (bucket && bucket.meanRewards.length > 0) {
        const sum = bucket.meanRewards.reduce((a, b) => a + b, 0);
        const meanReward = sum / bucket.meanRewards.length;
        // Reward in `[-1, 0]` maps to mean balance steps via
        // `meanSteps = MAX_STEPS * (1 + meanReward)`.
        meanStepsThisGen = MAX_STEPS * (1 + meanReward);
        bestStepsThisGen = MAX_STEPS * (1 + bucket.bestReward);
        neurons = bucket.bestNeurons;
        synapses = bucket.bestSynapses;
      } else {
        // No data this generation (e.g. every creature was an elite cached
        // from a previous round). Fall back to the previous champion's
        // known stats.
        meanStepsThisGen = bestSteps;
        bestStepsThisGen = bestSteps;
        neurons = latestBestNeurons;
        synapses = latestBestSynapses;
      }
      if (bestStepsThisGen > bestSteps) bestSteps = bestStepsThisGen;
      if (bestStepsThisGen >= SOLVED_THRESHOLD && solvedAtGen < 0) {
        solvedAtGen = generation0;
      }
      options.onGeneration?.({
        generation: generation0,
        bestScore: bestStepsThisGen,
        meanScore: meanStepsThisGen,
        neurons,
        synapses,
      });
    },
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;
  const finalGeneration = Math.max(lastObservedGeneration, result.generation);

  // The champion's `bestScore` mirrors evolveRL's own assessment so
  // that "the champion solved the task" agrees with `result.error <=
  // targetError`. The error is normalised: `error = 1 - meanSteps /
  // MAX_STEPS`, so `meanSteps = MAX_STEPS * (1 - error)`. Held-out
  // generalisation is exercised separately by callers re-running
  // `scoreController()` on a different seed set.
  const finalScore = MAX_STEPS * (1 - Math.max(0, Math.min(1, result.error)));
  if (finalScore > bestSteps) bestSteps = finalScore;

  // Capture the final champion as the last snapshot if the caller asked
  // for a checkpoint at the final generation (or used the default
  // checkpoint list that includes the final gen).
  if (options.snapshotConfig?.checkpoints.includes(finalGeneration)) {
    captureSnapshot(
      options.snapshotConfig,
      finalGeneration,
      seedCreature.exportJSON(),
      finalScore,
    );
  } else if (options.snapshotConfig) {
    // Always write a snapshot at the final generation so the multi-panel
    // SVG has a closing frame even when no exact checkpoint matches.
    captureSnapshot(
      { ...options.snapshotConfig, checkpoints: [finalGeneration] },
      finalGeneration,
      seedCreature.exportJSON(),
      finalScore,
    );
  }

  const targetScore = MAX_STEPS * (1 - absoluteTargetError);
  const targetMet = finalScore >= targetScore;

  let stopReason: "target" | "timeout" | "iterations";
  if (targetMet) {
    stopReason = "target";
  } else if (
    options.iterations !== undefined && finalGeneration >= options.iterations
  ) {
    stopReason = "iterations";
  } else {
    stopReason = "timeout";
  }

  return {
    champion: seedCreature,
    bestScore: finalScore,
    generations: finalGeneration,
    solved: targetMet,
    wallclockMs,
    stopReason,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/cart_pole.svg";

/** Number of evenly-spaced keyframes sampled for the SMIL-animated SVG. */
export const SVG_FRAME_COUNT = 60;

/** Generations at which the runner captures evolution snapshots. */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 100, 500, 1000];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-cart-pole/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/cart_pole_evolution.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/cart_pole_evolution_chart.svg";

/** Path to the per-generation evolution telemetry CSV (audit issue #220). */
export const EVOLUTION_CSV_PATH = "docs/data/cart_pole/evolution.csv";

/** Header row for the per-generation telemetry CSV (audit issue #220). */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path (audit issue #220). */
export const FITNESS_SVG_PATH = "docs/screenshots/cart_pole/fitness.svg";

/** Neuron / synapse count chart path (audit issue #220). */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/cart_pole/topology.svg";

/** One row of per-generation evolution telemetry. */
export interface EvolutionRow {
  generation: number;
  bestFitness: number;
  meanFitness: number;
  neuronCount: number;
  synapseCount: number;
}

function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/** Format an evolution-telemetry table into a deterministic CSV string. */
export function formatEvolutionCsv(rows: readonly EvolutionRow[]): string {
  const lines: string[] = [EVOLUTION_CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.generation,
        formatCsvNumber(r.bestFitness),
        formatCsvNumber(r.meanFitness),
        r.neuronCount,
        r.synapseCount,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ---- Topology chart renderer ------------------------------------------

const TOPOLOGY_SVG_WIDTH = 720;
const TOPOLOGY_SVG_HEIGHT = 320;
const TOPOLOGY_MARGIN = { top: 36, right: 70, bottom: 44, left: 60 };

/** Render the neuron / synapse count chart for the README. */
export function renderTopologyChartSvg(rows: readonly EvolutionRow[]): string {
  if (rows.length === 0) {
    throw new Error("renderTopologyChartSvg requires at least one row");
  }
  const innerW = TOPOLOGY_SVG_WIDTH - TOPOLOGY_MARGIN.left - TOPOLOGY_MARGIN.right;
  const innerH = TOPOLOGY_SVG_HEIGHT - TOPOLOGY_MARGIN.top - TOPOLOGY_MARGIN.bottom;
  const innerX = TOPOLOGY_MARGIN.left;
  const innerY = TOPOLOGY_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const maxNeurons = Math.max(...rows.map((r) => r.neuronCount), 1);
  const maxSynapses = Math.max(...rows.map((r) => r.synapseCount), 1);

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const neuronY = (n: number) => innerY + innerH - (n / maxNeurons) * innerH;
  const synapseY = (s: number) => innerY + innerH - (s / maxSynapses) * innerH;

  const neuronPts = rows
    .map((r) => `${xScale(r.generation).toFixed(2)},${neuronY(r.neuronCount).toFixed(2)}`)
    .join(" ");
  const synapsePts = rows
    .map((r) => `${xScale(r.generation).toFixed(2)},${synapseY(r.synapseCount).toFixed(2)}`)
    .join(" ");

  const leftTicks: string[] = [];
  const rightTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const ly = innerY + innerH - t * innerH;
    leftTicks.push(
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#2ca02c">` +
        `${(t * maxNeurons).toFixed(0)}</text>`,
    );
    rightTicks.push(
      `    <text x="${(innerX + innerW + 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="start" font-family="sans-serif" font-size="10" fill="#d62728">` +
        `${(t * maxSynapses).toFixed(0)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TOPOLOGY_SVG_WIDTH} ${TOPOLOGY_SVG_HEIGHT}" ` +
    `width="${TOPOLOGY_SVG_WIDTH}" height="${TOPOLOGY_SVG_HEIGHT}" role="img" ` +
    `aria-label="Cart Pole — neuron and synapse counts per generation">`,
    `  <title>Cart Pole — Topology Growth</title>`,
    `  <rect width="${TOPOLOGY_SVG_WIDTH}" height="${TOPOLOGY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TOPOLOGY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Cart Pole — Topology Growth</text>`,
    leftTicks.join("\n"),
    rightTicks.join("\n"),
    `  <polyline class="neuron-count" fill="none" stroke="#2ca02c" stroke-width="2" ` +
    `points="${neuronPts}"/>`,
    `  <polyline class="synapse-count" fill="none" stroke="#d62728" stroke-width="2" ` +
    `stroke-dasharray="6 3" points="${synapsePts}"/>`,
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`,
    `    <rect x="${(innerX + innerW - 198).toFixed(2)}" y="${(innerY + 6).toFixed(2)}" ` +
    `width="190" height="44" fill="#ffffff" fill-opacity="0.9" stroke="#cccccc"/>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 18).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 18).toFixed(2)}" ` +
    `stroke="#2ca02c" stroke-width="2"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 21).toFixed(2)}">` +
    `neurons (left axis)</text>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 36).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 36).toFixed(2)}" ` +
    `stroke="#d62728" stroke-width="2" stroke-dasharray="6 3"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 39).toFixed(2)}">` +
    `synapses (right axis)</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🎢 Cart-Pole Balancing Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-cart-pole");

  console.log("🧪 Sanity check: hand-crafted tilt-direction policy");
  const sanityScore = scoreTiltDirectionPolicy();
  console.log(`   Hand-crafted policy survived ${sanityScore} steps.`);

  console.log("\n🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${DEFAULT_EVOLVE_OPTIONS.targetError.toFixed(2)} ` +
      `(target score ≥ ${(MAX_STEPS * (1 - DEFAULT_EVOLVE_OPTIONS.targetError)).toFixed(0)}), ` +
      `timeoutMinutes=${DEFAULT_EVOLVE_OPTIONS.timeoutMinutes}`,
  );
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionRows: EvolutionRow[] = [];
  const evolutionStart = Date.now();
  const result = await evolveCartPoleController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestScore, meanScore, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      evolutionRows.push({
        generation,
        bestFitness: bestScore,
        meanFitness: meanScore,
        neuronCount: neurons,
        synapseCount: synapses,
      });
      if (generation % 5 === 0 || bestScore >= SOLVED_THRESHOLD) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  best=${
            bestScore.toFixed(1).padStart(6)
          }  mean=${meanScore.toFixed(1).padStart(6)}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations (best=${result.bestScore.toFixed(1)}, ` +
      `threshold=${SOLVED_THRESHOLD}, stop=${result.stopReason}, ` +
      `wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the SVG strip showing the champion balancing.
  const trace = replayController(result.champion, MAX_STEPS, {
    disturbanceMagnitude: DEFAULT_EVOLVE_OPTIONS.disturbanceMagnitude,
    disturbanceProbability: DEFAULT_EVOLVE_OPTIONS.disturbanceProbability,
    disturbanceSeed: DEFAULT_EVOLVE_OPTIONS.disturbanceSeed,
  });
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Cart-Pole — Evolution",
      scoreLabel: "best score",
    });
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  if (evolutionRows.length > 0) {
    ensureDirSync("docs/data/cart_pole");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(evolutionRows));
    console.log(`🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${evolutionRows.length} rows)`);

    ensureDirSync("docs/screenshots/cart_pole");
    const fitnessSamples: FitnessSample[] = evolutionRows.map((r) => ({
      generation: r.generation,
      bestFitness: r.bestFitness,
      avgFitness: r.meanFitness,
    }));
    const fitnessSvg = renderFitnessChartSVG(fitnessSamples, {
      title: "Cart-Pole — Fitness vs Generation",
      bestLabel: "best fitness",
      avgLabel: "mean fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`📈 Wrote fitness chart ${FITNESS_SVG_PATH}`);

    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, renderTopologyChartSvg(evolutionRows));
    console.log(`📐 Wrote topology chart ${TOPOLOGY_SVG_PATH}`);
  }

  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Cart-Pole — Evolution Progress",
      caption: {
        finalScore: result.bestScore,
        totalGenerations: result.generations,
        wallClockMs: Date.now() - evolutionStart,
      },
    });
    await Deno.writeTextFile(EVOLUTION_PROGRESS_SVG_PATH, progressionSvg);
    console.log(
      `🧬 Wrote evolution-progression strip ${EVOLUTION_PROGRESS_SVG_PATH} ` +
        `(${snapshots.length} panels)`,
    );
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
