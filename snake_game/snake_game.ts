/**
 * Snake Game Example.
 *
 * Evolves a NEAT-AI controller to play the classic Snake grid game.
 * Each agent observes a small sensor pack (wall distances, food
 * direction, tail direction, length — see `agent.ts`) and emits four
 * activations, one per heading; the argmax becomes the next heading.
 * The simulator (`snake.ts`), animated SVG renderer (`svg.ts`), and
 * episode adapter all run in pure TypeScript. The evolutionary loop is
 * driven by NEAT-AI's class-shaped `Creature.evolveRL()` API
 * (issue #291, replaces #238).
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
 *
 * Score = `food × FOOD_REWARD − stepCount × STEP_PENALTY` minus a
 * one-off `DEATH_PENALTY` if the snake collided with a wall or itself.
 * The reward surfaced to `evolveRL` is a single scalar terminal reward
 * normalised onto `[-1, 0]` so `defaultRewardToError` produces an error
 * of `1 - min(eaten, SOLVED_THRESHOLD) / SOLVED_THRESHOLD`. Across
 * `episodesPerCreature` trials the mean error is therefore
 * `1 - meanCappedEaten / SOLVED_THRESHOLD`, so
 * `EvolveRLOptions.targetError = 0.5` stops evolution once the
 * champion's mean food eaten reaches `1.5` across the per-generation
 * seed set.
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
import { decodeAction, encodeState, INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { type Heading, newGame, type SnakeState, step } from "./snake.ts";
import { renderRunSVG } from "./svg.ts";

/** Hard cap on the number of ticks a single episode is allowed. */
export const MAX_STEPS = 500;

/** Score reward per food item eaten. */
export const FOOD_REWARD = 100;

/** Per-step penalty applied at the end of the episode. */
export const STEP_PENALTY = 0.1;

/** Flat penalty applied when the snake dies (wall or self collision). */
export const DEATH_PENALTY = 50;

/**
 * Coefficient for the Manhattan-distance shaping reward used by the
 * legacy {@link scoreController} fitness signal. Each tick the snake
 * moves closer to (or further from) the food contributes
 * `±DISTANCE_SHAPING_COEFF` to the post-run fitness number reported
 * by the scoring helpers. See {@link ADAPTER_SHAPING_COEFF} for the
 * (much smaller) coefficient used inside the `evolveRL` adapter
 * itself.
 */
export const DISTANCE_SHAPING_COEFF = 0.5;

/**
 * Per-step Manhattan-distance shaping coefficient used by
 * {@link SnakeAdapter}. Sized so the cumulative shaping contribution
 * over a 500-step episode can dominate the food-eaten signal — without
 * a strong shaping term the GA receives no gradient until a creature
 * accidentally swallows food, and the population stalls. The
 * post-evolution `solved` flag still requires
 * `championEaten ≥ SOLVED_THRESHOLD` on the held-out evaluation seeds,
 * so an "approaches-but-never-eats" champion cannot trip the gate.
 */
export const ADAPTER_SHAPING_COEFF = 5e-3;

/**
 * Best-seed food-eaten threshold at or above which the controller is
 * declared "solved". The threshold is applied to the **maximum eaten
 * across the evaluation seeds** for the running champion — i.e. the
 * same number that the SVG playthrough visualises after
 * `pickBestReplaySeed`. This matches closed issue #137's "champion ate
 * at least three food on the replay episode" target, but the bar
 * means more here because evolution starts from uniform-random NEAT
 * noise (no hand-crafted layered seed).
 */
export const SOLVED_THRESHOLD = 3;

/**
 * Minimum mean food eaten across the evaluation seed batch required
 * before the {@link SOLVED_THRESHOLD} early-stop is allowed to fire.
 * Without this floor a fragile elite that aces a single seed (and
 * fails the rest) would short-circuit the run and leave the user with
 * a flaky champion.
 */
export const SOLVED_AVG_FLOOR = 1.5;

