/**
 * Mountain Car Control Example
 *
 * Evolves a NEAT-AI creature to drive an under-powered car up a
 * sinusoidal hill — the second canonical OpenAI Gym RL benchmark. The
 * car's engine cannot push it directly up the slope, so the controller
 * must learn to swing back-and-forth across the valley to build
 * momentum. The physics simulator (see `physics.ts`) is pure
 * TypeScript. The evolutionary loop is now driven entirely by
 * NEAT-AI's class-shaped `Creature.evolveRL()` API (issue #237,
 * depends on `stSoftwareAU/NEAT-AI#2630` and library version `5.0.0`).
 *
 * Inputs (per timestep): `[x, v]`.
 * Outputs (3 channels): `[push-left, no-push, push-right]`. The argmax
 * over the three outputs selects the action `{-1, 0, +1}`.
 * Score: the **summit rate** — the fraction of perturbed-start trials
 * that crest the goal flag — is what evolution selects on under the
 * new reward shaping. The task is "solved" when the summit rate
 * reaches {@link SOLVED_THRESHOLD} on the per-generation seed set.
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
  encodeState,
  initialState,
  isSuccess,
  MAX_EPISODE_STEPS,
  type MountainCarState,
  perturbedInitialState,
  step,
} from "./physics.ts";
import { renderRunSVG } from "./svg.ts";

/** Number of inputs the controller observes (x, v). */
export const INPUT_COUNT = 2;

/** Number of action outputs (push-left, no-push, push-right). */
export const OUTPUT_COUNT = 3;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = MAX_EPISODE_STEPS;

/** Mountain-car action — `-1` push left, `0` coast, `+1` push right. */
export type MountainCarAction = -1 | 0 | 1;

/** Bonus added to the score when the car reaches the goal flag. */
export const SUCCESS_BONUS = 1000;

/** Scale of the per-step penalty (normalised by `MAX_STEPS`). */
export const STEP_PENALTY_SCALE = SUCCESS_BONUS;

/**
 * Score for an unsuccessful trial (timeout). We penalise distance from
 * the goal so a car that reaches a higher peak still ranks above one
 * that never leaves the valley — even when neither succeeds.
 */
export const FAILURE_FLAT_PENALTY = -100;

/**
 * Summit-reached fraction at or above which the controller is declared
 * "solved" — the champion must crest the flag on at least 80% of the
 * perturbed-start trial batch within the step cap. Equivalent to the
 * default `targetError = 0.2` (target rate = `1 - targetError`).
 */
export const SOLVED_THRESHOLD = 0.8;

/** Configuration options for {@link evolveMountainCarController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /**
   * NEAT-AI standard target-error stop condition. Evolution halts as
   * soon as the champion's summit rate on the perturbed-start trial
   * batch reaches `1 - targetError` (default `0.2`, i.e. summit-rate ≥
   * 80% — matches {@link SOLVED_THRESHOLD}). Forwarded verbatim to
   * `EvolveRLOptions.targetError` — the {@link MountainCarAdapter}'s
   * reward shaping makes the mean error exactly `1 - summitRate`.
   */
  targetError: number;
  /**
   * NEAT-AI standard wall-clock stop condition. Evolution halts when
   * the elapsed time since the loop began exceeds `timeoutMinutes`
   * minutes (default `5`). Whichever of `targetError` and
   * `timeoutMinutes` fires first wins. NEAT-AI 5.0.0 requires this to
   * be an integer ≥ 1, so sub-minute backstops are no longer
   * expressible — use {@link iterations} for fast unit tests.
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
   * to NEAT-AI's `mutationRate` for backwards compatibility — NEAT-AI
   * 5.0.0 owns mutation magnitude internally.
   */
  mutationStrength: number;
  /** Probability that any given gene is perturbed each generation. */
  mutationRate: number;
  /**
   * Per-creature probability of receiving an add-neuron structural
   * mutation. Kept on the public API for backwards compatibility but
   * is no longer used directly — NEAT-AI owns mutation policy under
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
   * Half-width of the uniform position perturbation applied to each
   * trial's starting `x`. Defaults to `0`, i.e. every trial starts from
   * the canonical `(-0.5, 0)` state.
   */
  initialPerturbation?: number;
  /**
   * Seed for sampling the per-evaluation initial-state perturbations.
   * No longer applied directly — NEAT-AI rotates a per-generation seed
   * set derived from `EvolveRLOptions.seed`. Retained on the public API
   * for backwards compatibility.
   */
  trialSeed?: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, a snapshot of the
   * seed creature is captured if generation `1` is a checkpoint, and a
   * snapshot of the final champion is captured at the final generation
   * (always, so the multi-panel SVG has a closing frame). Mid-run
   * intermediate generations are no longer captured because
   * `Creature.evolveRL()` does not expose mid-run creature exports.
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
  /**
   * Half-width of the position perturbation applied to every trial's
   * initial state. Default 0 (no perturbation — every trial starts from
   * the canonical valley centre).
   */
  initialPerturbation?: number;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
  /** Summit-reached fraction of the generation's best creature. */
  bestSummitRate: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best mean per-trial score reached by the champion. */
  bestScore: number;
  /** Champion's summit-reached fraction across the trial batch. */
  summitRate: number;
  /** Number of generations actually run. */
  generations: number;
  /** True when the champion's summit rate met {@link SOLVED_THRESHOLD}. */
  solved: boolean;
  /** Wall-clock duration of the evolution loop in milliseconds. */
  wallclockMs: number;
  /**
   * Why the evolution loop terminated:
   * - `"target"` — the champion reached `1 - targetError` summit rate.
   * - `"timeout"` — `timeoutMinutes` elapsed before the target fired.
   * - `"iterations"` — the optional generation cap was hit first.
   */
  stopReason: "target" | "timeout" | "iterations";
}

