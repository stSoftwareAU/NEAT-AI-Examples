/**
 * Maze Navigation Example.
 *
 * Evolves a NEAT-AI controller to navigate a fixed grid maze from a
 * start cell to a goal cell using local sensor inputs (wall distances
 * plus a packed heading-to-goal). The simulator (`maze.ts`) and the
 * animated SVG renderer (`svg.ts`) run in pure TypeScript; the
 * evolutionary loop is driven entirely by NEAT-AI's class-shaped
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
 *
 * 📈 **Progress is reported as milestone statistics.** Per issue #298
 * NEAT-AI surfaces only milestone-cadence telemetry (`evolverl_milestone`
 * events at generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then
 * powers of ten). This example collects the milestone payloads returned
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
  type StepResult,
} from "@stsoftware/neat-ai";

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
  /**
   * Optional pre-seeded creature export, used by the multi-run resume
   * flow to continue evolution from a prior champion. When supplied,
   * the evolveRL seed is built via {@link Creature.fromJSON} instead of
   * the uniform-random `new Creature(INPUT_COUNT, OUTPUT_COUNT)`. When
   * absent the first generation starts from random noise (the default
   * for a `--fresh` run).
   */
  seedCreatureExport?: CreatureExport;
  /**
   * Optional directory for NEAT-AI's experiment store. When supplied,
   * `evolveRL` reads and writes creatures under this path instead of the
   * shared default, isolating the run from prior experiments. Pass a
   * fresh temp directory in tests to prevent disk-cache pollution from
   * parallel evolveRL runs.
   */
  experimentStore?: string;
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
  /**
   * Milestone payloads collected via `evolveRL`'s `statistics: true`
   * option, surfaced in the schedule documented by
   * {@link MilestoneSample}. Per issue #298 this is the only telemetry
   * channel NEAT-AI exposes — see {@link MULTI_RUN_ERROR_SVG_PATH} for
   * the rendered chart.
   */
  milestones: MilestoneSample[];
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
 * against a {@link MazeAdapter}. Mutation, crossover, elitism, plateau
 * detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (issue #239).
 *
 * Telemetry is collected via NEAT-AI's `statistics: true` option, which
 * surfaces an `EvolveRLMilestone[]` array on the run summary covering
 * generations `1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then powers
 * of ten. Per issue #298 the example registers **no `onTrainingEvent`
 * handler** — milestone statistics are the only telemetry channel
 * NEAT-AI exposes.
 */
export async function evolveMazeController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const adapter = new MazeAdapter({ maxStepsPerEpisode: maxSteps });

  // When `seedCreatureExport` is supplied (multi-run resume), build the
  // seed via `Creature.fromJSON` so the prior champion's topology and
  // weights carry forward. Otherwise fall back to the uniform-random
  // minimal genome — the standard noise → competent seeding for a fresh
  // run.
  const seedCreature = options.seedCreatureExport !== undefined
    ? Creature.fromJSON(options.seedCreatureExport)
    : new Creature(INPUT_COUNT, OUTPUT_COUNT);

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
    threads: 1,
    // Isolate the experiment store when the caller requests it, so the
    // run is not influenced by creatures written by prior parallel runs.
    experimentStore: options.experimentStore,
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);

  const wallclockMs = Date.now() - loopStart;

  const milestones: MilestoneSample[] = (result.milestones ?? []).map(toMilestoneSample);

  // Score the champion by replaying it on the deterministic maze so
  // the EvolveResult's reached / steps / finalDistance fields stay
  // exact regardless of how evolveRL aggregated rewards internally.
  const championRun = scoreController(seedCreature, maxSteps);

  const targetScore = 1 - absoluteTargetError;
  const targetMet = championRun.score >= targetScore;

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
    bestScore: championRun.score,
    generations: result.generation,
    championReached: championRun.reached,
    championSteps: championRun.steps,
    championFinalDistance: championRun.finalDistance,
    solved: targetMet,
    wallclockMs,
    stopReason,
    milestones,
  };
}

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "maze_navigation";

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/maze_navigation.svg";

/**
 * Path to the multi-run error-curve chart the runner emits — error vs
 * cumulative generation across every run, with faint run-boundary guide
 * lines. Replaces the legacy single-run milestone chart (issue #322).
 */
export const MULTI_RUN_ERROR_SVG_PATH = "docs/screenshots/maze_navigation/milestones.svg";

/**
 * Path to the multi-run complexity chart the runner emits — neurons +
 * synapses vs cumulative generation across every run.
 */
export const MULTI_RUN_COMPLEXITY_SVG_PATH = "docs/screenshots/maze_navigation/complexity.svg";

/**
 * Default `targetError` for a multi-run invocation. Tighter than the
 * legacy `1 - SOLVED_THRESHOLD = 0.4` because multi-run mode is intended
 * to keep polishing the champion across repeated invocations — the
 * agreed default is `0.01` (issue #322).
 */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = 0.01;

/**
 * Default wall-clock budget for a single multi-run invocation, in
 * minutes. Five minutes matches the audit-mandated stop condition
 * (issue #223) and the issue #322 default.
 */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/** Options accepted by {@link runMultiRunMaze}. */
export interface RunMultiRunMazeOptions {
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
 * Convert a maze `EvolveRLMilestone` into a {@link NewMultiRunSample}.
 *
 * `EvolveRLMilestone.bestScore` is the cumulative reward (per-episode
 * mean) reported by NEAT-AI's RL fitness, which for this adapter sits
 * in `[-1, 0]` (the adapter emits a terminal reward
 * `max(-1, mazeScore - 1)` and zero otherwise). NEAT-AI's
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
export async function runMultiRunMaze(
  options: RunMultiRunMazeOptions = {},
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

  const evolveResult = await evolveMazeController(evolveOptions);

  // Map each library milestone into the multi-run sample shape via the
  // exported helper so the conversion stays in one place. `bestScore`
  // is the per-episode mean cumulative reward in `[-1, 0]` for the maze
  // adapter; `milestoneToMultiRunSample` handles the error mapping.
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
      title: "Maze Navigation — multi-run error vs cumulative generations",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

    const complexitySvg = renderMultiRunComplexityChartSVG(merged.milestones, {
      title: "Maze Navigation — multi-run creature complexity",
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

  console.log("🗺️  Maze Navigation Example (multi-run)");
  console.log("");

  const { creaturesDir, outputDir } = setupWorkingDirs(".synthetic-maze");

  // CI/quality quick mode (mirrors the `LUNAR_QUICK=1` idiom). When the
  // runner is invoked with `MAZE_QUICK=1` (env var) the multi-run state
  // and chart SVGs are written under a temp directory so the canonical
  // docs artefacts checked into the repo are never overwritten by a CI
  // run, and `iterations: 3` forces the evolutionary loop to exit via
  // the generation cap well inside `quality.sh`'s per-section budget.
  const quick = Deno.env.get("MAZE_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "maze_quick_" });
    console.log(
      "⚡ Quick mode (MAZE_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
  }
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  console.log("🧬 Evolving controller via Creature.evolveRL()...");
  console.log(
    `   Stop conditions: targetError=${targetError} ` +
      `(target score ≥ ${(1 - targetError).toFixed(3)}), ` +
      `timeoutMinutes=${timeoutMinutes}` +
      (quick ? ", iterations=3 (quick mode)" : ""),
  );

  const multi = await runMultiRunMaze({
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
    `\n${verdictIcon} Champion ` +
      `${result.championReached ? "reached the goal" : "did not reach the goal"} ` +
      `in ${result.championSteps} steps (final distance ${result.championFinalDistance}, ` +
      `score=${result.bestScore.toFixed(3)}, generations=${result.generations}, ` +
      `threshold=${SOLVED_THRESHOLD}, stop=${result.stopReason}, ` +
      `wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // The champion creature is persisted by `runMultiRunMaze` under
  // `docs/data/maze_navigation/creature.json`. Also drop a copy under
  // the example's working directory for ad-hoc inspection.
  const championPath = join(creaturesDir, "champion.json");
  await Deno.writeTextFile(championPath, JSON.stringify(result.champion.exportJSON(), null, 2));
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

  // Render the animated SVG showing the champion's playthrough. Quick
  // mode keeps this under the temp directory so a CI invocation never
  // overwrites the canonical docs screenshot.
  const svg = renderRunSVG(trace);
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(join(tmpScreenshots, "maze_navigation.svg"), svg);
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
