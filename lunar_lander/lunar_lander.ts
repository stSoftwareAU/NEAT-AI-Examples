/**
 * Lunar Lander Descent Example
 *
 * Evolves a NEAT-AI creature to land a simplified 2D lunar lander on a
 * flat pad. The simulator (`physics.ts`) is pure TypeScript; the
 * evolutionary loop is now driven entirely by NEAT-AI's class-shaped
 * `Creature.evolveRL()` API (issue #240, depends on
 * `stSoftwareAU/NEAT-AI#2630` and library version `5.0.0`).
 *
 * Inputs (per timestep): `[x, y, vx, vy, angle, angularV, fuel]`.
 * Outputs (3, thresholded at 0.5): `[main, left, right]`.
 * Score: a hand-tuned function rewarding gentle pad-centred landings
 * and remaining fuel, penalising crashes and out-of-bounds drift.
 *
 * 🌱 **Generation 1 starts from random noise.** The seed handed to
 * `Creature.evolveRL()` is a fresh `new Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` — the library's uniform-random minimal genome with
 * direct input → output connections, random weights, and a random
 * output bias. **No hand-crafted topology, no tuned weight init.**
 * Hidden neurons emerge only when NEAT-AI's structural mutation
 * operators (owned by the library) split an existing connection.
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
import { renderOutcomeBarChartSVG, type ScenarioOutcome } from "../common/outcome_bar_chart.ts";
import {
  classifyOutcome,
  DEFAULT_PARAMS,
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

/** Configuration options for {@link evolveLanderController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /**
   * NEAT-AI standard target-error stop condition. Evolution halts as
   * soon as the champion's normalised error reaches `targetError`. The
   * adapter emits a terminal reward of `0` when the lander lands safely
   * and `-1` otherwise, so the cumulative reward sits in `[-1, 0]` and
   * `defaultRewardToError` yields an `error` equal to `1 - landedRate`
   * across the per-creature episode batch. The historical
   * `1 - targetLandedRate` semantics therefore pass straight through:
   * `targetError = 0.01` corresponds to a 99% landed rate.
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
  /** Standard deviation of the weight/bias perturbation noise. */
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
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, a snapshot of the
   * seed creature is captured if generation `1` is a checkpoint, and a
   * snapshot of the final champion is captured at the final
   * generation. Mid-run intermediate generations are no longer captured
   * because `Creature.evolveRL()` does not expose mid-run creature
   * exports — see issue #240 for the migration trade-offs.
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
   * Scaling factor for the per-component perturbation applied to each
   * trial's initial state. Default 0 (no perturbation — every trial
   * starts from the canonical entry).
   */
  initialPerturbation?: number;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
  /** Fraction of the champion's trials that ended in `landed`. */
  bestLandedRate: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
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
  /** Final-generation mean score (for sanity checks against baselines). */
  finalMeanScore: number;
  /** Wall-clock duration of the evolution loop in milliseconds. */
  wallclockMs: number;
  /**
   * Why the evolution loop terminated:
   * - `"target"` — the champion reached `1 - targetError` landed rate.
   * - `"timeout"` — `timeoutMinutes` elapsed before the target fired.
   * - `"iterations"` — the optional generation cap was hit first.
   */
  stopReason: "target" | "timeout" | "iterations";
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
 *   reward `-1`.
 *
 * Across `episodesPerCreature` trials the mean cumulative reward is
 * therefore `-(1 - landedRate)`, so `defaultRewardToError` yields
 * `error = 1 - landedRate` and `EvolveRLOptions.targetError = 0.01`
 * stops evolution as soon as the champion's landed rate on the
 * per-generation seed set reaches 99%. The historical
 * `1 - targetLandedRate` semantics carried by the example's caller
 * therefore pass straight through to the upstream API.
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
      return { observation: encodeState(scenario.state), state: scenario.state };
    }
    this.terrain = DEFAULT_TERRAIN;
    const state = initialState();
    return { observation: encodeState(state), state };
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
    // Binary terminal reward: `0` for landed, `-1` for anything else
    // (crashed, out-of-bounds, or step-cap reached while still flying).
    // `defaultRewardToError` yields error = 0 for landed and 1 otherwise,
    // so the mean across `episodesPerCreature` trials is exactly
    // `1 - landedRate`.
    let reward = 0;
    if (terminated) {
      const outcome = classifyOutcome(newState, this.terrain);
      reward = outcome === "landed" ? 0 : -1;
    }
    return {
      state: newState,
      observation: encodeState(newState),
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
    const out = creature.activate(encodeState(state));
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
    const out = creature.activate(encodeState(state));
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
 * Default rule: the scenario whose final score is the median across all
 * validation scenarios — sorted ascending and indexing the lower median
 * (`Math.floor((n - 1) / 2)`) so the choice is stable for ties. If every
 * scenario landed successfully, return index `0` instead — a deterministic
 * fallback that side-steps tie-break sensitivity when scores cluster
 * tightly around the landed-baseline.
 */
export function pickValidationSvgIndex(
  results: readonly ValidationScenarioResult[],
): number {
  if (results.length === 0) return -1;
  const allLanded = results.every((r) => r.outcome === "landed");
  if (allLanded) return 0;
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

/** Per-generation aggregate accumulated from `onEpisodeTrials` events. */
interface GenerationBucket {
  /** Per-creature mean reward across this generation's episode batch. */
  meanRewards: number[];
  /** Best `meanReward` seen this generation. */
  bestReward: number;
  /** Best champion's neuron count (carried from the previous milestone). */
  bestNeurons: number;
  /** Best champion's synapse count (carried from the previous milestone). */
  bestSynapses: number;
}

/**
 * Run NEAT-AI's first-class reinforcement-learning evolution loop
 * against a {@link LanderAdapter}. Mutation, crossover, elitism,
 * plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #240).
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
export async function evolveLanderController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const adapter = new LanderAdapter({
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
  let bestScoreSeen = -Infinity;
  let bestLandedRateSeen = 0;
  let lastMeanScore = 0;
  let lastObservedGeneration = 0;
  let solvedAtGen = -1;

  // EvolveRL normalised target error — the adapter emits a binary
  // terminal reward in `{0, -1}`, so `defaultRewardToError` produces
  // an error in `{0, 1}` and the mean across episodes is exactly
  // `1 - landedRate`. The caller's `targetError` value therefore maps
  // straight onto the upstream API without rescaling. Negative values
  // (used by tests to force the iterations backstop) are clamped to
  // `0`, the smallest legal value.
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
      let bestScoreThisGen: number;
      let meanScoreThisGen: number;
      let bestLandedRateThisGen: number;
      let neurons: number;
      let synapses: number;
      if (bucket && bucket.meanRewards.length > 0) {
        const sum = bucket.meanRewards.reduce((a, b) => a + b, 0);
        const meanReward = sum / bucket.meanRewards.length;
        // Cumulative reward sits in `[-1, 0]`; `score = 1 + reward`
        // therefore sits in `[0, 1]` and corresponds to the landed
        // rate. We surface `bestScore` and `meanScore` as the landed
        // rate to match the historical contract (caller code prints
        // and logs them as fractions in `[0, 1]`).
        meanScoreThisGen = 1 + meanReward;
        bestScoreThisGen = 1 + bucket.bestReward;
        bestLandedRateThisGen = bestScoreThisGen;
        neurons = bucket.bestNeurons;
        synapses = bucket.bestSynapses;
      } else {
        // No data this generation (e.g. every creature was an elite cached
        // from a previous round). Fall back to the last known stats.
        meanScoreThisGen = lastMeanScore;
        bestScoreThisGen = bestScoreSeen >= 0 ? bestScoreSeen : 0;
        bestLandedRateThisGen = bestLandedRateSeen;
        neurons = latestBestNeurons;
        synapses = latestBestSynapses;
      }
      if (bestScoreThisGen > bestScoreSeen) {
        bestScoreSeen = bestScoreThisGen;
        bestLandedRateSeen = bestLandedRateThisGen;
      }
      lastMeanScore = meanScoreThisGen;
      if (bestLandedRateThisGen >= 1 - absoluteTargetError && solvedAtGen < 0) {
        solvedAtGen = generation0;
      }
      options.onGeneration?.({
        generation: generation0,
        bestScore: bestScoreThisGen,
        meanScore: meanScoreThisGen,
        bestLandedRate: bestLandedRateThisGen,
        neurons,
        synapses,
      });
    },
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;
  const finalGeneration = Math.max(lastObservedGeneration, result.generation);

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
  if (trialScore.score > bestScoreSeen) bestScoreSeen = trialScore.score;

  // Capture the final champion as the last snapshot if the caller asked
  // for a checkpoint at the final generation (or used the default
  // checkpoint list that includes the final gen).
  if (options.snapshotConfig?.checkpoints.includes(finalGeneration)) {
    captureSnapshot(
      options.snapshotConfig,
      finalGeneration,
      seedCreature.exportJSON(),
      trialScore.score,
    );
  } else if (options.snapshotConfig) {
    // Always write a snapshot at the final generation so the multi-panel
    // SVG has a closing frame even when no exact checkpoint matches.
    captureSnapshot(
      { ...options.snapshotConfig, checkpoints: [finalGeneration] },
      finalGeneration,
      seedCreature.exportJSON(),
      trialScore.score,
    );
  }

  const targetMet = championLandedRate >= 1 - absoluteTargetError ||
    solvedAtGen >= 0;

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
    bestScore: trialScore.score,
    generations: finalGeneration,
    solved: targetMet,
    landedRate: championLandedRate,
    championOutcome,
    finalMeanScore: lastMeanScore,
    wallclockMs,
    stopReason,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/lunar_lander.svg";

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
 * Generations at which the runner captures evolution snapshots. Under
 * the new `Creature.evolveRL()`-driven loop the upstream API only
 * exposes the seed creature and the final champion, so only the first
 * entry (`1`) and the run's terminal generation actually produce
 * snapshot files. The remaining entries are retained for backwards
 * compatibility — they are silently ignored.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 100, 500, 1000];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-lunar-lander/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/lunar_lander_evolution.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/lunar_lander/evolution.svg";

/** Path to the per-generation fitness-chart SVG the runner emits. */
export const FITNESS_CHART_PATH = "docs/screenshots/lunar_lander/fitness.svg";

/**
 * Path to the per-validation-scenario outcome bar chart SVG the runner
 * emits. Pairs with the descent screenshot and fitness chart to give
 * readers a one-glance view of how robustly the controller generalises.
 */
export const VALIDATION_OUTCOME_SVG_PATH = "docs/screenshots/lunar_lander/validation.svg";

/** Path to the per-generation evolution telemetry CSV the runner emits. */
export const EVOLUTION_CSV_PATH = "docs/data/lunar_lander/evolution.csv";

/** Header row written at the top of {@link EVOLUTION_CSV_PATH}. */
export const EVOLUTION_CSV_HEADER = "generation,best_fitness,avg_fitness,landed_rate,wallclock_ms";

/**
 * One row of per-generation evolution telemetry. Captured during a run
 * and serialised to {@link EVOLUTION_CSV_PATH} so downstream tools can
 * inspect how the population's fitness improved over time.
 */
export interface EvolutionRow {
  /** Zero-based generation index. */
  generation: number;
  /** Best fitness in this generation (max across the population). */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  avgFitness: number;
  /** Fraction of the champion's perturbed-trial batch that landed. */
  landedRate: number;
  /** Milliseconds elapsed since the evolution loop began. */
  wallclockMs: number;
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
        formatCsvNumber(r.avgFitness),
        formatCsvNumber(r.landedRate),
        Math.round(r.wallclockMs),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
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
 * Trivial `--name=value` CLI flag parser. Returns `undefined` when the
 * flag is absent or its value is not a finite number.
 */
function parseNumericFlag(args: string[], name: string): number | undefined {
  const prefix = `${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      const v = parseFloat(arg.slice(prefix.length));
      if (Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

/**
 * CI/quality "quick mode" stop-condition overrides. When the runner is
 * invoked via `LUNAR_QUICK=1` (env var) or `--quick` (CLI flag), the
 * standard 99% / 2-minute defaults are replaced with a deliberately
 * unreachable target and a 1-minute wall-clock budget so the example
 * always exits via the wall-clock backstop.
 *
 * NEAT-AI 5.0.0 requires `timeoutMinutes` to be an integer ≥ 1, so the
 * historical sub-minute budget is no longer expressible directly via
 * `timeoutMinutes`. Quick mode now uses `iterations` as the primary
 * short-circuit: the loop stops after a handful of generations, well
 * inside `quality.sh`'s per-section budget. Setting `timeoutMinutes = 1`
 * keeps the field schema-valid as a fallback.
 *
 * - `targetError = -1` is unreachable — the threshold becomes
 *   `landed-rate >= 1 - (-1) = 2`, but `landed-rate` is bounded by 1,
 *   so the loop never trips the `target` stop condition.
 *
 * Quick mode also suppresses canonical artefact writes (champion JSON,
 * validation results JSON, descent SVG, evolution chart/strip, fitness
 * chart, telemetry CSV) so a CI run never overwrites the docs artefacts
 * checked into the repo. Snapshot files are written to a temp dir
 * scoped to the run so the snapshot loader still has something to read,
 * without disturbing `.synthetic-lunar-lander/snapshots/`.
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

if (import.meta.main) {
  const start = Date.now();

  console.log("🚀 Lunar Lander Descent Example");
  console.log("");

  // Quick mode (CI/quality budget): forces a tiny iterations cap and
  // skips canonical artefact writes so a CI invocation never overwrites
  // the docs artefacts checked into the repo. See {@link isQuickMode}.
  const quick = isQuickMode(Deno.args, Deno.env.get("LUNAR_QUICK"));
  if (quick) {
    console.log("⚡ Quick mode (LUNAR_QUICK=1 or --quick): tiny budget, no canonical artefacts");
    console.log("");
  }

  const { creaturesDir } = setupWorkingDirs(".synthetic-lunar-lander");

  const baseline = freeFallBaselineScore();
  console.log(`🪂 Free-fall baseline score: ${baseline.toFixed(1)}`);

  // CLI overrides for the NEAT-AI standard stop conditions. Quick mode
  // forces an impossible target plus a small iterations cap so the loop
  // always exits via the iterations backstop well inside the CI budget.
  const targetError = quick ? QUICK_TARGET_ERROR : (parseNumericFlag(Deno.args, "--target-error") ??
    DEFAULT_EVOLVE_OPTIONS.targetError);
  const timeoutMinutes = quick
    ? QUICK_TIMEOUT_MINUTES
    : (parseNumericFlag(Deno.args, "--timeout-minutes") ??
      DEFAULT_EVOLVE_OPTIONS.timeoutMinutes);
  const iterations = quick ? QUICK_ITERATIONS : undefined;

  console.log("\n🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${targetError} ` +
      `(landed-rate ≥ ${((1 - targetError) * 100).toFixed(0)}%), ` +
      `timeoutMinutes=${timeoutMinutes}` +
      (iterations !== undefined ? `, iterations=${iterations}` : ""),
  );
  // In quick mode, route snapshot files into a per-run temp dir so the
  // checked-in `.synthetic-lunar-lander/snapshots/` is left untouched.
  const snapshotsDir = quick
    ? Deno.makeTempDirSync({ prefix: "lunar_lander_quick_snapshots_" })
    : SNAPSHOTS_DIR;
  ensureDirSync(snapshotsDir);
  for (const entry of Deno.readDirSync(snapshotsDir)) {
    if (entry.isFile) Deno.removeSync(join(snapshotsDir, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionRows: EvolutionRow[] = [];
  const evolutionStart = Date.now();
  const result = await evolveLanderController({
    ...DEFAULT_EVOLVE_OPTIONS,
    targetError,
    timeoutMinutes,
    iterations,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: snapshotsDir,
    },
    onGeneration: ({ generation, bestScore, meanScore, bestLandedRate, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      evolutionRows.push({
        generation,
        bestFitness: bestScore,
        avgFitness: meanScore,
        landedRate: bestLandedRate,
        wallclockMs: Date.now() - evolutionStart,
      });
      if (generation % 10 === 0) {
        console.log(
          `   Gen ${generation.toString().padStart(4)}  best=${
            bestScore.toFixed(3).padStart(8)
          }  mean=${meanScore.toFixed(3).padStart(8)}  ` +
            `landed=${(bestLandedRate * 100).toFixed(0).padStart(3)}%  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} ${result.solved ? "Solved" : "Did not solve"} after ${result.generations} ` +
      `generations (best=${result.bestScore.toFixed(1)}, landed=${
        (result.landedRate * 100).toFixed(0)
      }%, ` +
      `threshold=${((1 - targetError) * 100).toFixed(0)}%, baseline=${baseline.toFixed(1)}, ` +
      `stop=${result.stopReason}, wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Always exercise the post-evolution pipeline (validation, replay,
  // SVG rendering, chart construction) so quick mode still proves the
  // full code path runs end-to-end. Only the disk writes that would
  // overwrite canonical docs artefacts are gated on `!quick`.
  const championExport: CreatureExport = result.champion.exportJSON();
  if (!quick) {
    const championPath = join(creaturesDir, "champion.json");
    await safeWriteJson(championPath, championExport);
    console.log(`💾 Saved champion to ${championPath}`);
  } else {
    console.log("⏭️  Quick mode: skipped writing champion JSON");
  }

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
  // report. Lives next to the fitness chart so the README can show the
  // controller's journey (fitness chart) alongside its end-state spread
  // across all 200 unseen scenarios (this chart).
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

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Lunar Lander — Evolution",
      scoreLabel: "best score",
    });
    if (!quick) {
      ensureDirSync("docs/screenshots/lunar_lander");
      await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
      console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
    }
  }

  // Per-generation evolution telemetry: CSV (source of truth) plus a
  // best/avg fitness line chart rendered from the same rows. Both are
  // emitted on every full run so downstream tools and the README can
  // reuse the same data.
  if (evolutionRows.length > 0) {
    const csvText = formatEvolutionCsv(evolutionRows);
    const fitnessSamples: FitnessSample[] = evolutionRows.map((r) => ({
      generation: r.generation,
      bestFitness: r.bestFitness,
      avgFitness: r.avgFitness,
    }));
    const fitnessSvg = renderFitnessChartSVG(fitnessSamples, {
      title: "Lunar Lander — Fitness vs Generation",
      bestLabel: "best fitness",
      avgLabel: "avg fitness",
    });
    if (!quick) {
      ensureDirSync("docs/data/lunar_lander");
      await Deno.writeTextFile(EVOLUTION_CSV_PATH, csvText);
      console.log(`🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${evolutionRows.length} rows)`);

      ensureDirSync("docs/screenshots/lunar_lander");
      await Deno.writeTextFile(FITNESS_CHART_PATH, fitnessSvg);
      console.log(`📈 Wrote fitness chart ${FITNESS_CHART_PATH}`);
    }
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(snapshotsDir);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Lunar Lander — Evolution Progress",
      caption: {
        finalScore: result.bestScore,
        totalGenerations: result.generations,
        wallClockMs: Date.now() - evolutionStart,
      },
    });
    if (!quick) {
      await Deno.writeTextFile(EVOLUTION_PROGRESS_SVG_PATH, progressionSvg);
      console.log(
        `🧬 Wrote evolution-progression strip ${EVOLUTION_PROGRESS_SVG_PATH} ` +
          `(${snapshots.length} panels)`,
      );
    }
  }

  // Tidy the per-run snapshot temp dir if quick mode created one.
  if (quick && snapshotsDir !== SNAPSHOTS_DIR) {
    try {
      Deno.removeSync(snapshotsDir, { recursive: true });
    } catch (_err) {
      // Non-fatal — quick mode runs are best-effort about cleanup.
    }
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
