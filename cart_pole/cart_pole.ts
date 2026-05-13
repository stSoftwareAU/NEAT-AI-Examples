/**
 * Cart-Pole Balancing Example
 *
 * Evolves a NEAT-AI creature to balance an inverted pole on a moving
 * cart — the classic neuroevolution control benchmark. The physics
 * simulator (see `physics.ts`) is pure TypeScript. The evolutionary
 * loop is driven entirely by NEAT-AI's class-shaped
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
 *
 * 📈 **Progress is reported as milestone statistics.** Per issue #298
 * NEAT-AI surfaces only milestone-cadence telemetry (`evolverl_milestone`
 * events at generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then
 * powers of ten). This example collects the milestone payloads emitted
 * by `Creature.evolveRL()` and renders them via
 * `renderMilestoneChartSVG` — no per-generation handler is registered.
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
  /** Half-width of the uniform `[-m, +m]` perturbation. Default 0. */
  initialPerturbation?: number;
  /** Wobble disturbance magnitude (newtons). Default `0`. */
  disturbanceMagnitude?: number;
  /** Wobble disturbance probability `[0, 1]`. Default `0`. */
  disturbanceProbability?: number;
  /** Deterministic disturbance PRNG seed. */
  disturbanceSeed?: number;
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
  /**
   * Milestone payloads collected via `evolveRL`'s `statistics: true`
   * option, surfaced in the schedule documented by
   * {@link MilestoneSample}. Per issue #298 this is the only telemetry
   * channel NEAT-AI exposes — see {@link MILESTONE_SVG_PATH} for the
   * rendered chart.
   */
  milestones: MilestoneSample[];
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

/**
 * Convert an `EvolveRLMilestone` from the library into the
 * {@link MilestoneSample} shape consumed by
 * `renderMilestoneChartSVG`. Both interfaces are structurally
 * identical, but pinning the conversion keeps consumers from leaking
 * the upstream type onto their own surfaces.
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

/**
 * Run NEAT-AI's first-class reinforcement-learning evolution loop
 * against a {@link CartPoleAdapter}. Mutation, crossover, elitism,
 * plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #236).
 *
 * Telemetry is collected via NEAT-AI's `statistics: true` option, which
 * surfaces an `EvolveRLMilestone[]` array on the run summary covering
 * generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then powers
 * of ten. Per issue #298 the example registers **no `onTrainingEvent`
 * handler** — milestone statistics are the only telemetry channel
 * NEAT-AI exposes.
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

  // When `seedCreatureExport` is supplied (multi-run resume), build the
  // seed via `Creature.fromJSON` so the prior champion's topology and
  // weights carry forward. Otherwise fall back to the uniform-random
  // minimal genome — the standard noise → competent seeding for a fresh
  // run.
  const seedCreature = options.seedCreatureExport !== undefined
    ? Creature.fromJSON(options.seedCreatureExport)
    : new Creature(INPUT_COUNT, OUTPUT_COUNT);

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
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;

  const milestones: MilestoneSample[] = (result.milestones ?? []).map(toMilestoneSample);

  // The champion's `bestScore` mirrors evolveRL's own assessment so
  // that "the champion solved the task" agrees with `result.error <=
  // targetError`. The error is normalised: `error = 1 - meanSteps /
  // MAX_STEPS`, so `meanSteps = MAX_STEPS * (1 - error)`. Held-out
  // generalisation is exercised separately by callers re-running
  // `scoreController()` on a different seed set.
  const finalScore = MAX_STEPS * (1 - Math.max(0, Math.min(1, result.error)));

  const targetScore = MAX_STEPS * (1 - absoluteTargetError);
  const targetMet = finalScore >= targetScore;

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
    generations: result.generation,
    solved: targetMet,
    wallclockMs,
    stopReason,
    milestones,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/cart_pole.svg";

/** Number of evenly-spaced keyframes sampled for the SMIL-animated SVG. */
export const SVG_FRAME_COUNT = 60;

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "cart_pole";

/**
 * Path to the multi-run error-curve chart the runner emits — error vs
 * cumulative generation across every run, with faint run-boundary guide
 * lines. Replaces the legacy single-run milestone chart (issue #321).
 */
export const MULTI_RUN_ERROR_SVG_PATH = "docs/screenshots/cart_pole/milestones.svg";

/**
 * Path to the multi-run complexity chart the runner emits — neurons +
 * synapses vs cumulative generation across every run.
 */
export const MULTI_RUN_COMPLEXITY_SVG_PATH = "docs/screenshots/cart_pole/complexity.svg";

