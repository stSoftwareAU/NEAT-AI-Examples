/**
 * Lunar Lander Descent Example
 *
 * Evolves a NEAT-AI creature to land a simplified 2D lunar lander on a
 * flat pad. The simulator (`physics.ts`) is pure TypeScript; the
 * evolutionary loop is driven entirely by NEAT-AI's class-shaped
 * `Creature.evolveRL()` API (issue #292, supersedes #240).
 *
 * Inputs (per timestep): normalised
 * `[relativeXToPad, y, vx, vy, angle, angularV, fuel]`.
 * Outputs (3, thresholded at 0.5): `[main, left, right]`.
 *
 * 🌱 **Generation 1 starts from random noise.** The seed handed to
 * `Creature.evolveRL()` is a fresh `new Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` — the library's uniform-random minimal genome with
 * direct input → output connections, random weights, and a random
 * output bias. **No hand-crafted topology, no tuned weight init.**
 * Hidden neurons emerge only when NEAT-AI's structural mutation
 * operators (owned by the library) split an existing connection.
 *
 * 📈 **Progress is reported as milestone statistics.** Per issue #298
 * NEAT-AI surfaces only milestone-cadence telemetry (`evolverl_milestone`
 * events at generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then
 * powers of ten). This example collects the milestone payloads emitted
 * by `Creature.evolveRL()` — no `onTrainingEvent` handler is registered.
 *
 * 🔁 **Multi-run persistence (issue #324).** The runner uses the shared
 * `common/multi_run_state.ts` helper to resume evolution across runs:
 * each invocation reloads the previously-saved champion (when present),
 * appends fresh milestones to the merged history, and re-renders the
 * two multi-run chart SVGs. `--fresh` wipes prior state **and** the
 * published validation / descent artefacts so cumulative-generation and
 * wall-clock summaries cannot mix a short new run with an older history.
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
import { renderOutcomeBarChartSVG, type ScenarioOutcome } from "../common/outcome_bar_chart.ts";
import {
  classifyOutcome,
  DEFAULT_PARAMS,
  DEFAULT_START_ALTITUDE,
  DEFAULT_TERRAIN,
  encodeState,
  initialState,
  isTerminal,
  type LanderAction,
  type LanderOutcome,
  type LanderState,
  type LanderTerrain,
  perturbedScenario,
  step,
} from "./physics.ts";
import { renderRunSVG, type TraceFrame } from "./svg.ts";
import {
  DEFAULT_VALIDATION_COUNT,
  generateScenarioPools,
  type SeededScenario,
} from "./scenarios.ts";

/** Number of inputs the controller observes. */
export const INPUT_COUNT = 7;

/** Number of action outputs the controller produces. */
export const OUTPUT_COUNT = 3;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = 400;

/** Scoring constants — tuned so a fuel-rich, pad-centred landing scores >> 0
 *  while free fall crashes far below it. The "flying" timeout penalises
 *  altitude so an indefinite hover does not dominate the reward. */
const SCORE = {
  landed: 1000,
  landedFuelBonus: 5,
  landedAngleCost: 200,
  landedVerticalCost: 30,
  landedHorizontalCost: 30,
  crashedFlat: -200,
  crashedDistanceCost: 5,
  crashedSpeedCost: 3,
  crashedAngleCost: 100,
  outOfBounds: -1500,
  flyingFlat: -50,
  flyingDistanceCost: 2,
  flyingAltitudeCost: 1.0,
} as const;

/**
 * Normalisation upper bounds and weights for {@link gradedTerminalReward}.
 *
 * Each of the four terminal-step signals (distance from pad, impact speed,
 * tilt, spin rate) is divided by the matching upper bound and clamped to
 * `[0, 1]`. The four clamped contributions are combined with the matching
 * weights — which sum to `1` — and negated, so the final reward lives in
 * `[-1, 0]`, then each non-landed outcome is subject to an outcome floor
 * so a soft near miss cannot become equivalent to an actual landing. A
 * perfectly-centred, soft, upright, non-spinning touchdown (the `landed`
 * outcome) is returned as exactly `0` by the caller before the weighted
 * sum ever runs.
 *
 * Upper-bound rationale:
 *
 * - `distanceMax = worldHalfWidth (50 m)` — the largest distance from the
 *   pad centre an in-bounds lander can reach, so the saturated value is a
 *   true `out_of_bounds`-grade miss.
 * - `speedMax = 25 m/s` — comfortably above free-fall terminal speed from
 *   the canonical entry (`sqrt(2 * g * altitude) ≈ 16 m/s`) plus modest
 *   horizontal drift, so a powered "fast crash" still maps inside `[0, 1]`.
 * - `tiltMax = π` — fully inverted, the worst possible tilt.
 * - `spinMax = 5 rad/s` — sustained powered spinning produces values in
 *   this range under {@link DEFAULT_PARAMS} (`rcsAngularAccel = 1.5
 *   rad/s²` for several seconds).
 *
 * Weights favour pad accuracy and impact speed — the two signals that
 * most directly distinguish a near-miss from a disaster — while still
 * keeping tilt and spin in the gradient so a barrel-rolling lander does
 * not score the same as an upright one.
 */
export const SCORE_NORMALISERS = {
  /** Upper bound on `|x - padX|` (metres) — beyond this the lander is out of bounds. */
  distanceMax: 50,
  /** Upper bound on unresolved timeout altitude (metres). */
  altitudeMax: DEFAULT_START_ALTITUDE + 20,
  /** Upper bound on impact speed `sqrt(vx² + vy²)` (m/s). */
  speedMax: 25,
  /** Upper bound on tilt magnitude (radians). Fully inverted = π. */
  tiltMax: Math.PI,
  /** Upper bound on angular-velocity magnitude (rad/s). */
  spinMax: 5,
  /** Weight on the normalised distance contribution. */
  weightDistance: 0.4,
  /** Weight on the normalised impact-speed contribution. */
  weightSpeed: 0.3,
  /** Weight on the normalised tilt contribution. */
  weightTilt: 0.2,
  /** Weight on the normalised angular-velocity contribution. */
  weightSpin: 0.1,
} as const;