/**
 * Sensible defaults for the demonstration runner.
 *
 * - `targetError = 0.2` makes the target summit rate `1 - 0.2 = 80%`,
 *   matching {@link SOLVED_THRESHOLD}.
 * - `timeoutMinutes = 5` is the audit-mandated wall-clock backstop.
 */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 40,
  targetError: 0.2,
  timeoutMinutes: 5,
  mutationStrength: 0.6,
  mutationRate: 0.5,
  // Retained for backwards compatibility — NEAT-AI owns structural
  // mutation under evolveRL().
  addNeuronRate: 0.03,
  // Score every candidate against five different perturbed starts (the
  // same five for every member, every generation under the legacy
  // adapter; NEAT-AI's `episodesPerCreature` rotates seeds per
  // generation in the new loop) so the search cannot "win" by getting
  // lucky on the canonical symmetric launch. The 0.05 half-width keeps
  // every start inside the valley bowl.
  trials: 5,
  initialPerturbation: 0.05,
  trialSeed: 24680,
};

/** Adapter configuration consumed by {@link MountainCarAdapter}. */
export interface MountainCarAdapterOptions {
  /** Half-width of the uniform `[-m, +m]` perturbation. Default `0`. */
  initialPerturbation?: number;
  /** Cap on the number of physics ticks per episode. Default {@link MAX_STEPS}. */
  maxStepsPerEpisode?: number;
}

/** State threaded through each episode by {@link MountainCarAdapter}. */
export interface MountainCarEpisodeState {
  /** Current physics state. */
  physics: MountainCarState;
  /** 1-based step index of the just-completed step (`0` after `reset`). */
  stepIdx: number;
}

/**
 * Mountain-car episode adapter for `Creature.evolveRL()`. Each `step()`
 * advances the deterministic physics simulator, encodes the observation
 * as a `Float32Array`, and emits a reward that maps directly onto
 * NEAT-AI's non-negative `error` slot via `defaultRewardToError`
 * (`error = max(0, -reward)`):
 *
 * - Non-terminal step: reward `0`.
 * - Summit reached (`isSuccess(state)`): `terminated = true`, reward
 *   `0`. Cumulative episode reward = `0` → `error = 0`.
 * - Step cap reached without summit: `terminated = true`, reward `-1`.
 *   Cumulative episode reward = `-1` → `error = 1`.
 *
 * Across `episodesPerCreature` trials the mean cumulative reward is
 * therefore `-(1 - summitRate)`, so `EvolveRLOptions.targetError = 0.2`
 * stops evolution as soon as the champion's summit rate reaches
 * `1 - 0.2 = 0.8 =` {@link SOLVED_THRESHOLD} across the per-generation
 * seed set.
 */