/**
 * Episode seeds used to evaluate every creature during post-evolution
 * scoring. The fitness reported by {@link evaluateController} is the
 * mean across these episodes, so a controller has to generalise across
 * several food spawn sequences to clear the bar — far more robust than
 * a single fixed seed. `Creature.evolveRL()` rotates its own per-
 * generation seed set derived from `EvolveRLOptions.seed`; this list
 * is consulted only by the replay / scoring helpers that the runner
 * uses after evolution finishes.
 */
export const DEFAULT_EVAL_SEEDS: readonly number[] = [
  0x51a1,
  0x51a2,
  0x51a3,
  0x51a4,
  0x51a5,
];

/**
 * Default fallback replay seed used when the runner is asked to render
 * the SVG without first picking the best-performing evaluation seed.
 * Tests pin this so reruns produce identical SVGs.
 */
export const DEFAULT_REPLAY_SEED = DEFAULT_EVAL_SEEDS[0];

/** Configuration options for {@link evolveSnakeController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /**
   * NEAT-AI standard target-error stop condition. Evolution halts as
   * soon as the mean cumulative episode reward across the
   * per-generation seed batch reaches `-targetError` (default `0.05`).
   * Under {@link SnakeAdapter}'s reward shaping this is a strict gate
   * that only fires when the champion is reliably clearing the food.
   * Forwarded verbatim to `EvolveRLOptions.targetError`. The
   * post-evolution `solved` flag is computed independently from
   * {@link SOLVED_THRESHOLD} / {@link SOLVED_AVG_FLOOR} on the
   * held-out {@link DEFAULT_EVAL_SEEDS} batch.
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
   * Number of independent episode trials each candidate is scored on
   * (mean across trials). Defaults to {@link DEFAULT_EVAL_SEEDS}'s
   * length. Maps to `EvolveRLOptions.episodesPerCreature`.
   */
  trials?: number;
  /** Hard cap on episode length. Defaults to {@link MAX_STEPS}. */
  maxSteps?: number;
  /**
   * Episode seeds used by post-evolution {@link evaluateController}
   * scoring. Defaults to {@link DEFAULT_EVAL_SEEDS}. `Creature.evolveRL`
   * derives its own per-generation seed set from
   * `EvolveRLOptions.seed`; this list is consumed only by callers that
   * re-score the champion after evolution finishes.
   */
  evalSeeds?: readonly number[];
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Mean raw game score across the post-evolution evaluation seeds. */
  bestScore: number;
  /** Mean food eaten across the post-evolution evaluation seeds. */
  championEatenAvg: number;
  /** Eaten count for the replay episode (used by the SVG). */
  championEaten: number;
  /** Steps taken on the replay episode. */
  championSteps: number;
  /** Episode seed used for the replay SVG. */
  championReplaySeed: number;
  /** Number of generations actually run before stopping. */
  generations: number;
  /** True when the champion's best replay eaten ≥ {@link SOLVED_THRESHOLD}
   *  AND its mean food eaten across the eval seeds ≥
   *  {@link SOLVED_AVG_FLOOR}. */
  solved: boolean;
  /** Wall-clock duration of the evolution loop in milliseconds. */
  wallclockMs: number;
  /**
   * Why the evolution loop terminated:
   * - `"target"` — the champion met both gates.
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
 * - `targetError = 0.05` requires the mean cumulative episode reward
 *   across the per-generation seed batch to climb above `-0.05`. Under
 *   the {@link SnakeAdapter}'s reward shaping (terminal `-1` baseline,
 *   `+1/SOLVED_THRESHOLD` per food eaten, Manhattan-distance shaping
 *   bounded by ~`±0.5` per episode) this is a strict gate that only
 *   fires when the champion is actually clearing the food — a snake
 *   that merely chases the food without eating it cannot reach the
 *   threshold on its own.
 * - `timeoutMinutes = 5` is the audit-mandated wall-clock backstop.
 */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 60,
  targetError: 0.05,
  timeoutMinutes: 5,
  mutationStrength: 0.6,
  mutationRate: 0.5,
  // Retained for backwards compatibility — NEAT-AI owns structural
  // mutation under evolveRL().
  addNeuronRate: 0.03,
  trials: 10,
};