/** Minimum terminal penalties so "almost landed" never equals landed. */
export const TERMINAL_REWARD_FLOORS = {
  crashed: 0.15,
  flying: 0.15,
  outOfBounds: 1,
} as const;

/** Clamp a value to `[0, 1]`. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Graded terminal reward in `[-1, 0]` derived from four normalised
 * terminal-step signals: distance from the pad centre, impact speed,
 * tilt, and angular velocity.
 *
 * Returns exactly `0` when the state classifies as `landed` — preserving
 * the historical "landed → reward 0" semantics so
 * `defaultRewardToError` still produces `error = 0` for a successful
 * episode. Every non-landed state returns a value in `[-1, 0)`: each of
 * the four signals is divided by its upper bound from
 * {@link SCORE_NORMALISERS}, clamped to `[0, 1]`, combined with the
 * matching weight (weights sum to `1`), and negated. The reward
 * therefore stays in the same `[-1, 0]` range as the legacy binary
 * value, but with a smooth gradient that distinguishes "crashed softly
 * near the pad" (close to `0`) from "flew out of bounds at maximum
 * speed" (close to `-1`).
 *
 * Pure function — no side effects, deterministic for fixed inputs.
 */
export function gradedTerminalReward(
  state: LanderState,
  terrain: LanderTerrain,
): number {
  const outcome = classifyOutcome(state, terrain);
  if (outcome === "landed") return 0;
  if (outcome === "out_of_bounds") return -TERMINAL_REWARD_FLOORS.outOfBounds;
  const distanceNorm = clamp01(
    Math.abs(state.x - terrain.padX) / SCORE_NORMALISERS.distanceMax,
  );
  const altitudeNorm = clamp01(
    Math.max(0, state.y - terrain.groundY) / SCORE_NORMALISERS.altitudeMax,
  );
  const impactSpeed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
  const speedNorm = clamp01(impactSpeed / SCORE_NORMALISERS.speedMax);
  const tiltNorm = clamp01(Math.abs(state.angle) / SCORE_NORMALISERS.tiltMax);
  const spinNorm = clamp01(Math.abs(state.angularV) / SCORE_NORMALISERS.spinMax);
  const weighted = SCORE_NORMALISERS.weightDistance * distanceNorm +
    SCORE_NORMALISERS.weightSpeed * speedNorm +
    SCORE_NORMALISERS.weightTilt * tiltNorm +
    SCORE_NORMALISERS.weightSpin * spinNorm;
  const floor = outcome === "flying"
    ? TERMINAL_REWARD_FLOORS.flying
    : TERMINAL_REWARD_FLOORS.crashed;
  const timeoutAwareWeighted = outcome === "flying" ? Math.max(weighted, altitudeNorm) : weighted;
  // `weighted` is bounded by sum(weights) = 1, but clamp once more so
  // floating-point drift can never push the reward outside `[-1, 0]`.
  return -clamp01(Math.max(floor, timeoutAwareWeighted));
}

/** Configuration options for {@link evolveLanderController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /**
   * NEAT-AI standard target-error stop condition for the RL reward
   * error. The example reports `solved` only when replayed trial
   * outcomes reach the matching landed-rate threshold (`1 -
   * targetError`), so graded near-miss error cannot by itself mark the
   * controller as successful.
   */
  targetError: number;
  /**
   * NEAT-AI standard wall-clock stop condition. Evolution halts when
   * the elapsed time since the loop began exceeds `timeoutMinutes`
   * minutes (default `2`). Whichever of `targetError` and
   * `timeoutMinutes` fires first wins. NEAT-AI 5.0.0 requires this to
   * be an integer ≥ 1 — sub-minute budgets are no longer expressible;
   * use `iterations` instead for fast unit tests.
   */
  timeoutMinutes: number;
  /**
   * Optional generation cap (NEAT-AI's standard `iterations` option).
   * When supplied, the loop also stops once the next-to-be-run
   * generation reaches this value — useful for fast unit tests that
   * need a deterministic generation count without depending on
   * wall-clock timing. Defaults to `Infinity` so production runs are
   * bounded only by `targetError` and `timeoutMinutes`.
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
   * mutation. Kept on the public API for backwards compatibility but is
   * no longer used directly — NEAT-AI owns mutation policy under
   * `evolveRL()`. The value is silently ignored.
   */
  addNeuronRate?: number;
  /**
   * Number of independent perturbed-start trials each candidate is
   * scored on (mean across trials). Defaults to `1`. Maps to
   * `EvolveRLOptions.episodesPerCreature` — the upstream replacement
   * for the legacy `trialsPerScore`.
   */
  trials?: number;
  /**
   * Scaling factor for the per-component perturbation applied to each
   * trial's initial state. Defaults to `0`, i.e. every trial starts
   * from the canonical {@link initialState} entry.
   */
  initialPerturbation?: number;
  /**
   * Seed for sampling per-evaluation initial-state perturbations. No
   * longer applied directly — NEAT-AI rotates a per-generation seed
   * set derived from `EvolveRLOptions.seed`. Retained on the public API
   * for backwards compatibility.
   */
  trialSeed?: number;
  /**
   * Optional pre-seeded creature export, used by the multi-run resume
   * flow (issue #324) to continue evolution from a prior champion. When
   * supplied, the evolveRL seed is built via {@link Creature.fromJSON}
   * instead of the uniform-random `new Creature(INPUT_COUNT,
   * OUTPUT_COUNT)`. When absent the first generation starts from random
   * noise (the default for a `--fresh` run).
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
   * Scaling factor for the per-component perturbation applied to each
   * trial's initial state. Default 0 (no perturbation — every trial
   * starts from the canonical entry).
   */
  initialPerturbation?: number;
}