/**
 * Default `targetError` for a multi-run invocation. Matches the
 * historical cart-pole convention — `0.04` corresponds to the canonical
 * `SOLVED_THRESHOLD = 480` mean-step target (issue #321).
 */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = 1 - SOLVED_THRESHOLD / MAX_STEPS;

/**
 * Default wall-clock budget for a single multi-run invocation, in
 * minutes. Five minutes matches the audit-mandated stop condition
 * (audit issue #220) and the issue #321 default.
 */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/** Options accepted by {@link runMultiRunCartPole}. */
export interface RunMultiRunCartPoleOptions {
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
 * Convert a cart-pole `EvolveRLMilestone` into a {@link NewMultiRunSample}.
 *
 * `EvolveRLMilestone.bestScore` is the per-episode mean cumulative reward
 * reported by NEAT-AI's RL fitness, which for the cart-pole adapter sits
 * in `[-1, 0]` (the adapter emits a terminal reward
 * `-(MAX_STEPS - stepIdx) / MAX_STEPS` and zero otherwise, so cumulative
 * reward equals `-(1 - stepsSurvived / MAX_STEPS)`). NEAT-AI's
 * `defaultRewardToError` maps that to `error = max(0, -reward)`, so the
 * normalised error for the multi-run chart is `error = -bestScore`,
 * clamped defensively into `[0, 1]`.
 */
export function milestoneToMultiRunSample(m: EvolveRLMilestone): NewMultiRunSample {
  const error = Math.max(0, Math.min(1, -m.bestScore));
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
export async function runMultiRunCartPole(
  options: RunMultiRunCartPoleOptions = {},
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

  const evolveResult = await evolveCartPoleController(evolveOptions);

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
      title: "Cart-Pole — multi-run error vs cumulative generations",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

    const complexitySvg = renderMultiRunComplexityChartSVG(merged.milestones, {
      title: "Cart-Pole — multi-run creature complexity",
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

  console.log("🎢 Cart-Pole Balancing Example (multi-run)");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-cart-pole");

  // CI/quality quick mode (mirrors the maze MAZE_QUICK=1 idiom). When the
  // runner is invoked with `CART_POLE_QUICK=1` the multi-run state and
  // chart SVGs are written under a temp directory so the canonical docs
  // artefacts checked into the repo are never overwritten by a CI run,
  // and `iterations: 3` forces the evolutionary loop to exit via the
  // generation cap well inside `quality.sh`'s per-section budget.
  const quick = Deno.env.get("CART_POLE_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "cart_pole_quick_" });
    console.log(
      "⚡ Quick mode (CART_POLE_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

  console.log("🧪 Sanity check: hand-crafted tilt-direction policy");
  const sanityScore = scoreTiltDirectionPolicy();
  console.log(`   Hand-crafted policy survived ${sanityScore} steps.`);

  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
  }
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  console.log("\n🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${targetError.toFixed(3)} ` +
      `(target score ≥ ${(MAX_STEPS * (1 - targetError)).toFixed(0)}), ` +
      `timeoutMinutes=${timeoutMinutes}` +
      (quick ? ", iterations=3 (quick mode)" : ""),
  );

  const multi = await runMultiRunCartPole({
    baseDir: quickBaseDir,
    evolveOverrides: quick ? { iterations: 3 } : undefined,
  });
  const { evolveResult: result } = multi;

  if (multi.resumed) {
    console.log(`🔁 Resumed from prior champion (run ${multi.runIndex}).`);
  } else {
    console.log(`🌱 Fresh start — run ${multi.runIndex} begins from random noise.`);
  }

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations (best=${result.bestScore.toFixed(1)}, ` +
      `threshold=${SOLVED_THRESHOLD}, stop=${result.stopReason}, ` +
      `wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // The champion creature is persisted by `runMultiRunCartPole` under
  // `docs/data/cart_pole/creature.json`. Also drop a copy under the
  // example's working directory for ad-hoc inspection.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the SVG strip showing the champion balancing. Quick mode
  // keeps this under the temp directory so a CI invocation never
  // overwrites the canonical docs screenshot.
  const trace = replayController(result.champion, MAX_STEPS, {
    disturbanceMagnitude: DEFAULT_EVOLVE_OPTIONS.disturbanceMagnitude,
    disturbanceProbability: DEFAULT_EVOLVE_OPTIONS.disturbanceProbability,
    disturbanceSeed: DEFAULT_EVOLVE_OPTIONS.disturbanceSeed,
  });
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(join(tmpScreenshots, "cart_pole.svg"), svg);
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