export class MountainCarAdapter extends EpisodeAdapter<MountainCarEpisodeState, MountainCarAction> {
  /** Half-width of the per-component initial-state perturbation. */
  readonly initialPerturbation: number;
  /** Per-episode step cap. */
  readonly maxStepsPerEpisode: number;

  constructor(options: MountainCarAdapterOptions = {}) {
    super();
    this.initialPerturbation = options.initialPerturbation ?? 0;
    this.maxStepsPerEpisode = options.maxStepsPerEpisode ?? MAX_STEPS;
  }

  override get observationLength(): number {
    return INPUT_COUNT;
  }

  override maxSteps(): number {
    return this.maxStepsPerEpisode;
  }

  override reset(
    rngSeed: number,
  ): { observation: Float32Array; state: MountainCarEpisodeState } {
    const initRng = createDeterministicRandom(rngSeed >>> 0);
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
    _state: MountainCarEpisodeState,
  ): MountainCarAction {
    return decodeAction(creatureOutput);
  }

  override step(
    state: MountainCarEpisodeState,
    action: MountainCarAction,
  ): StepResult<Float32Array> & { state: MountainCarEpisodeState } {
    const newPhysics = step(state.physics, action);
    const newStepIdx = state.stepIdx + 1;
    const summited = isSuccess(newPhysics);
    const timedOut = !summited && newStepIdx >= this.maxStepsPerEpisode;
    // Summit: reward 0 (cumulative 0 → error 0 → counted as "solved").
    // Timeout: reward -1 (cumulative -1 → error 1 → counted as failed).
    // Otherwise: reward 0 and continue.
    const reward = timedOut ? -1 : 0;
    const terminated = summited || timedOut;
    return {
      state: { physics: newPhysics, stepIdx: newStepIdx },
      observation: encodeState(newPhysics),
      reward,
      terminated,
      truncated: false,
    };
  }
}

/**
 * Convert the creature's three outputs into a discrete action by argmax:
 * index 0 → push left (-1), 1 → coast (0), 2 → push right (+1). Ties
 * favour lower indices (left / coast) which is irrelevant for the
 * evolutionary search but keeps the mapping deterministic.
 */
export function decodeAction(outputs: ArrayLike<number>): MountainCarAction {
  let bestIdx = 0;
  let best = outputs[0];
  for (let i = 1; i < OUTPUT_COUNT; i++) {
    if (outputs[i] > best) {
      best = outputs[i];
      bestIdx = i;
    }
  }
  return (bestIdx - 1) as MountainCarAction;
}

/** Result of running a single episode. */
interface EpisodeResult {
  score: number;
  steps: number;
  solved: boolean;
  finalState: MountainCarState;
}

/** Build a mountain-car {@link LocalEpisodeAdapter} for the shared rollout helper. */
function mountainCarLocalAdapter(
  start: MountainCarState,
): LocalEpisodeAdapter<MountainCarState, MountainCarAction> {
  return {
    initialState: start,
    encode: encodeState,
    decode: decodeAction,
    step,
    isTerminal: isSuccess,
  };
}

/**
 * Run a single mountain-car episode from `start` and return the score
 * components. Wraps the shared {@link runEpisode} helper with the
 * mountain-car-specific reward shaping (success bonus minus a per-step
 * penalty for solved trials, partial credit for the highest peak
 * reached on timeouts). Used by the legacy {@link scoreController}
 * path that tests and the post-evolution replay still consume.
 */
function runMountainCarEpisode(
  creature: Creature,
  start: MountainCarState,
  maxSteps: number,
): EpisodeResult {
  const { trace, finalState, steps } = runEpisode(creature, mountainCarLocalAdapter(start), {
    maxSteps,
  });
  const solved = isSuccess(finalState);
  if (solved) {
    const score = SUCCESS_BONUS - (STEP_PENALTY_SCALE * steps) / maxSteps;
    return { score, steps, solved: true, finalState };
  }
  // Timeout: scale [-1.2, 0.5] → [0, 1] for the partial-credit term.
  let highestX = start.x;
  for (const s of trace) {
    if (s.x > highestX) highestX = s.x;
  }
  const partial = (highestX + 1.2) / (0.5 + 1.2);
  const score = FAILURE_FLAT_PENALTY + 50 * partial;
  return { score, steps: maxSteps, solved: false, finalState };
}