/** Outcome and final-state record for a single trial within a batch. */
export interface TrialResult {
  /** Score for the trial (see {@link scoreFinalState}). */
  score: number;
  /** Final classification of the trial. */
  outcome: LanderOutcome;
  /** Lander state at the moment the trial terminated. */
  finalState: LanderState;
}

/** Result of scoring a creature across a (possibly single-trial) batch. */
export interface ScoreResult {
  /** Mean score across trials (used for selection). */
  score: number;
  /** Worst-trial outcome by score — tells the "what could go wrong" story. */
  outcome: LanderOutcome;
  /** Final state of the first trial — used by replay/SVG rendering. */
  finalState: LanderState;
  /** Fraction of trials that landed safely on the pad. */
  landedRate: number;
  /** Per-trial details. */
  trials: TrialResult[];
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best (mean) score reached by the champion. */
  bestScore: number;
  /** Number of generations actually run before stopping. */
  generations: number;
  /**
   * True when the champion reached the configured target landed rate
   * (`>= 1 - targetError`).
   */
  solved: boolean;
  /** Champion's measured landed rate across the perturbed-start batch. */
  landedRate: number;
  /** Champion's outcome from the canonical starting state. */
  championOutcome: LanderOutcome;
  /** Wall-clock duration of the evolution loop in milliseconds. */
  wallclockMs: number;
  /**
   * Why the evolution loop terminated:
   * - `"target"` — the champion reached `1 - targetError` landed rate.
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

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 80,
  // NEAT-AI standard stop conditions: evolution halts as soon as the
  // champion's landed-rate on the training trial batch reaches
  // `1 - targetError` (default 99%) OR `timeoutMinutes` minutes have
  // elapsed since the loop began — whichever fires first.
  targetError: 0.01,
  timeoutMinutes: 2,
  mutationStrength: 0.7,
  mutationRate: 0.5,
  addNeuronRate: 0.05,
  // Score every candidate against ten different perturbed starts (the
  // same ten for every member, every generation) so the search cannot
  // win by getting lucky on a single canonical launch.
  trials: 10,
  initialPerturbation: 1.0,
  trialSeed: 24680,
};

/** Adapter configuration consumed by {@link LanderAdapter}. */
export interface LanderAdapterOptions {
  /**
   * Scaling factor for the per-component perturbation applied to each
   * episode's initial state. Default `0` (no perturbation — every
   * episode starts from the canonical {@link initialState}).
   */
  initialPerturbation?: number;
  /** Cap on the number of physics ticks per episode. Default {@link MAX_STEPS}. */
  maxStepsPerEpisode?: number;
}

/**
 * Lunar-lander episode adapter for `Creature.evolveRL()`. Each `step()`
 * advances the deterministic physics simulator, encodes the observation
 * as a `Float32Array`, and emits a reward that maps directly onto
 * NEAT-AI's non-negative `error` slot via `defaultRewardToError`:
 *
 * - Non-terminal step: reward `0`.
 * - Terminal step where the lander landed safely: reward `0`.
 * - Terminal step where the lander crashed, flew off, or timed out:
 *   reward `gradedTerminalReward(state, terrain)`, a value in `[-1, 0)`
 *   derived from four normalised signals (distance from pad, impact
 *   speed, tilt, angular velocity). A near-miss soft crash next to the
 *   pad scores close to `0`; a fast inverted spin out of bounds scores
 *   close to `-1`.
 *
 * The mean cumulative reward across `episodesPerCreature` trials gives
 * the evolver a smooth gradient, but the example's public `solved`
 * flag is computed from replayed `landed` outcomes rather than assuming
 * graded error is identical to `1 - landedRate`.
 *
 * Per-episode initial-state perturbation is owned by the adapter: each
 * `reset(rngSeed)` draws a fresh perturbed {@link LanderScenario}
 * (state + terrain `padX`) from a deterministic PRNG seeded by
 * `rngSeed`. NEAT-AI rotates that seed across the
 * `episodesPerCreature` trials so a population member is scored
 * against the same seed set every generation.
 */
export class LanderAdapter extends EpisodeAdapter<LanderState, LanderAction> {
  /** Half-width of the per-component initial-state perturbation. */
  readonly initialPerturbation: number;
  /** Per-episode step cap. */
  readonly maxStepsPerEpisode: number;
  /** Terrain (notably `padX`) sampled for the current episode. */
  private terrain: LanderTerrain = DEFAULT_TERRAIN;
  /** 1-based step index of the just-completed step (`0` after `reset`). */
  private stepIdx = 0;