// ---- SnakeAdapter ------------------------------------------------------

/** Adapter configuration consumed by {@link SnakeAdapter}. */
export interface SnakeAdapterOptions {
  /** Cap on the number of ticks per episode. Default {@link MAX_STEPS}. */
  maxStepsPerEpisode?: number;
  /** Food-eaten target used for normalised reward shaping. Default
   *  {@link SOLVED_THRESHOLD}. */
  solvedThreshold?: number;
}

/** State threaded through each episode by {@link SnakeAdapter}. */
export interface SnakeEpisodeState {
  /** Current simulator state. */
  game: SnakeState;
  /** 1-based step index of the just-completed step (`0` after `reset`). */
  stepIdx: number;
}

/**
 * Snake-game episode adapter for `Creature.evolveRL()`. Each `step()`
 * advances the deterministic simulator, encodes the next observation
 * as a `Float32Array`, and emits a reward that maps directly onto
 * NEAT-AI's non-negative `error` slot via `defaultRewardToError`
 * (`error = max(0, -reward)`):
 *
 * - Per-step Manhattan shaping — `(prevDistance − newDistance) ×
 *   ADAPTER_SHAPING_COEFF`. Tiny enough not to dominate the food
 *   signal but dense enough to break the flat fitness landscape that
 *   would otherwise leave the population stuck at "ate one food".
 * - Per food eaten this tick — `+1 / solvedThreshold`.
 * - Terminal step (snake died or hit the step cap) — additional
 *   constant `-1` baseline penalty.
 *
 * Cumulative episode reward is therefore
 * `(eatenCappedAtThreshold) / solvedThreshold + shapingSum − 1`,
 * which `defaultRewardToError` collapses to
 * `error ≈ 1 − cappedEaten / solvedThreshold` (the shaping term is
 * bounded to ~0.05 by {@link ADAPTER_SHAPING_COEFF}). Across
 * `episodesPerCreature` trials the mean cumulative error is
 * `1 − meanCappedEaten / solvedThreshold`, so
 * `EvolveRLOptions.targetError = 0.5` stops evolution once the mean
 * eaten reaches `1.5 =` {@link SOLVED_AVG_FLOOR} food across the
 * per-generation seed set.
 */
export class SnakeAdapter extends EpisodeAdapter<SnakeEpisodeState, Heading> {
  readonly maxStepsPerEpisode: number;
  readonly solvedThreshold: number;

  /**
   * Deterministic food-spawn PRNG for the current episode. Reseeded by
   * {@link reset} so two episodes with the same `rngSeed` produce
   * identical food sequences.
   */
  private foodRng?: () => number;

  constructor(options: SnakeAdapterOptions = {}) {
    super();
    this.maxStepsPerEpisode = options.maxStepsPerEpisode ?? MAX_STEPS;
    this.solvedThreshold = options.solvedThreshold ?? SOLVED_THRESHOLD;
  }

  override get observationLength(): number {
    return INPUT_COUNT;
  }

  override maxSteps(): number {
    return this.maxStepsPerEpisode;
  }

  override reset(
    rngSeed: number,
  ): { observation: Float32Array; state: SnakeEpisodeState } {
    this.foodRng = createDeterministicRandom(rngSeed >>> 0);
    const game = newGame(this.foodRng);
    return {
      observation: encodeState(game),
      state: { game, stepIdx: 0 },
    };
  }

  override decodeAction(
    creatureOutput: Float32Array,
    _state: SnakeEpisodeState,
  ): Heading {
    return decodeAction(creatureOutput);
  }