/** Aggregated multi-trial score for a single creature. */
export interface ControllerScore {
  /** Mean per-trial score (used for evolution selection). */
  score: number;
  /** Fraction of trials that crested the goal flag, in `[0, 1]`. */
  summitRate: number;
  /** Number of trials that contributed to the score. */
  trials: number;
}

/**
 * Score a creature by running the simulator across a fixed batch of
 * perturbed starts. The returned `score` is the mean per-trial score —
 * the legacy fitness signal — and `summitRate` is the fraction of
 * trials that actually reached the goal flag. Identical inputs always
 * produce identical scores (the trial PRNG is seeded by
 * `options.trialSeed`). Used by tests and the post-evolution replay
 * path; evolution itself now selects on `summitRate` through
 * {@link MountainCarAdapter}'s normalised rewards.
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  options?: ScoreOptions,
): ControllerScore {
  const trials = options?.trials ?? 1;
  const perturbation = options?.initialPerturbation ?? 0;

  if (trials <= 1 && perturbation === 0) {
    const result = runMountainCarEpisode(creature, initialState(), maxSteps);
    return {
      score: result.score,
      summitRate: result.solved ? 1 : 0,
      trials: 1,
    };
  }

  const random = createDeterministicRandom(options?.trialSeed ?? 0);
  let total = 0;
  let solved = 0;
  for (let t = 0; t < trials; t++) {
    const start = perturbation > 0 ? perturbedInitialState(random, perturbation) : initialState();
    const result = runMountainCarEpisode(creature, start, maxSteps);
    total += result.score;
    if (result.solved) solved++;
  }
  return { score: total / trials, summitRate: solved / trials, trials };
}

/**
 * Replay a creature's run from the canonical valley-centre start,
 * recording the state at every timestep up to and including the success
 * step (or until `MAX_STEPS`).
 */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): MountainCarState[] {
  return runEpisode(creature, mountainCarLocalAdapter(initialState()), { maxSteps }).trace;
}

/**
 * Score the canonical hand-crafted swing-up policy: push in the
 * direction of current velocity (`+1` when `v >= 0`, otherwise `-1`).
 * Used as a sanity baseline that the simulator is solvable.
 */