  constructor(options: LanderAdapterOptions = {}) {
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

  /** Terrain selected for the most recently `reset()` episode. */
  get currentTerrain(): LanderTerrain {
    return this.terrain;
  }

  override reset(rngSeed: number): { observation: Float32Array; state: LanderState } {
    this.stepIdx = 0;
    if (this.initialPerturbation > 0) {
      const rng = createDeterministicRandom(rngSeed >>> 0);
      const scenario = perturbedScenario(rng, this.initialPerturbation);
      this.terrain = scenario.terrain;
      return { observation: encodeState(scenario.state, scenario.terrain), state: scenario.state };
    }
    this.terrain = DEFAULT_TERRAIN;
    const state = initialState();
    return { observation: encodeState(state, this.terrain), state };
  }

  override decodeAction(
    creatureOutput: Float32Array,
    _state: LanderState,
  ): LanderAction {
    return decodeAction(creatureOutput);
  }

  override step(
    state: LanderState,
    action: LanderAction,
  ): StepResult<Float32Array> & { state: LanderState } {
    const newState = step(state, action);
    this.stepIdx += 1;
    const terminalByPhysics = isTerminal(newState, this.terrain);
    const atCap = this.stepIdx >= this.maxStepsPerEpisode;
    const terminated = terminalByPhysics || atCap;
    // Graded terminal reward in `[-1, 0]` — `0` for a clean landing and
    // a floored smooth gradient otherwise (see {@link gradedTerminalReward}).
    // This gives search useful guidance without letting near misses tie
    // an actual safe touchdown.
    let reward = 0;
    if (terminated) {
      reward = gradedTerminalReward(newState, this.terrain);
    }
    return {
      state: newState,
      observation: encodeState(newState, this.terrain),
      reward,
      terminated,
      truncated: false,
    };
  }
}

/**
 * Convert the creature's three outputs into a thruster action.
 *
 * The main engine (`outputs[0]`) is independently thresholded at 0.5,
 * but the two rotation channels (`outputs[1]` = left, `outputs[2]` =
 * right) are decoded with a winner-takes-all rule: only the strictly
 * larger of the two fires, and only when it crosses the 0.5 threshold.
 *
 * Issue #253: with independent thresholding, evolution settled on
 * controllers whose left and right outputs were both stuck above 0.5,
 * applying equal-and-opposite torques (net zero rotation) while still
 * burning fuel on both thrusters. That made rotation an ineffectual
 * control surface — the lander could only succeed via translation and
 * the main engine, which is precisely the symptom reported in the
 * issue's screenshot. Mutual exclusion turns left/right into a clean
 * three-state ("rotate-left", "rotate-right", "no-rotate") signal that
 * the search can actually optimise.
 */
export function decodeAction(outputs: ArrayLike<number>): LanderAction {
  const main = outputs[0] >= 0.5;
  const leftOut = outputs[1];
  const rightOut = outputs[2];
  let left = false;
  let right = false;
  if (leftOut > rightOut && leftOut >= 0.5) {
    left = true;
  } else if (rightOut > leftOut && rightOut >= 0.5) {
    right = true;
  }
  return { main, left, right };
}

/**
 * Score a final state plus its outcome. Larger is better. Pad-distance
 * costs are computed against `terrain.padX` so scenarios with a shifted
 * landing pad are scored consistently with their own geometry.
 */
export function scoreFinalState(
  state: LanderState,
  outcome: LanderOutcome,
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): number {
  switch (outcome) {
    case "landed":
      return SCORE.landed +
        SCORE.landedFuelBonus * state.fuel -
        SCORE.landedAngleCost * Math.abs(state.angle) -
        SCORE.landedVerticalCost * Math.abs(state.vy) -
        SCORE.landedHorizontalCost * Math.abs(state.vx);
    case "crashed":
      return SCORE.crashedFlat -
        SCORE.crashedDistanceCost * Math.abs(state.x - terrain.padX) -
        SCORE.crashedSpeedCost * (state.vx * state.vx + state.vy * state.vy) -
        SCORE.crashedAngleCost * Math.abs(state.angle);
    case "out_of_bounds":
      return SCORE.outOfBounds;
    case "flying":
      // Episode timed out without resolution. Reward staying close to
      // the pad and penalise lingering altitude so a perpetual hover
      // does not out-score a near-landing.
      return SCORE.flyingFlat -
        SCORE.flyingDistanceCost * Math.abs(state.x - terrain.padX) -
        SCORE.flyingAltitudeCost * Math.max(0, state.y);
  }
}

/** Run a single trial from `start` and return the trial's score, outcome, and final state. */
function runEpisode(
  creature: Creature,
  start: LanderState,
  maxSteps: number,
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): TrialResult {
  let state: LanderState = start;
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state, terrain));
    const action = decodeAction(out);
    state = step(state, action);
    if (isTerminal(state, terrain)) break;
  }
  const outcome = classifyOutcome(state, terrain);
  return { score: scoreFinalState(state, outcome, terrain), outcome, finalState: state };
}

/**
 * Score a creature by simulating one or more episodes. The default
 * (`trials = 1`, `initialPerturbation = 0`) runs a single trial from
 * the canonical {@link initialState}. Pass `options.trials > 1` together
 * with `options.initialPerturbation > 0` to evaluate the controller
 * across several perturbed initial states; the returned `score` is the
 * mean across trials and `landedRate` is the fraction that landed.
 *
 * Identical inputs always produce identical scores (driven by
 * `trialSeed`).
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  options?: ScoreOptions,
): ScoreResult {
  const trials = options?.trials ?? 1;
  const perturbation = options?.initialPerturbation ?? 0;

  if (trials <= 1 && perturbation === 0) {
    const r = runEpisode(creature, initialState(), maxSteps);
    return {
      score: r.score,
      outcome: r.outcome,
      finalState: r.finalState,
      landedRate: r.outcome === "landed" ? 1 : 0,
      trials: [r],
    };
  }

  const random = createDeterministicRandom(options?.trialSeed ?? 0);
  const records: TrialResult[] = [];
  let total = 0;
  let landed = 0;
  for (let t = 0; t < trials; t++) {
    const scenario = perturbation > 0
      ? perturbedScenario(random, perturbation)
      : { state: initialState(), terrain: DEFAULT_TERRAIN };
    const r = runEpisode(creature, scenario.state, maxSteps, scenario.terrain);
    records.push(r);
    total += r.score;
    if (r.outcome === "landed") landed += 1;
  }
  // The "outcome" reported is the worst trial — surfacing the failure
  // mode that drags the mean down.
  const worst = records.reduce((a, b) => (a.score <= b.score ? a : b));
  return {
    score: total / records.length,
    outcome: worst.outcome,
    finalState: records[0].finalState,
    landedRate: landed / records.length,
    trials: records,
  };
}

/**
 * Run a full episode, recording each frame for replay/rendering.
 * Pass `terrain` to align terminal classification with a non-default
 * scenario (e.g. a validation episode whose pad has shifted).
 */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  start: LanderState = initialState(),
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): TraceFrame[] {
  const trace: TraceFrame[] = [];
  let state: LanderState = start;
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state, terrain));
    const action = decodeAction(out);
    trace.push({ state, action });
    state = step(state, action);
    if (isTerminal(state, terrain)) {
      // Append the terminal frame with no thrusters so renderers can
      // show the resting pose.
      trace.push({ state, action: { main: false, left: false, right: false } });
      break;
    }
  }
  if (!trace.length || trace[trace.length - 1].state !== state) {
    // Reached MAX_STEPS without termination — record the final state.
    trace.push({ state, action: { main: false, left: false, right: false } });
  }
  return trace;
}