  override step(
    state: SnakeEpisodeState,
    action: Heading,
  ): StepResult<Float32Array> & { state: SnakeEpisodeState } {
    if (!this.foodRng) {
      throw new Error("SnakeAdapter.step called before reset");
    }
    const newGameState = step(state.game, action, this.foodRng);
    const newStepIdx = state.stepIdx + 1;
    const died = newGameState.dead;
    const hitCap = !died && newStepIdx >= this.maxStepsPerEpisode;
    const terminated = died || hitCap;

    // Per-step Manhattan shaping: `+ADAPTER_SHAPING_COEFF` when the
    // head closes on the food, `-ADAPTER_SHAPING_COEFF` when it backs
    // away. Bounded to ~0.05 over an entire episode so the
    // `targetError` mapping stays accurate.
    const prevDistance = manhattan(state.game.body[0], state.game.food);
    const newDistance = manhattan(newGameState.body[0], newGameState.food);
    let reward = (prevDistance - newDistance) * ADAPTER_SHAPING_COEFF;

    // Food-eaten bonus: `+1 / threshold` per food consumed this tick.
    const foodThisTick = newGameState.eaten - state.game.eaten;
    if (foodThisTick > 0) {
      const eatenSoFar = state.game.eaten;
      const remaining = Math.max(0, this.solvedThreshold - eatenSoFar);
      reward += Math.min(foodThisTick, remaining) / this.solvedThreshold;
    }

    // Terminal -1 baseline so cumulative reward of a noise snake is
    // `≈ -1` (error ≈ 1) and a snake that eats the full threshold is
    // `≈ 0` (error ≈ 0).
    if (terminated) {
      reward -= 1;
    }

    return {
      state: { game: newGameState, stepIdx: newStepIdx },
      observation: encodeState(newGameState),
      reward,
      terminated,
      truncated: false,
    };
  }
}

// ---- Legacy scoring / replay helpers ------------------------------------
// Retained because the runner's post-evolution path renders the SVG and
// the tests still exercise the deterministic Manhattan-shaped fitness.

