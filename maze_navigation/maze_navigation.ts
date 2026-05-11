/**
 * Maze Navigation Example.
 *
 * Evolves a NEAT-AI controller to navigate a fixed grid maze from a
 * start cell to a goal cell using local sensor inputs (wall distances
 * plus a packed heading-to-goal). The simulator (`maze.ts`) and the
 * animated SVG renderer (`svg.ts`) run in pure TypeScript; the
 * evolutionary loop is now driven entirely by NEAT-AI's class-shaped
 * `Creature.evolveRL()` API (issue #239, depends on
 * `stSoftwareAU/NEAT-AI#2630` and library version `5.0.0`).
 *
 * Score = `1 / (1 + manhattan_to_goal_at_terminal_step) − step_count
 * × STEP_PENALTY`. A controller that reaches the goal scores at least
 * `1 − MAX_STEPS × STEP_PENALTY`; one that gets stuck a single cell
 * from the goal scores at most `0.5 − STEP_PENALTY`. Any score above
 * {@link SOLVED_THRESHOLD} therefore proves the agent reached the
 * goal — the threshold sits comfortably above every non-reached run.
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

import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  captureSnapshot,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import { decodeAction, encodeState, INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { defaultMaze, initialState, manhattan, type MazeState, step } from "./maze.ts";
import type { Action } from "./maze.ts";
import { renderRunSVG } from "./svg.ts";

/** Hard cap on the number of ticks a single episode is allowed. */
export const MAX_STEPS = 200;

/** Penalty applied per step taken (subtracted from the terminal score). */
export const STEP_PENALTY = 0.001;

/**
 * Score threshold at or above which the controller is declared
 * "solved". Reaching the goal scores at least
 * `1 − MAX_STEPS × STEP_PENALTY = 0.8`; the worst non-reached run
 * (one cell short of the goal) scores at most
 * `1 / 2 − STEP_PENALTY = 0.499`. Any score ≥ 0.6 therefore guarantees
 * the agent reached the goal — the threshold sits comfortably between
 * the two regimes so the test cannot mistake a near-miss for a win.
 */
export const SOLVED_THRESHOLD = 0.6;

/** Configuration options for {@link evolveMazeController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /**
   * NEAT-AI standard target-error stop condition (audit issue #223).
   * Evolution halts as soon as the champion's score reaches
   * `1 - targetError`. Default `1 - SOLVED_THRESHOLD = 0.4`, which
   * matches {@link SOLVED_THRESHOLD} so the existing "solved" definition
   * is preserved exactly.
   */
  targetError: number;
  /**
   * NEAT-AI standard wall-clock stop condition (audit issue #223).
   * Evolution halts when the elapsed time since the loop began exceeds
   * `timeoutMinutes` minutes (default `5`). Whichever of `targetError`
   * and `timeoutMinutes` fires first wins. NEAT-AI 5.0.0 requires this
   * to be an integer ≥ 1 — sub-minute budgets are no longer
   * expressible; use `iterations` instead for fast unit tests.
   */
  timeoutMinutes: number;
  /**
   * Optional generation cap (NEAT-AI's standard `iterations` option).
   * When supplied, the loop will also stop once the next-to-be-run
   * generation reaches this value — useful for fast unit tests that
   * need a deterministic generation count without depending on
   * wall-clock timing. Defaults to `Infinity` so production runs are
   * bounded only by `targetError` and `timeoutMinutes`.
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
  /** Hard cap on episode length. Defaults to {@link MAX_STEPS}. */
  maxSteps?: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, a snapshot of the
   * seed creature is captured if generation `1` is a checkpoint, and a
   * snapshot of the final champion is captured at the final
   * generation. Mid-run intermediate generations are no longer captured
   * because `Creature.evolveRL()` does not expose mid-run creature
   * exports — see issue #239 for the migration trade-offs.
   */
  snapshotConfig?: SnapshotConfig;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
  /**
   * `true` when this generation's best member reached the goal. Derived
   * from `bestScore ≥ 0.5` — the maze score is bounded above `0.5` only
   * when `finalDistance === 0`, so this is a faithful reconstruction of
   * the historical contract from the new evolveRL telemetry.
   */
  bestReached: boolean;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  champion: Creature;
  bestScore: number;
  /** Number of generations actually run before stopping. */
  generations: number;
  championReached: boolean;
  championSteps: number;
  championFinalDistance: number;
  /** True when the champion's score reached `1 - targetError`. */
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
 * - `targetError = 1 - SOLVED_THRESHOLD = 0.4` makes the target score
 *   `1 - 0.4 = 0.6 = SOLVED_THRESHOLD`, preserving the existing
 *   "solved" definition exactly.
 * - `timeoutMinutes = 5` is the audit-mandated wall-clock backstop
 *   (audit issue #223). The default seed solves the L-corridor maze
 *   well within the budget on a commodity laptop.
 */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 80,
  // NEAT-AI standard stop conditions: evolution halts as soon as the
  // champion's score reaches `1 - targetError` (default 0.6) OR
  // `timeoutMinutes` minutes have elapsed since the loop began —
  // whichever fires first.
  targetError: 1 - SOLVED_THRESHOLD,
  timeoutMinutes: 5,
  mutationStrength: 0.6,
  mutationRate: 0.5,
  addNeuronRate: 0.03,
};