/** Outcome of replaying the champion against a single validation scenario. */
export interface ValidationScenarioResult {
  /** Seed that produced this scenario (deterministic across runs). */
  seed: number;
  /** Index of the scenario within the validation pool (preserves pool order). */
  index: number;
  /** Final classification of the trial. */
  outcome: LanderOutcome;
  /** Trial fitness under {@link scoreFinalState}. */
  score: number;
  /** Lander state at the moment the trial terminated. */
  finalState: LanderState;
}

/** Aggregated counts of validation outcomes by classification. */
export interface ValidationOutcomeCounts {
  flying: number;
  landed: number;
  crashed: number;
  out_of_bounds: number;
}

/** Structured report produced by {@link validateChampion}. */
export interface ValidationReport {
  /** Per-scenario outcomes, in validation-pool order. */
  scenarios: ValidationScenarioResult[];
  /** Fraction of scenarios that ended in `landed`. */
  landedRate: number;
  /** Mean fitness across all scenarios. */
  meanFitness: number;
  /** Count of each outcome classification across the pool. */
  outcomeCounts: ValidationOutcomeCounts;
  /**
   * Index (in `scenarios`) of the scenario chosen as the SVG source.
   * See {@link pickValidationSvgIndex} for the rule.
   */
  selectedIndex: number;
}

/**
 * Pick a representative validation scenario for the descent SVG.
 *
 * - If **every** scenario landed: return index `0` — deterministic, stable
 *   when scores cluster around the landed baseline.
 * - Else if **any** scenario landed: pick the **lower median** by score
 *   among **landed** scenarios only so the hero replay matches the headline
 *   landed rate (median over all scores often sits on a crash when most
 *   runs land but a few fail hard).
 * - Otherwise (no landings): fall back to the lower median by score across
 *   **all** scenarios so the SVG still tells a deterministic story.
 */
export function pickValidationSvgIndex(
  results: readonly ValidationScenarioResult[],
): number {
  if (results.length === 0) return -1;
  const allLanded = results.every((r) => r.outcome === "landed");
  if (allLanded) return 0;

  const landed = results
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.outcome === "landed");
  if (landed.length > 0) {
    const order = [...landed].sort((a, b) => a.r.score - b.r.score);
    return order[Math.floor((order.length - 1) / 2)].i;
  }

  const order = results
    .map((r, i) => ({ score: r.score, i }))
    .sort((a, b) => a.score - b.score);
  return order[Math.floor((order.length - 1) / 2)].i;
}

/**
 * Replay the champion against every validation scenario and aggregate
 * the per-scenario outcomes plus summary metrics. Each scenario's
 * terrain is honoured during the trial so a shifted pad (`padX !== 0`)
 * is classified against its own geometry, not the canonical default.
 *
 * Output is deterministic for a fixed champion and scenario list.
 */
export function validateChampion(
  champion: Creature,
  validationScenarios: readonly SeededScenario[],
  maxSteps: number = MAX_STEPS,
): ValidationReport {
  const scenarios: ValidationScenarioResult[] = [];
  const counts: ValidationOutcomeCounts = {
    flying: 0,
    landed: 0,
    crashed: 0,
    out_of_bounds: 0,
  };
  let totalScore = 0;
  for (let i = 0; i < validationScenarios.length; i++) {
    const sc = validationScenarios[i];
    const trial = runEpisode(champion, sc.state, maxSteps, sc.terrain);
    scenarios.push({
      seed: sc.seed,
      index: i,
      outcome: trial.outcome,
      score: trial.score,
      finalState: trial.finalState,
    });
    counts[trial.outcome] += 1;
    totalScore += trial.score;
  }
  const n = scenarios.length;
  const landedRate = n === 0 ? 0 : counts.landed / n;
  const meanFitness = n === 0 ? 0 : totalScore / n;
  return {
    scenarios,
    landedRate,
    meanFitness,
    outcomeCounts: counts,
    selectedIndex: pickValidationSvgIndex(scenarios),
  };
}

/** Score the trivial "no-thrust" baseline policy — pure free fall. */
export function freeFallBaselineScore(maxSteps: number = MAX_STEPS): number {
  let state: LanderState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    state = step(state, { main: false, left: false, right: false }, DEFAULT_PARAMS);
    if (isTerminal(state)) break;
  }
  return scoreFinalState(state, classifyOutcome(state));
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

/**
 * Ensure the milestone list reflects the run's actual final generation
 * (issue #351).
 *
 * `Creature.evolveRL()` only emits milestone payloads at the canonical
 * schedule (`1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then powers of
 * ten). When evolution stops between two schedule points — e.g. the
 * 5-minute timeout fires at generation 1487, between `1000` and
 * `10_000` — the last recorded milestone sits at the previous schedule
 * point, so the multi-run chart's x-axis ends at `1000` even though the
 * run actually executed several hundred further generations. The user
 * report on #351 ("Only 1000 Generations ?") is exactly this artefact.
 *
 * This helper appends a synthetic final-generation {@link MilestoneSample}
 * whenever the run terminated past the last canonical milestone, so the
 * chart's x-axis reflects the true terminal generation count rather
 * than the previous round number. The synthetic milestone carries the
 * champion's actual neuron and synapse counts plus the run's final
 * normalised error (mapped back through `bestScore = -error` to match
 * the upstream sign convention), so it slots into the existing
 * milestone pipeline without special-case handling downstream.
 *
 * Edge cases:
 * - Empty milestone list (statistics disabled / zero-iteration run):
 *   the helper returns the list unchanged.
 * - `finalGeneration` already equals the last milestone's generation
 *   (run stopped exactly on a schedule point): no synthetic milestone
 *   is appended.
 * - `finalGeneration < last.generation` (defensive against upstream
 *   drift): the list is returned unchanged.
 *
 * Pure function — no side effects on the input array.
 */