/** Outcome of a single scoring episode. */
export interface EpisodeResult {
  /** Raw game score: `eaten × FOOD_REWARD − steps × STEP_PENALTY − DEATH_PENALTY?`. */
  score: number;
  /** Fitness as used for legacy selection: raw score + Manhattan shaping. */
  fitness: number;
  eaten: number;
  steps: number;
  died: boolean;
  finalState: SnakeState;
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Build a snake-game {@link LocalEpisodeAdapter} bound to a per-episode
 * RNG. The food sequence is driven by the same `episodeRandom` so two
 * controllers given the same `episodeSeed` see the same spawns.
 */
function snakeLocalAdapter(
  start: SnakeState,
  episodeRandom: () => number,
): LocalEpisodeAdapter<SnakeState, Heading> {
  return {
    initialState: start,
    encode: encodeState,
    decode: decodeAction,
    step: (s, a) => step(s, a, episodeRandom),
    isTerminal: (s) => s.dead,
  };
}

/**
 * Play one episode and score the controller. The same per-episode
 * seed is used for every controller in a generation so the comparison
 * is fair (same initial state, same food sequence on equivalent
 * decisions).
 */
export function scoreController(
  creature: Creature,
  episodeSeed: number,
  maxSteps: number = MAX_STEPS,
): EpisodeResult {
  const episodeRandom = createDeterministicRandom(episodeSeed);
  const start = newGame(episodeRandom);
  const { trace, finalState } = runEpisode(creature, snakeLocalAdapter(start, episodeRandom), {
    maxSteps,
  });

  let shaping = 0;
  for (let i = 1; i < trace.length; i++) {
    const prevDistance = manhattan(trace[i - 1].body[0], trace[i - 1].food);
    const newDistance = manhattan(trace[i].body[0], trace[i].food);
    shaping += (prevDistance - newDistance) * DISTANCE_SHAPING_COEFF;
  }

  const score = finalState.eaten * FOOD_REWARD - finalState.steps * STEP_PENALTY -
    (finalState.dead ? DEATH_PENALTY : 0);
  return {
    score,
    fitness: score + shaping,
    eaten: finalState.eaten,
    steps: finalState.steps,
    died: finalState.dead,
    finalState,
  };
}

/** Mean fitness/score/eaten across a list of evaluation seeds. */
export interface MultiEpisodeResult {
  fitness: number;
  score: number;
  eaten: number;
  steps: number;
  maxEaten: number;
}

/** Average a controller's episode results across `seeds`. */
export function evaluateController(
  creature: Creature,
  seeds: readonly number[],
  maxSteps: number = MAX_STEPS,
): MultiEpisodeResult {
  let fitness = 0;
  let score = 0;
  let eaten = 0;
  let steps = 0;
  let maxEaten = 0;
  for (const seed of seeds) {
    const r = scoreController(creature, seed, maxSteps);
    fitness += r.fitness;
    score += r.score;
    eaten += r.eaten;
    steps += r.steps;
    if (r.eaten > maxEaten) maxEaten = r.eaten;
  }
  const n = seeds.length;
  return {
    fitness: fitness / n,
    score: score / n,
    eaten: eaten / n,
    steps: steps / n,
    maxEaten,
  };
}

/**
 * Pick the evaluation seed on which `creature` ate the most food.
 * Ties favour earlier seeds in `seeds`.
 */
export function pickBestReplaySeed(
  creature: Creature,
  seeds: readonly number[] = DEFAULT_EVAL_SEEDS,
  maxSteps: number = MAX_STEPS,
): { seed: number; eaten: number; score: number } {
  let bestSeed = seeds[0];
  let bestEaten = -1;
  let bestScore = -Infinity;
  for (const seed of seeds) {
    const r = scoreController(creature, seed, maxSteps);
    if (
      r.eaten > bestEaten ||
      (r.eaten === bestEaten && r.score > bestScore)
    ) {
      bestEaten = r.eaten;
      bestScore = r.score;
      bestSeed = seed;
    }
  }
  return { seed: bestSeed, eaten: bestEaten, score: bestScore };
}

/**
 * Replay a creature's run from the same initial state, returning the
 * full state trace (one entry per tick, including the initial state).
 */
export function replayController(
  creature: Creature,
  episodeSeed: number,
  maxSteps: number = MAX_STEPS,
): SnakeState[] {
  const episodeRandom = createDeterministicRandom(episodeSeed);
  const start = newGame(episodeRandom);
  return runEpisode(creature, snakeLocalAdapter(start, episodeRandom), { maxSteps }).trace;
}

// ---- evolveRL driver --------------------------------------------------

/**
 * Convert an `EvolveRLMilestone` from the library into the
 * {@link MilestoneSample} shape consumed by `renderMilestoneChartSVG`.
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
 * against a {@link SnakeAdapter}. Mutation, crossover, elitism,
 * plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #291, replaces #238).
 *
 * Telemetry is collected via NEAT-AI's `statistics: true` option, which
 * surfaces an `EvolveRLMilestone[]` array on the run summary covering
 * generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then powers
 * of ten. Per issue #298 the example registers **no `onTrainingEvent`
 * handler** — milestone statistics are the only telemetry channel
 * NEAT-AI exposes.
 */
export async function evolveSnakeController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const evalSeeds = options.evalSeeds ?? DEFAULT_EVAL_SEEDS;

  const adapter = new SnakeAdapter({
    maxStepsPerEpisode: maxSteps,
    solvedThreshold: SOLVED_THRESHOLD,
  });