/** Adapter configuration consumed by {@link MazeAdapter}. */
export interface MazeAdapterOptions {
  /** Cap on the number of simulator ticks per episode. Default {@link MAX_STEPS}. */
  maxStepsPerEpisode?: number;
}

/** State threaded through each episode by {@link MazeAdapter}. */
export interface MazeEpisodeState {
  /** Current simulator state. */
  maze: MazeState;
  /** 1-based step index of the just-completed step (`0` after `reset`). */
  stepIdx: number;
}

/**
 * Maze episode adapter for `Creature.evolveRL()`. Each `step()`
 * advances the deterministic maze simulator, encodes the observation
 * as a `Float32Array`, and emits a reward designed to map cleanly onto
 * NEAT-AI's non-negative `error` slot via `defaultRewardToError`
 * (`error = max(0, -reward)`):
 *
 * - Non-terminal step: reward `0`.
 * - Terminal step (agent reached the goal or hit the per-episode step
 *   cap): reward `score - 1`, where `score = 1 / (1 + finalDistance) -
 *   steps × STEP_PENALTY`. Score sits in `[0, 1]`, so the reward sits
 *   in `[-1, 0]` and `defaultRewardToError` produces an `error` in
 *   `[0, 1]` equal to `1 - score`.
 *
 * Because the maze is fully deterministic (no perturbation, no
 * environmental noise), the same creature scores identically across
 * every seed — `episodesPerCreature` therefore defaults to `1` so we
 * do not waste evaluations on repeated rollouts.
 */
export class MazeAdapter extends EpisodeAdapter<MazeEpisodeState, Action> {
  readonly maxStepsPerEpisode: number;

  constructor(options: MazeAdapterOptions = {}) {
    super();
    this.maxStepsPerEpisode = options.maxStepsPerEpisode ?? MAX_STEPS;
  }

  override get observationLength(): number {
    return INPUT_COUNT;
  }

  override maxSteps(): number {
    return this.maxStepsPerEpisode;
  }

  override reset(
    _rngSeed: number,
  ): { observation: Float32Array; state: MazeEpisodeState } {
    // Maze is fully deterministic — the seed is irrelevant. Every
    // episode starts at the maze's `start` cell.
    const maze = initialState(defaultMaze());
    return {
      observation: encodeState(maze),
      state: { maze, stepIdx: 0 },
    };
  }

  override decodeAction(
    creatureOutput: Float32Array,
    _state: MazeEpisodeState,
  ): Action {
    return decodeAction(creatureOutput);
  }