export function appendFinalMilestone(
  milestones: readonly MilestoneSample[],
  finalGeneration: number,
  finalError: number,
  champion: Creature,
  totalWallClockMs?: number,
): MilestoneSample[] {
  const out = milestones.slice();
  if (out.length === 0) return out;
  const last = out[out.length - 1];
  if (!Number.isFinite(finalGeneration) || finalGeneration <= last.generation) {
    return out;
  }
  const clampedError = clamp01(Math.max(0, finalError));
  // Issue #353: attribute the remaining wall-clock (total run wallclock
  // minus the sum of every prior milestone's `generationWallClockMs`)
  // to the synthetic final milestone. The multi-run chart caption sums
  // these values to display a "total ms" figure — without this fix the
  // sum only covers the handful of generations evolveRL emits at the
  // canonical schedule (typically ~10 milestones), so a 5-minute run
  // displayed "597 ms total · 248141 gen/min" instead of the real
  // ~300_000 ms / ~500 gen/min. Attributing the gap here keeps the
  // chart's reported totals faithful to the actual run cost.
  let synthWallClockMs = 0;
  if (totalWallClockMs !== undefined && Number.isFinite(totalWallClockMs)) {
    const accountedMs = out.reduce((acc, m) => acc + m.generationWallClockMs, 0);
    synthWallClockMs = Math.max(0, Math.floor(totalWallClockMs - accountedMs));
  }
  out.push({
    generation: Math.floor(finalGeneration),
    bestScore: -clampedError,
    bestNeurons: champion.neurons.length,
    bestSynapses: champion.synapses.length,
    // `meanEpisodeSteps` is a per-generation rollout statistic that
    // `evolveRL` does not surface at termination. Carry the previous
    // milestone's value forward so the rendered chart keeps a
    // monotonically reasonable curve without inventing a fresh number.
    meanEpisodeSteps: last.meanEpisodeSteps,
    generationWallClockMs: synthWallClockMs,
  });
  return out;
}

/**
 * Run NEAT-AI's first-class reinforcement-learning evolution loop
 * against a {@link LanderAdapter}. Mutation, crossover, elitism,
 * plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #292, supersedes #240).
 *
 * Telemetry is collected via NEAT-AI's `statistics: true` option, which
 * surfaces an `EvolveRLMilestone[]` array on the run summary covering
 * generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then powers
 * of ten. Per issue #298 the example registers **no `onTrainingEvent`
 * handler** — milestone statistics are the only telemetry channel
 * NEAT-AI exposes.
 *
 * Reward shape: the adapter emits {@link gradedTerminalReward} at each
 * terminal step. The evolved reward error is useful telemetry, but
 * `solved` is based on explicit replayed landed rate.
 */