export function scoreSwingUpPolicy(maxSteps: number = MAX_STEPS): {
  score: number;
  steps: number;
  solved: boolean;
} {
  let state: MountainCarState = initialState();
  let highestX = state.x;
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    const action = state.v >= 0 ? 1 : -1;
    state = step(state, action);
    if (state.x > highestX) highestX = state.x;
    if (isSuccess(state)) {
      const steps = stepIdx + 1;
      const score = SUCCESS_BONUS - (STEP_PENALTY_SCALE * steps) / maxSteps;
      return { score, steps, solved: true };
    }
  }
  const partial = (highestX + 1.2) / (0.5 + 1.2);
  const score = FAILURE_FLAT_PENALTY + 50 * partial;
  return { score, steps: maxSteps, solved: false };
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
 * against a {@link MountainCarAdapter}. Mutation, crossover, elitism,
 * plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #237).
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
export async function evolveMountainCarController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const adapter = new MountainCarAdapter({
    initialPerturbation: options.initialPerturbation,
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
  let bestSummitRateSeen = 0;
  let lastObservedGeneration = 0;

  // EvolveRL normalised target error — the adapter emits cumulative
  // episode rewards in `{-1, 0}`, so `defaultRewardToError` produces
  // an error of `1 - summitRate`. The caller's `targetError` already
  // lives in that range, so it passes through unchanged. Negative
  // values (used by tests to force the wall-clock / iterations
  // backstop) are clamped to `0`, the smallest legal value.
  const absoluteTargetError = Math.max(0, options.targetError);

  const loopStart = Date.now();

  const evolveOptions: EvolveRLOptions = {
    seed: options.seed >>> 0,
    populationSize: options.populationSize,
    mutationRate: options.mutationRate,
    targetError: absoluteTargetError,
    timeoutMinutes: options.timeoutMinutes,
    iterations: options.iterations,
    episodesPerCreature: options.trials ?? 1,
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
      let bestSummitRateGen: number;
      let meanSummitRateGen: number;
      let neurons: number;
      let synapses: number;
      if (bucket && bucket.meanRewards.length > 0) {
        const sum = bucket.meanRewards.reduce((a, b) => a + b, 0);
        const meanReward = sum / bucket.meanRewards.length;
        // Cumulative reward in `[-1, 0]` maps to summit rate via
        // `summitRate = 1 + reward`.
        meanSummitRateGen = clamp01(1 + meanReward);
        bestSummitRateGen = clamp01(1 + bucket.bestReward);
        neurons = bucket.bestNeurons;
        synapses = bucket.bestSynapses;
      } else {
        meanSummitRateGen = bestSummitRateSeen;
        bestSummitRateGen = bestSummitRateSeen;
        neurons = latestBestNeurons;
        synapses = latestBestSynapses;
      }
      if (bestSummitRateGen > bestSummitRateSeen) {
        bestSummitRateSeen = bestSummitRateGen;
      }
      options.onGeneration?.({
        generation: generation0,
        // Surface the score as `SUCCESS_BONUS * summitRate` so the
        // numeric range matches the historical contract (charts, CSV
        // exporters, console output).
        bestScore: SUCCESS_BONUS * bestSummitRateGen,
        meanScore: SUCCESS_BONUS * meanSummitRateGen,
        bestSummitRate: bestSummitRateGen,
        neurons,
        synapses,
      });
    },
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;
  const finalGeneration = Math.max(lastObservedGeneration, result.generation);

  // The champion's summit rate mirrors evolveRL's own assessment so
  // that "the champion solved the task" agrees with `result.error <=
  // targetError`. `error = 1 - summitRate` so `summitRate = 1 - error`.
  const finalSummitRate = clamp01(1 - Math.max(0, Math.min(1, result.error)));
  if (finalSummitRate > bestSummitRateSeen) bestSummitRateSeen = finalSummitRate;
  const finalScore = SUCCESS_BONUS * finalSummitRate;

  // Always capture the final champion at the final generation so the
  // multi-panel SVG has a closing frame.
  if (options.snapshotConfig) {
    const checkpoints = options.snapshotConfig.checkpoints.includes(finalGeneration)
      ? options.snapshotConfig.checkpoints
      : [finalGeneration];
    captureSnapshot(
      { ...options.snapshotConfig, checkpoints },
      finalGeneration,
      seedCreature.exportJSON(),
      finalScore,
    );
  }

  const targetSummitRate = 1 - absoluteTargetError;
  const targetMet = finalSummitRate >= targetSummitRate;

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
    summitRate: finalSummitRate,
    generations: finalGeneration,
    solved: targetMet,
    wallclockMs,
    stopReason,
  };
}

/** Clamp a value to `[0, 1]`. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mountain_car.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/mountain_car/evolution.svg";

/**
 * Generations at which the runner captures evolution snapshots. The
 * cadence is appropriate to variable-topology evolution from
 * uniform-random noise — the early gens show pure noise, the middle
 * milestones show structure emerging, and the final captured panel
 * shows the swing-up controller cresting the flag.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 50, 150, 300];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-mountain-car/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/mountain_car_evolution.svg";

/** Path to the per-generation evolution telemetry CSV (audit issue #221). */
export const EVOLUTION_CSV_PATH = "docs/data/mountain_car/evolution.csv";