  const seedCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);

  // The adapter emits a cumulative episode reward in `[-1, 0]`, so
  // `defaultRewardToError` produces an error of `1 - cappedEaten /
  // SOLVED_THRESHOLD`. The caller's `targetError` already lives in
  // that range, so it passes through unchanged. Negative values (used
  // by tests to force the wall-clock / iterations backstop) are clamped
  // to `0`, the smallest legal value.
  const absoluteTargetError = Math.max(0, options.targetError);

  const loopStart = Date.now();

  const evolveOptions: EvolveRLOptions = {
    seed: options.seed >>> 0,
    populationSize: options.populationSize,
    mutationRate: options.mutationRate,
    targetError: absoluteTargetError,
    timeoutMinutes: options.timeoutMinutes,
    iterations: options.iterations,
    episodesPerCreature: options.trials ?? DEFAULT_EVAL_SEEDS.length,
    statistics: true,
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;

  const milestones: MilestoneSample[] = (result.milestones ?? []).map(toMilestoneSample);

  // Re-score the champion against the example's stable evaluation seed
  // set so the runner can render the SVG playthrough on a known good
  // seed. evolveRL's own internal scoring uses a per-generation seed
  // rotation that the replay path cannot reproduce.
  const evalResult = evaluateController(seedCreature, evalSeeds, maxSteps);
  const pick = pickBestReplaySeed(seedCreature, evalSeeds, maxSteps);
  const replay = scoreController(seedCreature, pick.seed, maxSteps);

  // The shaping signal in `SnakeAdapter` makes `targetError` a useful
  // early-stop knob but a poor proxy for "task solved". The `solved`
  // gate is therefore anchored to the historical
  // {@link SOLVED_THRESHOLD} / {@link SOLVED_AVG_FLOOR} pair, computed
  // post-evolution from the held-out evaluation seeds.
  const targetMet = replay.eaten >= SOLVED_THRESHOLD && evalResult.eaten >= SOLVED_AVG_FLOOR;

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
    bestScore: evalResult.score,
    championEatenAvg: evalResult.eaten,
    championEaten: replay.eaten,
    championSteps: replay.steps,
    championReplaySeed: pick.seed,
    generations: result.generation,
    solved: targetMet,
    wallclockMs,
    stopReason,
    milestones,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/snake_game.svg";

/**
 * Path to the milestone-statistics chart the runner emits — this is
 * the canonical fitness-progression artefact under the milestone-only
 * telemetry policy (issue #298). Replaces the legacy per-generation
 * `snake_game_evolution.svg`, `snake_game/evolution.svg`,
 * `snake_game/fitness.svg`, `snake_game/topology.svg`, and
 * `evolution.csv` artefacts.
 */
export const MILESTONE_SVG_PATH = "docs/screenshots/snake_game_milestones.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🐍 Snake Game Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-snake");

  console.log("🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${DEFAULT_EVOLVE_OPTIONS.targetError} ` +
      `(mean cumulative reward ≥ ${-DEFAULT_EVOLVE_OPTIONS.targetError}), ` +
      `timeoutMinutes=${DEFAULT_EVOLVE_OPTIONS.timeoutMinutes}. ` +
      `Solved gate: best replay eaten ≥ ${SOLVED_THRESHOLD} AND mean eaten ` +
      `≥ ${SOLVED_AVG_FLOOR}.`,
  );

  const result = await evolveSnakeController(DEFAULT_EVOLVE_OPTIONS);

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} Champion ate ${result.championEaten} food on the replay episode ` +
      `(avg=${result.championEatenAvg.toFixed(2)} across ${DEFAULT_EVAL_SEEDS.length} seeds, ` +
      `score=${result.bestScore.toFixed(2)}, generations=${result.generations}, ` +
      `threshold=${SOLVED_THRESHOLD}, stop=${result.stopReason}, ` +
      `wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the animated SVG showing the champion's playthrough on the
  // best-performing eval seed.
  const trace = replayController(result.champion, result.championReplaySeed);
  const svg = renderRunSVG(trace);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  if (result.milestones.length > 0) {
    const milestoneSvg = renderMilestoneChartSVG(result.milestones, {
      title: "Snake — evolveRL Milestones",
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