export async function evolveLanderController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const adapter = new LanderAdapter({
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

  // EvolveRL normalised target error. Negative values (used by tests to
  // force the iterations backstop) are clamped to `0`, the smallest
  // legal value. Public success reporting below is based on replayed
  // landed rate, not the graded reward error alone.
  const absoluteTargetError = Math.max(0, options.targetError);

  const loopStart = Date.now();

  const evolveOptions: EvolveRLOptions = {
    seed: options.seed >>> 0,
    populationSize: options.populationSize,
    mutationRate: options.mutationRate,
    // NEAT-AI 5.0.0 owns mutation magnitude internally — the historical
    // `mutationStrength` no longer maps onto `mutationAmount` (which is
    // an *integer* count of mutations per offspring, not a perturbation
    // magnitude). The library default is appropriate for lunar lander.
    targetError: absoluteTargetError,
    timeoutMinutes: options.timeoutMinutes,
    iterations: options.iterations,
    episodesPerCreature: options.trials ?? 1,
    statistics: true,
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;

  const rawMilestones: MilestoneSample[] = (result.milestones ?? []).map(toMilestoneSample);
  // Issue #351: append a synthetic milestone at the run's true terminal
  // generation so the multi-run chart's x-axis stops at the actual final
  // generation rather than the previous canonical schedule point (1000,
  // 10000, …) the upstream milestone cadence happened to emit.
  const milestones: MilestoneSample[] = appendFinalMilestone(
    rawMilestones,
    result.generation,
    result.error,
    seedCreature,
    wallclockMs,
  );

  // Replay the champion against the same perturbed trial batch the
  // adapter was driving so `landedRate`, `championOutcome`, and the
  // canonical SVG outcome remain exact regardless of how evolveRL
  // aggregated rewards internally.
  const trialScore = scoreController(seedCreature, MAX_STEPS, {
    trials: options.trials ?? 1,
    trialSeed: options.trialSeed,
    initialPerturbation: options.initialPerturbation,
  });
  const championLandedRate = trialScore.landedRate;
  const championOutcome = trialScore.outcome;

  const targetLandedRate = 1 - absoluteTargetError;
  const targetMet = championLandedRate >= targetLandedRate;

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
    bestScore: trialScore.score,
    generations: result.generation,
    solved: targetMet,
    landedRate: championLandedRate,
    championOutcome,
    wallclockMs,
    stopReason,
    milestones,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/lunar_lander.svg";

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "lunar_lander";

/**
 * Path to the multi-run error-curve chart the runner emits — normalised
 * error vs cumulative generation across every run, with faint
 * run-boundary guide lines. Subsumes the legacy single-run milestone
 * chart (`docs/screenshots/lunar_lander_milestones.svg`) and the retired
 * per-generation evolution / fitness charts (issue #324, supersedes
 * #292).
 */
export const MULTI_RUN_ERROR_SVG_PATH = "docs/screenshots/lunar_lander/milestones.svg";

/**
 * Path to the multi-run complexity chart the runner emits — neurons +
 * synapses vs cumulative generation across every run.
 */
export const MULTI_RUN_COMPLEXITY_SVG_PATH = "docs/screenshots/lunar_lander/complexity.svg";

/**
 * Default `targetError` for a multi-run invocation. The issue #324
 * convention is `0.01` so the multi-run flow keeps cresting the bar
 * across resumes.
 */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = 0.01;

/**
 * Default wall-clock budget for a single multi-run invocation, in
 * minutes. Five minutes matches the issue #324 default.
 */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/**
 * Path to the validation results JSON written by the runner. Downstream
 * tooling (validation bar chart, README refresh) reads this file.
 */
export const VALIDATION_RESULTS_PATH = ".synthetic-lunar-lander/validation/results.json";

/**
 * Master seed driving the held-out validation pool. Held constant so
 * every run validates against the same 200 scenarios — the controller
 * cannot have seen any of them during training (training and validation
 * pools are disjoint by construction; see `scenarios.ts`).
 */
export const VALIDATION_BASE_SEED = 13579;

/**
 * Path to the per-validation-scenario outcome bar chart SVG the runner
 * emits. Pairs with the descent screenshot and milestone chart to give
 * readers a one-glance view of how robustly the controller generalises.
 */
export const VALIDATION_OUTCOME_SVG_PATH = "docs/screenshots/lunar_lander/validation.svg";

/** Best-effort delete for a single file (missing paths are ignored). */
async function removeFileIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

/**
 * Remove published validation and descent artefacts so a `--fresh` run
 * cannot leave stale JSON/SVGs that still imply an older evolution. Only
 * used for the canonical `docs/` layout (not temp directories in tests).
 */
async function wipeLunarFreshPublishedArtefacts(): Promise<void> {
  await removeFileIfExists(VALIDATION_RESULTS_PATH);
  await removeFileIfExists(VALIDATION_OUTCOME_SVG_PATH);
  await removeFileIfExists(SCREENSHOT_PATH);
}

/**
 * CI/quality "quick mode" stop-condition overrides. When the runner is
 * invoked via `LUNAR_QUICK=1` (env var) or `--quick` (CLI flag), the
 * standard 99% / 5-minute defaults are replaced with a deliberately
 * unreachable target and a short iterations cap so the example always
 * exits via the iterations backstop well inside `quality.sh`'s
 * per-section budget.
 *
 * Quick mode also routes multi-run state + chart writes to a temp
 * directory and gates canonical disk writes (champion JSON, validation
 * results JSON, descent SVG, validation outcome chart) so a CI run
 * never overwrites the docs artefacts checked into the repo.
 */
export const QUICK_TARGET_ERROR = -1;
export const QUICK_TIMEOUT_MINUTES = 1;
/** Quick-mode generation cap — the primary short-circuit for the CI fast path. */
export const QUICK_ITERATIONS = 3;

/**
 * Resolve whether the CI/quality "quick mode" should fire. Either
 * `LUNAR_QUICK=1` (env var) or `--quick` (CLI flag) is enough; both are
 * accepted so callers can pick whichever idiom is simpler in their
 * environment.
 */
export function isQuickMode(args: readonly string[], envValue: string | undefined): boolean {
  if (envValue === "1") return true;
  for (const arg of args) {
    if (arg === "--quick") return true;
  }
  return false;
}

/**
 * Convert a lunar-lander `EvolveRLMilestone` into a
 * {@link NewMultiRunSample}.
 *
 * `EvolveRLMilestone.bestScore` is the per-episode mean cumulative
 * reward reported by NEAT-AI's RL fitness, which for the lunar-lander
 * adapter sits in `[-1, 0]` (graded terminal reward in
 * {@link gradedTerminalReward}). NEAT-AI's `defaultRewardToError` maps
 * that to `error = max(0, -reward)`, so the normalised error for the
 * multi-run chart is `error = -bestScore`, an upper bound on
 * `1 - landedRate` (a soft crash contributes less than `1` to the error
 * sum). The value is clamped defensively into `[0, 1]`.
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

/** Options accepted by {@link runMultiRunLunarLander}. */
export interface RunMultiRunLunarLanderOptions {
  /** Argv (defaults to `Deno.args`). Recognised flags: `--fresh`,
   * `--timeout=<minutes>`, `--target-error=<value>`. */
  argv?: readonly string[];
  /** Base directory override for the multi-run persistence helpers and
   * chart artefacts (used by tests and quick mode). Defaults to `docs`. */
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
 * End-to-end multi-run wiring (issue #324): parses flags, optionally
 * wipes prior state, loads the saved champion (when present) to seed
 * the next run, evolves the controller, appends fresh milestones to
 * the merged history, and renders both multi-run charts.
 *
 * Returns a {@link MultiRunResult} so callers (CLI + tests) can report
 * on the run without re-reading disk.
 */
export async function runMultiRunLunarLander(
  options: RunMultiRunLunarLanderOptions = {},
): Promise<MultiRunResult> {
  const argv = options.argv ?? Deno.args;
  const flags = parseMultiRunFlags(argv);
  const slug = EXAMPLE_SLUG;

  if (flags.fresh) {
    await wipeMultiRunState(slug, options.baseDir);
    if (options.baseDir === undefined) {
      await wipeLunarFreshPublishedArtefacts();
    }
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

  const evolveResult = await evolveLanderController(evolveOptions);

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
      title: "Lunar Lander — multi-run error vs cumulative generations",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

    const complexitySvg = renderMultiRunComplexityChartSVG(merged.milestones, {
      title: "Lunar Lander — multi-run creature complexity",
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

  console.log("🚀 Lunar Lander Descent Example (multi-run)");
  console.log("");

  // Quick mode (CI/quality budget): routes multi-run state + chart
  // writes to a temp directory and forces a tiny iterations cap so the
  // CI invocation never overwrites the canonical docs artefacts.
  const quick = isQuickMode(Deno.args, Deno.env.get("LUNAR_QUICK"));
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "lunar_lander_quick_" });
    console.log(
      "⚡ Quick mode (LUNAR_QUICK=1 or --quick): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
    console.log("");
  }

  const { creaturesDir } = setupWorkingDirs(".synthetic-lunar-lander");

  const baseline = freeFallBaselineScore();
  console.log(`🪂 Free-fall baseline score: ${baseline.toFixed(1)}`);

  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log(
      "🧹 --fresh: full reset — multi-run state under docs/data plus validation JSON, " +
        "validation/descent screenshots, and merged chart captions will reflect only this run.",
    );
  }
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  console.log("\n🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${targetError.toFixed(3)} ` +
      `(landed-rate ≥ ${((1 - targetError) * 100).toFixed(0)}%), ` +
      `timeoutMinutes=${timeoutMinutes}` +
      (quick ? `, iterations=${QUICK_ITERATIONS} (quick mode)` : ""),
  );

  const multi = await runMultiRunLunarLander({
    baseDir: quickBaseDir,
    evolveOverrides: quick
      ? {
        iterations: QUICK_ITERATIONS,
        targetError: QUICK_TARGET_ERROR,
        timeoutMinutes: QUICK_TIMEOUT_MINUTES,
      }
      : undefined,
  });
  const { evolveResult: result } = multi;

  if (multi.resumed) {
    console.log(`🔁 Resumed from prior champion (run ${multi.runIndex}).`);
  } else {
    console.log(`🌱 Fresh start — run ${multi.runIndex} begins from random noise.`);
  }

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} ${result.solved ? "Solved" : "Did not solve"} after ${result.generations} ` +
      `generations (best=${result.bestScore.toFixed(1)}, landed=${
        (result.landedRate * 100).toFixed(0)
      }%, ` +
      `threshold=${((1 - targetError) * 100).toFixed(0)}%, baseline=${baseline.toFixed(1)}, ` +
      `stop=${result.stopReason}, wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // The champion creature is persisted by `runMultiRunLunarLander` under
  // `docs/data/lunar_lander/creature.json`. Also drop a copy under the
  // example's working directory for ad-hoc inspection.
  const championExport: CreatureExport = result.champion.exportJSON();
  const championPath = join(creaturesDir, "champion.json");
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Validate the champion against the held-out validation pool: the SVG
  // and the validation JSON are sourced from these unseen scenarios so
  // the README's screenshot demonstrates generalisation, not memorisation.
  const validationPools = generateScenarioPools(
    VALIDATION_BASE_SEED,
    0,
    DEFAULT_VALIDATION_COUNT,
  );
  const validationReport = validateChampion(result.champion, validationPools.validation);
  console.log(
    `🧪 Validation: landed=${(validationReport.landedRate * 100).toFixed(0)}% ` +
      `(${validationReport.outcomeCounts.landed}/${validationReport.scenarios.length}), ` +
      `mean fitness=${validationReport.meanFitness.toFixed(1)}`,
  );

  if (!quick) {
    ensureDirSync(".synthetic-lunar-lander/validation");
    await safeWriteJson(VALIDATION_RESULTS_PATH, validationReport);
    console.log(
      `📝 Wrote validation results ${VALIDATION_RESULTS_PATH} ` +
        `(${validationReport.scenarios.length} scenarios)`,
    );
  } else {
    console.log("⏭️  Quick mode: skipped writing validation JSON");
  }

  // Render the per-validation-scenario outcome bar chart from the same
  // report. Lives next to the multi-run charts so the README can show
  // the controller's journey alongside its end-state spread across all
  // 200 unseen scenarios.
  const outcomeSamples: ScenarioOutcome[] = validationReport.scenarios.map((s) => ({
    scenarioIndex: s.index,
    outcome: s.outcome,
    score: s.score,
  }));
  if (outcomeSamples.length > 0) {
    const outcomeSvg = renderOutcomeBarChartSVG(outcomeSamples, {
      title: "Lunar Lander — Validation Outcomes",
    });
    if (!quick) {
      ensureDirSync("docs/screenshots/lunar_lander");
      await Deno.writeTextFile(VALIDATION_OUTCOME_SVG_PATH, outcomeSvg);
      console.log(
        `📊 Wrote validation outcome chart ${VALIDATION_OUTCOME_SVG_PATH} ` +
          `(${outcomeSamples.length} scenarios)`,
      );
    }
  }

  // Render the descent SVG from a representative validation scenario —
  // not from the canonical training launch — so the screenshot shows
  // the controller handling an unseen state. See `pickValidationSvgIndex`
  // for the selection rule.
  const selected = validationPools.validation[validationReport.selectedIndex];
  const selectedResult = validationReport.scenarios[validationReport.selectedIndex];
  const trace = replayController(result.champion, MAX_STEPS, selected.state, selected.terrain);
  const svg = renderRunSVG(trace, selected.terrain, selectedResult.outcome);
  if (!quick) {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(
      `🖼️  Wrote screenshot ${SCREENSHOT_PATH} ` +
        `(validation seed=${selected.seed}, outcome=${selectedResult.outcome}, ` +
        `${trace.length} frames)`,
    );
  } else {
    console.log(
      `⏭️  Quick mode: skipped writing descent SVG (rendered ${svg.length} bytes in-memory)`,
    );
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
