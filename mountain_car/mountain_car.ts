/**
 * Mountain Car Control Example
 *
 * Evolves a NEAT-AI creature to drive an under-powered car up a
 * sinusoidal hill — the second canonical OpenAI Gym RL benchmark. The
 * car's engine cannot push it directly up the slope, so the controller
 * must learn to swing back-and-forth across the valley to build
 * momentum. The physics simulator (see `physics.ts`) is pure
 * TypeScript. The evolutionary loop is driven entirely by NEAT-AI's
 * class-shaped `Creature.evolveRL()` API (issue #290, supersedes #237).
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
 *
 * 📈 **Progress is reported as milestone statistics.** Per issue #298
 * NEAT-AI surfaces only milestone-cadence telemetry (`evolverl_milestone`
 * events at generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then
 * powers of ten). This example collects the milestone payloads emitted
 * by `Creature.evolveRL()` — no per-generation handler is registered.
 *
 * 🔁 **Multi-run persistence (issue #323).** The runner uses the shared
 * `common/multi_run_state.ts` helper to resume evolution across runs:
 * each invocation reloads the previously-saved champion (when present),
 * appends fresh milestones to the merged history, and re-renders the
 * two multi-run chart SVGs. `--fresh` wipes prior state to start over.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  EpisodeAdapter,
  type EvolveRLMilestone,
  type EvolveRLOptions,
  safeWriteJson,
  type StepResult,
} from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type MilestoneSample } from "../common/milestone_chart.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  type NewMultiRunSample,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import { renderMultiRunErrorChartSVG } from "../common/multi_run_error_chart.ts";
import { renderMultiRunComplexityChartSVG } from "../common/multi_run_complexity_chart.ts";
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
   * Standard deviation of the weight/bias perturbation noise. Retained
   * on the public API for backwards compatibility — NEAT-AI 5.0.0 owns
   * mutation magnitude internally and ignores this value.
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
   * scored on (mean across trials). Defaults to `5`. Maps to
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
  /**
   * Optional pre-seeded creature export, used by the multi-run resume
   * flow to continue evolution from a prior champion. When supplied, the
   * evolveRL seed is built via {@link Creature.fromJSON} instead of the
   * uniform-random `new Creature(INPUT_COUNT, OUTPUT_COUNT)`. When absent
   * the first generation starts from random noise (the default for a
   * `--fresh` run).
   */
  seedCreatureExport?: CreatureExport;
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
  /**
   * Milestone payloads collected via `evolveRL`'s `statistics: true`
   * option, surfaced in the schedule documented by
   * {@link MilestoneSample}. Per issue #298 this is the only telemetry
   * channel NEAT-AI exposes — see {@link MULTI_RUN_ERROR_SVG_PATH} and
   * {@link MULTI_RUN_COMPLEXITY_SVG_PATH} for the rendered charts.
   */
  milestones: MilestoneSample[];
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
  // Score every candidate against five different perturbed starts so the
  // search cannot "win" by getting lucky on the canonical symmetric
  // launch. The 0.05 half-width keeps every start inside the valley
  // bowl.
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

/**
 * Convert an `EvolveRLMilestone` from the library into the
 * {@link MilestoneSample} shape kept on {@link EvolveResult}. Both
 * interfaces are structurally identical, but pinning the conversion
 * keeps consumers from leaking the upstream type onto their own
 * surfaces.
 */
function toMilestoneSample(m: EvolveRLMilestone): MilestoneSample {
  return {
    generation: m.generation,
    bestScore: m.bestScore,
    bestNeurons: m.bestNeurons,
    bestSynapses: m.bestSynapses,
    meanEpisodeSteps: m.meanEpisodeSteps,
    generationWallClockMs: m.generationWallClockMs,
  };
}