  override step(
    state: MazeEpisodeState,
    action: Action,
  ): StepResult<Float32Array> & { state: MazeEpisodeState } {
    const newMaze = step(state.maze, action);
    const newStepIdx = state.stepIdx + 1;
    const reached = newMaze.reached;
    const atCap = newStepIdx >= this.maxStepsPerEpisode;
    const terminated = reached || atCap;
    let reward = 0;
    if (terminated) {
      const finalDistance = manhattan(newMaze.position, newMaze.maze.goal);
      const score = 1 / (1 + finalDistance) - newStepIdx * STEP_PENALTY;
      // Score can dip below 0 when the agent fails to make progress (a
      // distant final cell costs `MAX_STEPS × STEP_PENALTY`). Clamp the
      // reward into `[-1, 0]` so `defaultRewardToError` produces a
      // valid `[0, 1]` error — runs scoring below `0` simply saturate
      // at the worst legal error of `1`.
      reward = Math.max(-1, score - 1);
    }
    return {
      state: { maze: newMaze, stepIdx: newStepIdx },
      observation: encodeState(newMaze),
      reward,
      terminated,
      truncated: false,
    };
  }
}

/** Outcome of a single scoring episode. */
export interface EpisodeResult {
  score: number;
  reached: boolean;
  steps: number;
  finalDistance: number;
  finalState: MazeState;
}