/** Header row for the per-generation telemetry CSV (audit issue #221). */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path (audit issue #221). */
export const FITNESS_SVG_PATH = "docs/screenshots/mountain_car/fitness.svg";

/** Neuron / synapse count chart path (audit issue #221). */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/mountain_car/topology.svg";

/**
 * One row of per-generation evolution telemetry. Captured during a run
 * and serialised to {@link EVOLUTION_CSV_PATH} so downstream tools can
 * inspect how the population's fitness and topology evolved over time.
 */
export interface EvolutionRow {
  /** Zero-based generation index. */
  generation: number;
  /** Best per-trial-mean fitness in this generation. */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /** Neuron count of this generation's champion creature. */
  neuronCount: number;
  /** Synapse count of this generation's champion creature. */
  synapseCount: number;
}

/**
 * Format a finite number with up to six decimal places, trimming trailing
 * zeros so deterministic inputs produce a single canonical string.
 * Non-finite values become "0" — the CSV must not leak NaN/Infinity.
 */
function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/**
 * Format an evolution-telemetry table into a CSV string with the exact
 * {@link EVOLUTION_CSV_HEADER} header. Numeric fields use a fixed
 * representation so the file is byte-deterministic for identical inputs.
 */
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
// Pairs with the shared `renderFitnessChartSVG` from `common/fitness_chart.ts`
// — together the two SVGs satisfy the "neuron/synapse" + "best/mean
// fitness" charts requested by audit issue #221.

const TOPOLOGY_SVG_WIDTH = 720;
const TOPOLOGY_SVG_HEIGHT = 320;
const TOPOLOGY_MARGIN = { top: 36, right: 70, bottom: 44, left: 60 };

/**
 * Render the neuron / synapse count chart for the README. Two lines
 * share an X axis; the right Y axis shows synapse counts on a separate
 * scale so the synapse line does not compress the neuron line into
 * invisibility. Throws if `rows` is empty.
 */
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
    `aria-label="Mountain Car — neuron and synapse counts per generation">`,
    `  <title>Mountain Car — Topology Growth</title>`,
    `  <rect width="${TOPOLOGY_SVG_WIDTH}" height="${TOPOLOGY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TOPOLOGY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Mountain Car — Topology Growth</text>`,
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

  console.log("🚗 Mountain Car Control Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-mountain-car");

  console.log("🧪 Sanity check: hand-crafted swing-up policy");
  const sanity = scoreSwingUpPolicy();
  console.log(
    `   Swing-up policy ${sanity.solved ? "SOLVED" : "did not solve"} in ${sanity.steps} steps ` +
      `(score=${sanity.score.toFixed(2)}).`,
  );

  console.log("\n🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${DEFAULT_EVOLVE_OPTIONS.targetError} ` +
      `(summit-rate ≥ ${((1 - DEFAULT_EVOLVE_OPTIONS.targetError) * 100).toFixed(0)}%), ` +
      `timeoutMinutes=${DEFAULT_EVOLVE_OPTIONS.timeoutMinutes}`,
  );
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionRows: EvolutionRow[] = [];
  const evolutionStart = Date.now();
  const result = await evolveMountainCarController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestScore, meanScore, bestSummitRate, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      evolutionRows.push({
        generation,
        bestFitness: bestScore,
        meanFitness: meanScore,
        neuronCount: neurons,
        synapseCount: synapses,
      });
      if (generation % 10 === 0 || bestSummitRate >= SOLVED_THRESHOLD) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  best=${
            bestScore.toFixed(1).padStart(8)
          }  mean=${meanScore.toFixed(1).padStart(8)}  ` +
            `summit=${(bestSummitRate * 100).toFixed(0).padStart(3)}%  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} ${result.solved ? "Solved" : "Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(summit=${(result.summitRate * 100).toFixed(0)}%, ` +
      `score=${result.bestScore.toFixed(2)}, threshold=${SOLVED_THRESHOLD * 100}%, ` +
      `stop=${result.stopReason}, wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the animated SVG showing the champion's drive up the hill.
  const trace = replayController(result.champion);
  const svg = renderRunSVG(trace);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Mountain Car — Evolution",
      scoreLabel: "best score",
    });
    ensureDirSync("docs/screenshots/mountain_car");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Per-generation evolution telemetry (audit issue #221): CSV (source
  // of truth) + best/mean fitness chart + neuron/synapse topology chart.
  if (evolutionRows.length > 0) {
    ensureDirSync("docs/data/mountain_car");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(evolutionRows));
    console.log(`🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${evolutionRows.length} rows)`);

    ensureDirSync("docs/screenshots/mountain_car");
    const fitnessSamples: FitnessSample[] = evolutionRows.map((r) => ({
      generation: r.generation,
      bestFitness: r.bestFitness,
      avgFitness: r.meanFitness,
    }));
    const fitnessSvg = renderFitnessChartSVG(fitnessSamples, {
      title: "Mountain Car — Fitness vs Generation",
      bestLabel: "best fitness",
      avgLabel: "mean fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`📈 Wrote fitness chart ${FITNESS_SVG_PATH}`);

    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, renderTopologyChartSvg(evolutionRows));
    console.log(`📐 Wrote topology chart ${TOPOLOGY_SVG_PATH}`);
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Mountain Car — Evolution Progress",
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