/** Clamp a value to `[0, 1]`. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Run NEAT-AI's first-class reinforcement-learning evolution loop
 * against a {@link MountainCarAdapter}. Mutation, crossover, elitism,
 * plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #290, supersedes #237).
 *
 * Telemetry is collected via NEAT-AI's `statistics: true` option, which
 * surfaces an `EvolveRLMilestone[]` array on the run summary covering
 * generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then powers
 * of ten. Per issue #298 the example registers **no `onTrainingEvent`
 * handler** — milestone statistics are the only telemetry channel
 * NEAT-AI exposes.
 */
export async function evolveMountainCarController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const adapter = new MountainCarAdapter({
    initialPerturbation: options.initialPerturbation,
    maxStepsPerEpisode: MAX_STEPS,
  });

  // When `seedCreatureExport` is supplied (multi-run resume), build the
  // seed via `Creature.fromJSON` so the prior champion's topology and
  // weights carry forward. Otherwise fall back to the uniform-random
  // minimal genome — the standard noise → competent seeding for a fresh
  // run.
  const seedCreature = options.seedCreatureExport !== undefined
    ? Creature.fromJSON(options.seedCreatureExport)
    : new Creature(INPUT_COUNT, OUTPUT_COUNT);

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
    episodesPerCreature: options.trials ?? 5,
    statistics: true,
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;

  const milestones: MilestoneSample[] = (result.milestones ?? []).map(toMilestoneSample);

  // The champion's summit rate mirrors evolveRL's own assessment so
  // that "the champion solved the task" agrees with `result.error <=
  // targetError`. `error = 1 - summitRate` so `summitRate = 1 - error`.
  const finalSummitRate = clamp01(1 - Math.max(0, Math.min(1, result.error)));
  const finalScore = SUCCESS_BONUS * finalSummitRate;

  const targetSummitRate = 1 - absoluteTargetError;
  const targetMet = finalSummitRate >= targetSummitRate;

  let stopReason: "target" | "timeout" | "iterations";
  if (targetMet) {
    stopReason = "target";
  } else if (
    options.iterations !== undefined && result.generation >= options.iterations
  ) {
    stopReason = "iterations";
  } else {
    stopReason = "timeout";
  }

  return {
    champion: seedCreature,
    bestScore: finalScore,
    summitRate: finalSummitRate,
    generations: result.generation,
    solved: targetMet,
    wallclockMs,
    stopReason,
    milestones,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mountain_car.svg";

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "mountain_car";

/**
 * Path to the multi-run error-curve chart the runner emits — error vs
 * cumulative generation across every run, with faint run-boundary guide
 * lines. Subsumes the legacy single-run milestone chart and the retired
 * per-generation evolution / fitness / topology charts (issue #323,
 * supersedes #290).
 */
export const MULTI_RUN_ERROR_SVG_PATH = "docs/screenshots/mountain_car/milestones.svg";

/**
 * Path to the multi-run complexity chart the runner emits — neurons +
 * synapses vs cumulative generation across every run.
 */
export const MULTI_RUN_COMPLEXITY_SVG_PATH = "docs/screenshots/mountain_car/complexity.svg";

/**
 * Default `targetError` for a multi-run invocation. The issue #323
 * convention is `0.01` so the multi-run flow keeps cresting the bar
 * across resumes; the historical single-run `SOLVED_THRESHOLD = 0.8`
 * (`targetError = 0.2`) is now the in-run halting condition used by the
 * default `DEFAULT_EVOLVE_OPTIONS`.
 */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = 0.01;

/**
 * Default wall-clock budget for a single multi-run invocation, in
 * minutes. Five minutes matches the audit-mandated stop condition
 * (audit issue #221) and the issue #323 default.
 */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/** Options accepted by {@link runMultiRunMountainCar}. */
export interface RunMultiRunMountainCarOptions {
  /** Argv (defaults to `Deno.args`). Recognised flags: `--fresh`,
   * `--timeout=<minutes>`, `--target-error=<value>`. */
  argv?: readonly string[];
  /** Base directory override for the multi-run persistence helpers and
   * chart artefacts (used by tests). Defaults to `docs`. */
  baseDir?: string;
  /** Optional overrides applied to `DEFAULT_EVOLVE_OPTIONS` (used by
   * tests to cap iterations without depending on wall-clock timing). */
  evolveOverrides?: Partial<EvolveOptions>;
}

/** Outcome of a single multi-run invocation. */
export interface MultiRunResult {
  /** The underlying evolveRL result. */
  evolveResult: EvolveResult;
  /** Number of this run within the persisted history (1-based). */
  runIndex: number;
  /** Cumulative generation total *after* this run was appended. */
  lastCumulativeGen: number;
  /** Total number of milestones in the merged history. */
  totalMilestones: number;
  /** `true` when the prior champion was reloaded as the seed creature. */
  resumed: boolean;
}

/**
 * Convert a mountain-car `EvolveRLMilestone` into a
 * {@link NewMultiRunSample}.
 *
 * `EvolveRLMilestone.bestScore` is the per-episode mean cumulative
 * reward reported by NEAT-AI's RL fitness, which for the mountain-car
 * adapter sits in `[-1, 0]` (the adapter emits a terminal reward `-1`
 * on timeout and `0` on summit, so cumulative reward equals
 * `-(1 - summitRate)`). NEAT-AI's `defaultRewardToError` maps that to
 * `error = max(0, -reward)`, so the normalised error for the multi-run
 * chart is `error = -bestScore = 1 - summitRate`, clamped defensively
 * into `[0, 1]`.
 */
export function milestoneToMultiRunSample(m: EvolveRLMilestone): NewMultiRunSample {
  const error = clamp01(-m.bestScore);
  return {
    runGen: m.generation,
    bestScore: m.bestScore,
    error,
    neurons: m.bestNeurons,
    synapses: m.bestSynapses,
    meanEpisodeSteps: m.meanEpisodeSteps,
    generationWallClockMs: m.generationWallClockMs,
  };
}

/**
 * End-to-end multi-run wiring: parses flags, optionally wipes prior
 * state, loads the saved champion (when present) to seed the next run,
 * evolves the controller, appends fresh milestones to the merged
 * history, and renders both multi-run charts.
 *
 * Returns a {@link MultiRunResult} so callers (CLI + tests) can report
 * on the run without re-reading disk.
 */
export async function runMultiRunMountainCar(
  options: RunMultiRunMountainCarOptions = {},
): Promise<MultiRunResult> {
  const argv = options.argv ?? Deno.args;
  const flags = parseMultiRunFlags(argv);
  const slug = EXAMPLE_SLUG;

  if (flags.fresh) {
    await wipeMultiRunState(slug, options.baseDir);
  }

  const state = await loadMultiRunState(slug, options.baseDir);
  const resumed = state.creatureExport !== undefined;

  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  const evolveOptions: EvolveOptions = {
    ...DEFAULT_EVOLVE_OPTIONS,
    timeoutMinutes,
    targetError,
    seedCreatureExport: state.creatureExport,
    ...options.evolveOverrides,
  };

  const evolveResult = await evolveMountainCarController(evolveOptions);

  const newSamples: NewMultiRunSample[] = evolveResult.milestones.map((m) =>
    milestoneToMultiRunSample({
      generation: m.generation,
      bestScore: m.bestScore,
      bestNeurons: m.bestNeurons,
      bestSynapses: m.bestSynapses,
      meanEpisodeSteps: m.meanEpisodeSteps,
      generationWallClockMs: m.generationWallClockMs,
    })
  );

  await appendMultiRunRun(slug, {
    creatureExport: evolveResult.champion.exportJSON(),
    newSamples,
    runIndex: state.nextRunIndex,
    baseCumulativeGen: state.lastCumulativeGen,
  }, options.baseDir);

  const merged = await loadMultiRunState(slug, options.baseDir);

  if (merged.milestones.length > 0) {
    const base = options.baseDir ?? "docs";
    const screenshotsDir = join(base, "screenshots", slug);
    ensureDirSync(screenshotsDir);

    const errorSvg = renderMultiRunErrorChartSVG(merged.milestones, {
      title: "Mountain Car — multi-run error vs cumulative generations",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

    const complexitySvg = renderMultiRunComplexityChartSVG(merged.milestones, {
      title: "Mountain Car — multi-run creature complexity",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "complexity.svg"), complexitySvg);
  }

  return {
    evolveResult,
    runIndex: state.nextRunIndex,
    lastCumulativeGen: merged.lastCumulativeGen,
    totalMilestones: merged.milestones.length,
    resumed,
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🚗 Mountain Car Control Example (multi-run)");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-mountain-car");

  // CI/quality quick mode (mirrors the cart-pole CART_POLE_QUICK=1
  // idiom). When the runner is invoked with `MOUNTAIN_CAR_QUICK=1` the
  // multi-run state and chart SVGs are written under a temp directory so
  // the canonical docs artefacts checked into the repo are never
  // overwritten by a CI run, and `iterations: 3` forces the
  // evolutionary loop to exit via the generation cap well inside
  // `quality.sh`'s per-section budget.
  const quick = Deno.env.get("MOUNTAIN_CAR_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "mountain_car_quick_" });
    console.log(
      "⚡ Quick mode (MOUNTAIN_CAR_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

  console.log("🧪 Sanity check: hand-crafted swing-up policy");
  const sanity = scoreSwingUpPolicy();
  console.log(
    `   Swing-up policy ${sanity.solved ? "SOLVED" : "did not solve"} in ${sanity.steps} steps ` +
      `(score=${sanity.score.toFixed(2)}).`,
  );

  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
  }
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  console.log("\n🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${targetError.toFixed(3)} ` +
      `(summit-rate ≥ ${((1 - targetError) * 100).toFixed(0)}%), ` +
      `timeoutMinutes=${timeoutMinutes}` +
      (quick ? ", iterations=3 (quick mode)" : ""),
  );

  const multi = await runMultiRunMountainCar({
    baseDir: quickBaseDir,
    evolveOverrides: quick ? { iterations: 3 } : undefined,
  });
  const { evolveResult: result } = multi;

  if (multi.resumed) {
    console.log(`🔁 Resumed from prior champion (run ${multi.runIndex}).`);
  } else {
    console.log(`🌱 Fresh start — run ${multi.runIndex} begins from random noise.`);
  }

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} ${result.solved ? "Solved" : "Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(summit=${(result.summitRate * 100).toFixed(0)}%, ` +
      `score=${result.bestScore.toFixed(2)}, threshold=${SOLVED_THRESHOLD * 100}%, ` +
      `stop=${result.stopReason}, wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // The champion creature is persisted by `runMultiRunMountainCar` under
  // `docs/data/mountain_car/creature.json`. Also drop a copy under the
  // example's working directory for ad-hoc inspection.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the animated SVG showing the champion's drive up the hill.
  // Quick mode keeps this under the temp directory so a CI invocation
  // never overwrites the canonical docs screenshot.
  const trace = replayController(result.champion);
  const svg = renderRunSVG(trace);
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(join(tmpScreenshots, "mountain_car.svg"), svg);
    console.log("⏭️  Quick mode: skipped overwriting canonical screenshot");
  } else {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);
  }

  console.log(
    `📈 Multi-run charts updated under ${
      quick ? quickBaseDir : "docs"
    }/screenshots/${EXAMPLE_SLUG}/ — ` +
      `${multi.totalMilestones} cumulative milestones across ${multi.runIndex} run(s).`,
  );

  if (quick && quickBaseDir !== undefined) {
    try {
      await Deno.remove(quickBaseDir, { recursive: true });
    } catch {
      // Tolerable — temp dir cleanup is best-effort.
    }
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