/**
 * Play one episode and score the controller. Each agent starts at
 * the maze's start cell; the simulator runs until the agent reaches
 * the goal or the step cap fires.
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): EpisodeResult {
  const maze = defaultMaze();
  let state = initialState(maze);
  for (let i = 0; i < maxSteps; i++) {
    if (state.reached) break;
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action);
  }
  const finalDistance = manhattan(state.position, maze.goal);
  const score = 1 / (1 + finalDistance) - state.steps * STEP_PENALTY;
  return {
    score,
    reached: state.reached,
    steps: state.steps,
    finalDistance,
    finalState: state,
  };
}

/**
 * Replay a creature's run, returning the full trajectory (one entry
 * per tick, including the initial state) suitable for the SVG
 * renderer.
 */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): MazeState[] {
  const maze = defaultMaze();
  let state = initialState(maze);
  const trace: MazeState[] = [state];
  for (let i = 0; i < maxSteps; i++) {
    if (state.reached) break;
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action);
    trace.push(state);
  }
  return trace;
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
 * against a {@link MazeAdapter}. Mutation, crossover, elitism, plateau
 * detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #239).
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
export async function evolveMazeController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const adapter = new MazeAdapter({ maxStepsPerEpisode: maxSteps });

  const seedCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const seedExport = seedCreature.exportJSON();
  const seedNeurons = seedExport.neurons.length + (seedExport.input ?? INPUT_COUNT);
  const seedSynapses = seedExport.synapses.length;

  // Score the seed so the gen-1 snapshot has a representative score.
  const seedResult = scoreController(seedCreature, maxSteps);

  // Capture the seed creature as the gen-1 snapshot so the existing
  // multi-panel SVG renderer still has at least one early-generation
  // panel to draw alongside the final champion.
  if (options.snapshotConfig?.checkpoints.includes(1)) {
    captureSnapshot(options.snapshotConfig, 1, seedExport, seedResult.score);
  }

  const generationData = new Map<number, GenerationBucket>();
  let latestBestNeurons = seedNeurons;
  let latestBestSynapses = seedSynapses;
  let lastObservedGeneration = 0;

  // evolveRL normalised target error — the adapter emits cumulative
  // rewards in `[-1, 0]`, so `defaultRewardToError` produces an error
  // in `[0, 1]` equal to `1 - score`. The caller's `targetError`
  // already lives in that range, so it passes through unchanged.
  // Negative values (used by tests to force the iterations backstop)
  // are clamped to `0`, the smallest legal value.
  const absoluteTargetError = Math.max(0, options.targetError);

  const loopStart = Date.now();

  const evolveOptions: EvolveRLOptions = {
    seed: options.seed >>> 0,
    populationSize: options.populationSize,
    mutationRate: options.mutationRate,
    // NEAT-AI 5.0.0 owns mutation magnitude internally — the historical
    // `mutationStrength` no longer maps onto `mutationAmount` (which is
    // an *integer* count of mutations per offspring, not a perturbation
    // magnitude). The library default is appropriate for the maze.
    targetError: absoluteTargetError,
    timeoutMinutes: options.timeoutMinutes,
    iterations: options.iterations,
    // Deterministic environment — one episode per creature is enough.
    episodesPerCreature: 1,
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
      let neurons: number;
      let synapses: number;
      if (bucket && bucket.meanRewards.length > 0) {
        const sum = bucket.meanRewards.reduce((a, b) => a + b, 0);
        const meanReward = sum / bucket.meanRewards.length;
        // Cumulative reward sits in `[-1, 0]` → score = 1 + reward.
        meanScoreThisGen = 1 + meanReward;
        bestScoreThisGen = 1 + bucket.bestReward;
        neurons = bucket.bestNeurons;
        synapses = bucket.bestSynapses;
      } else {
        // No data this generation (e.g. every creature was an elite cached
        // from a previous round). Fall back to the previous champion's
        // known stats.
        meanScoreThisGen = seedResult.score;
        bestScoreThisGen = seedResult.score;
        neurons = latestBestNeurons;
        synapses = latestBestSynapses;
      }
      const bestReached = bestScoreThisGen >= 0.5;
      options.onGeneration?.({
        generation: generation0,
        bestScore: bestScoreThisGen,
        meanScore: meanScoreThisGen,
        bestReached,
        neurons,
        synapses,
      });
    },
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;
  const finalGeneration = Math.max(lastObservedGeneration, result.generation);

  // Score the champion by replaying it on the deterministic maze so
  // the EvolveResult's reached / steps / finalDistance fields stay
  // exact regardless of how evolveRL aggregated rewards internally.
  const championRun = scoreController(seedCreature, maxSteps);

  // Capture the final champion as the last snapshot if the caller asked
  // for a checkpoint at the final generation (or used the default
  // checkpoint list that includes the final gen).
  if (options.snapshotConfig?.checkpoints.includes(finalGeneration)) {
    captureSnapshot(
      options.snapshotConfig,
      finalGeneration,
      seedCreature.exportJSON(),
      championRun.score,
    );
  } else if (options.snapshotConfig) {
    // Always write a snapshot at the final generation so the multi-panel
    // SVG has a closing frame even when no exact checkpoint matches.
    captureSnapshot(
      { ...options.snapshotConfig, checkpoints: [finalGeneration] },
      finalGeneration,
      seedCreature.exportJSON(),
      championRun.score,
    );
  }

  const targetScore = 1 - absoluteTargetError;
  const targetMet = championRun.score >= targetScore;

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
    bestScore: championRun.score,
    generations: finalGeneration,
    championReached: championRun.reached,
    championSteps: championRun.steps,
    championFinalDistance: championRun.finalDistance,
    solved: targetMet,
    wallclockMs,
    stopReason,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/maze_navigation.svg";

/**
 * Generations at which the runner captures evolution snapshots. Under
 * the new `Creature.evolveRL()`-driven loop the upstream API only
 * exposes the seed creature and the final champion, so only the first
 * entry (`1`) and the run's terminal generation actually produce
 * snapshot files. The remaining entries are retained for backwards
 * compatibility — they are silently ignored.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 50, 150, 300];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-maze/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/maze_navigation_evolution.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/maze_navigation_evolution_chart.svg";

/** Path to the per-generation evolution telemetry CSV (audit issue #223). */
export const EVOLUTION_CSV_PATH = "docs/data/maze_navigation/evolution.csv";

