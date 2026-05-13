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
  safeWriteJson,
  type StepResult,
} from "@stsoftware/neat-ai";

import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type MilestoneSample, renderMilestoneChartSVG } from "../common/milestone_chart.ts";
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
   * channel NEAT-AI exposes — see {@link MILESTONE_SVG_PATH} for the
   * rendered chart.
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

  const seedCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);

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

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/maze_navigation.svg";

/**
 * Path to the milestone-statistics chart the runner emits — this is the
 * canonical fitness-progression artefact under the
 * milestone-only telemetry policy (issue #298).
 */
export const MILESTONE_SVG_PATH = "docs/screenshots/maze_navigation_milestones.svg";

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

  const result = await evolveMazeController(DEFAULT_EVOLVE_OPTIONS);

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

  if (result.milestones.length > 0) {
    const milestoneSvg = renderMilestoneChartSVG(result.milestones, {
      title: "Maze Navigation — evolveRL Milestones",
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
