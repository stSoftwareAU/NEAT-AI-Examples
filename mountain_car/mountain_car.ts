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
import { type MilestoneSample, renderMilestoneChartSVG } from "../common/milestone_chart.ts";
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
   * channel NEAT-AI exposes — see {@link MILESTONE_SVG_PATH} for the
   * rendered chart.
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

  const seedCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);

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

/**
 * Path to the milestone-statistics chart the runner emits — this is the
 * canonical fitness-progression artefact under the milestone-only
 * telemetry policy (issue #298). Replaces the legacy
 * `mountain_car_evolution.svg`, `mountain_car/evolution.svg`,
 * `mountain_car/fitness.svg`, and `mountain_car/topology.svg`
 * artefacts that the per-generation snapshot pipeline used to emit.
 */
export const MILESTONE_SVG_PATH = "docs/screenshots/mountain_car_milestones.svg";

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

  const result = await evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);

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

  if (result.milestones.length > 0) {
    const milestoneSvg = renderMilestoneChartSVG(result.milestones, {
      title: "Mountain Car — evolveRL Milestones",
      logX: true,
      caption: true,
    });
    await Deno.writeTextFile(MILESTONE_SVG_PATH, milestoneSvg);
    console.log(
      `📈 Wrote milestone chart ${MILESTONE_SVG_PATH} ` +
        `(${result.milestones.length} milestones)`,
    );
  } else {
    console.log(
      "⚠️  No milestones returned by evolveRL — run did not reach the first " +
        "milestone generation. Skipping milestone chart.",
    );
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