/** Header row for the per-generation telemetry CSV (audit issue #223). */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path (audit issue #223). */
export const FITNESS_SVG_PATH = "docs/screenshots/maze_navigation/fitness.svg";

/** Neuron / synapse count chart path (audit issue #223). */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/maze_navigation/topology.svg";

/**
 * One row of per-generation evolution telemetry. Captured during a run
 * and serialised to {@link EVOLUTION_CSV_PATH} so downstream tools can
 * inspect how the population's fitness and topology evolved over time.
 */
export interface EvolutionRow {
  /** Zero-based generation index. */
  generation: number;
  /** Best score in this generation. */
  bestFitness: number;
  /** Population mean score in this generation. */
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
// fitness" charts requested by audit issue #223.

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
    `aria-label="Maze Navigation — neuron and synapse counts per generation">`,
    `  <title>Maze Navigation — Topology Growth</title>`,
    `  <rect width="${TOPOLOGY_SVG_WIDTH}" height="${TOPOLOGY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TOPOLOGY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Maze Navigation — Topology Growth</text>`,
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

  console.log("🗺️  Maze Navigation Example");
  console.log("");

  const { creaturesDir, outputDir } = setupWorkingDirs(".synthetic-maze");

  console.log("🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${DEFAULT_EVOLVE_OPTIONS.targetError.toFixed(2)} ` +
      `(target score ≥ ${(1 - DEFAULT_EVOLVE_OPTIONS.targetError).toFixed(2)}), ` +
      `timeoutMinutes=${DEFAULT_EVOLVE_OPTIONS.timeoutMinutes}`,
  );
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionRows: EvolutionRow[] = [];
  const evolutionStart = Date.now();
  const result = await evolveMazeController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestScore, meanScore, bestReached, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      evolutionRows.push({
        generation,
        bestFitness: bestScore,
        meanFitness: meanScore,
        neuronCount: neurons,
        synapseCount: synapses,
      });
      if (generation % 10 === 0 || bestScore >= SOLVED_THRESHOLD) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  ` +
            `best=${bestScore.toFixed(3).padStart(8)}  ` +
            `mean=${meanScore.toFixed(3).padStart(8)}  ` +
            `reached=${bestReached ? "✅" : "··"}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} Champion ` +
      `${result.championReached ? "reached the goal" : "did not reach the goal"} ` +
      `in ${result.championSteps} steps (final distance ${result.championFinalDistance}, ` +
      `score=${result.bestScore.toFixed(3)}, generations=${result.generations}, ` +
      `threshold=${SOLVED_THRESHOLD}, stop=${result.stopReason}, ` +
      `wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Replay and save the trajectory log so subsequent inspection runs
  // can rebuild the SVG without re-evolving.
  const trace = replayController(result.champion);
  const trajectoryPath = join(outputDir, "trajectory.json");
  const trajectoryLog = {
    reached: result.championReached,
    steps: result.championSteps,
    finalDistance: result.championFinalDistance,
    positions: trace.map((s) => ({ x: s.position.x, y: s.position.y })),
  };
  await Deno.writeTextFile(trajectoryPath, JSON.stringify(trajectoryLog, null, 2));
  console.log(`📜 Saved trajectory log to ${trajectoryPath}`);

  // Render the animated SVG showing the champion's playthrough.
  const svg = renderRunSVG(trace);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Maze Navigation — Evolution",
      scoreLabel: "best score",
    });
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Per-generation evolution telemetry (audit issue #223): CSV (source
  // of truth) + best/mean fitness chart + neuron/synapse topology chart.
  // All three are emitted on every full run so downstream tools and the
  // README can reuse the same data.
  if (evolutionRows.length > 0) {
    ensureDirSync("docs/data/maze_navigation");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(evolutionRows));
    console.log(`🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${evolutionRows.length} rows)`);

    ensureDirSync("docs/screenshots/maze_navigation");
    const fitnessSamples: FitnessSample[] = evolutionRows.map((r) => ({
      generation: r.generation,
      bestFitness: r.bestFitness,
      avgFitness: r.meanFitness,
    }));
    const fitnessSvg = renderFitnessChartSVG(fitnessSamples, {
      title: "Maze Navigation — Fitness vs Generation",
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
      title: "Maze Navigation — Evolution Progress",
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
