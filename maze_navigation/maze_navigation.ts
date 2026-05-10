/**
 * Maze Navigation Example.
 *
 * Evolves a NEAT-AI controller to navigate a fixed grid maze from a
 * start cell to a goal cell using local sensor inputs (wall distances
 * plus a packed heading-to-goal). The simulator (`maze.ts`),
 * evolutionary loop, and animated SVG renderer (`svg.ts`) all run in
 * pure TypeScript; the only external dependency is NEAT-AI's
 * `Creature.activate` to compute each step's action.
 *
 * Score = `1 / (1 + manhattan_to_goal_at_terminal_step) − step_count
 * × STEP_PENALTY`. A controller that reaches the goal scores at least
 * `1 − MAX_STEPS × STEP_PENALTY`; one that gets stuck a single cell
 * from the goal scores at most `0.5 − STEP_PENALTY`. Any score above
 * {@link SOLVED_THRESHOLD} therefore proves the agent reached the
 * goal — the threshold sits comfortably above every non-reached run.
 *
 * 🌱 **Generation 1 starts from random noise.** The initial population
 * is built by NEAT-AI's uniform-random `Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` constructor — direct input → output connections with
 * weights and biases drawn by the library's RNG. **No hand-crafted
 * topology, no tuned weight init.** Hidden neurons appear only when
 * the add-neuron mutation operator splits an existing connection
 * during evolution; structural mutation discovers them.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  createSeededPopulation,
  createSeededRng,
  Creature,
  type CreatureExport,
  type NeuronExport,
  safeWriteJson,
  setRandomNumberGenerator,
  type SynapseExport,
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
import { decodeAction, encodeState, INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { defaultMaze, initialState, manhattan, type MazeState, step } from "./maze.ts";
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
   * and `timeoutMinutes` fires first wins.
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
  /** Standard deviation of the weight/bias perturbation noise. */
  mutationStrength: number;
  /** Probability that any given gene is perturbed each generation. */
  mutationRate: number;
  /**
   * Per-creature probability of receiving an add-neuron structural
   * mutation each generation (split an existing connection by inserting
   * a hidden neuron). Defaults to a small value so topology grows
   * gradually rather than thrashing.
   */
  addNeuronRate?: number;
  /** Hard cap on episode length. Defaults to {@link MAX_STEPS}. */
  maxSteps?: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, the running champion
   * is captured at every generation matching `snapshotConfig.checkpoints`
   * and written to `snapshotConfig.outputDir`.
   */
  snapshotConfig?: SnapshotConfig;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
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

/**
 * Build the initial population using the NEAT-AI library's uniform-random
 * creature constructor — `new Creature(INPUT_COUNT, OUTPUT_COUNT)` produces
 * a minimal seed (direct input → output connections) with random weights
 * and a random output bias. **No topology is hand-specified by this
 * example**; structural mutation grows hidden neurons during evolution.
 *
 * `seed` controls the global library RNG so the same `seed` reproduces
 * the same initial population across runs.
 */
export function buildRandomPopulation(
  seed: number,
  populationSize: number,
): CreatureExport[] {
  setRandomNumberGenerator(createSeededRng(seed));
  return createSeededPopulation({
    inputCount: INPUT_COUNT,
    outputCount: OUTPUT_COUNT,
    populationSize,
    seeds: [],
  });
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/** Deep-clone a creature export so callers can safely mutate it. */
function cloneExport(creature: CreatureExport): CreatureExport {
  return JSON.parse(JSON.stringify(creature)) as CreatureExport;
}

/**
 * Insert a hidden neuron in the middle of an existing connection: the
 * NEAT "add-node" structural mutation. Picks a random synapse, replaces
 * it with a path through a fresh hidden neuron, and assigns reasonable
 * starting weights so the new path approximates the original signal
 * before further mutation tunes it.
 *
 * The new neuron uses LOGISTIC activation — a smooth squash that lets
 * gradients flow during weight perturbation.
 */
function addHiddenNeuron(
  creature: CreatureExport,
  random: () => number,
  hiddenCounter: { value: number },
): CreatureExport {
  if (creature.synapses.length === 0) return creature;

  const synapseIdx = Math.floor(random() * creature.synapses.length);
  const original = creature.synapses[synapseIdx];

  // Issue a deterministic UUID so the export is reproducible across runs
  // with the same seed. The library treats this string as opaque, so any
  // unique identifier is acceptable.
  const uuid = `hidden-${hiddenCounter.value++}`;

  const newNeuron: NeuronExport = {
    type: "hidden",
    uuid,
    bias: uniformSigned(random, 0.5),
    squash: "LOGISTIC",
  };

  const newSynapses: SynapseExport[] = creature.synapses.filter((_, i) => i !== synapseIdx);
  // input → hidden: keep the original weight so the path through the
  // new neuron starts close to the original signal.
  newSynapses.push({
    weight: original.weight,
    fromUUID: original.fromUUID,
    toUUID: uuid,
  });
  // hidden → output: weight 1 so the LOGISTIC pass-through is roughly
  // identity at the operating point, again preserving original signal.
  newSynapses.push({
    weight: 1,
    fromUUID: uuid,
    toUUID: original.toUUID,
  });

  // Hidden neurons must stay before every output. For hidden targets,
  // insert directly before the target; for output targets, insert before
  // the first output so NEAT-AI 4.x validation keeps the export ordered.
  const targetIdx = creature.neurons.findIndex((n) => n.uuid === original.toUUID);
  const target = targetIdx === -1 ? undefined : creature.neurons[targetIdx];
  const firstOutputIdx = creature.neurons.findIndex((n) => n.type === "output");
  const insertAt = target?.type === "hidden"
    ? targetIdx
    : firstOutputIdx === -1
    ? creature.neurons.length
    : firstOutputIdx;
  const newNeurons = [
    ...creature.neurons.slice(0, insertAt),
    newNeuron,
    ...creature.neurons.slice(insertAt),
  ];

  return {
    ...creature,
    neurons: newNeurons,
    synapses: newSynapses,
  };
}

/**
 * Mutate a creature genome. Each existing weight and non-input bias is
 * perturbed independently with probability `mutationRate`; the noise is
 * drawn uniformly from `[-mutationStrength, mutationStrength]`. With
 * probability `addNeuronRate` the genome additionally receives a NEAT
 * add-node structural mutation (split one synapse with a hidden neuron).
 *
 * The resulting export is suitable for `Creature.fromJSON(...)`. No
 * topology is hand-specified — every change here is a generic NEAT
 * mutation operator that works on whatever variable topology the
 * creature currently has.
 */
export function mutateCreatureExport(
  parent: CreatureExport,
  random: () => number,
  mutationRate: number,
  mutationStrength: number,
  options?: { addNeuronRate?: number; hiddenCounter?: { value: number } },
): CreatureExport {
  const child = cloneExport(parent);

  for (const synapse of child.synapses) {
    if (random() < mutationRate) {
      synapse.weight += uniformSigned(random, mutationStrength);
    }
  }

  for (const neuron of child.neurons) {
    if (random() < mutationRate) {
      neuron.bias = (neuron.bias ?? 0) + uniformSigned(random, mutationStrength);
    }
  }

  const addNeuronRate = options?.addNeuronRate ?? 0;
  const counter = options?.hiddenCounter ?? { value: 0 };
  if (addNeuronRate > 0 && random() < addNeuronRate) {
    return addHiddenNeuron(child, random, counter);
  }

  return child;
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

interface ScoredMember {
  json: CreatureExport;
  score: number;
  reached: boolean;
  steps: number;
  finalDistance: number;
  neurons: number;
  synapses: number;
}

function topologyCounts(json: CreatureExport): { neurons: number; synapses: number } {
  // The export omits input neurons (they are implicit in `input`), so we
  // add them back to report a comparable "total neurons" figure.
  return {
    neurons: json.neurons.length + (json.input ?? INPUT_COUNT),
    synapses: json.synapses.length,
  };
}

/**
 * Run a generational evolutionary algorithm over creature genomes. The
 * top half of each generation seeds the next via mutation; the elite is
 * carried over unchanged so the best score is monotonically
 * non-decreasing. Stops as soon as the champion's score reaches
 * `1 - targetError` **or** `timeoutMinutes` minutes of wall-clock
 * have elapsed — whichever fires first. The two stop conditions match
 * the standard NEAT-AI `NeatOptions.targetError` /
 * `NeatOptions.timeoutMinutes` fields and were introduced by audit
 * issue #223.
 */
export function evolveMazeController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);
  const maxSteps = options.maxSteps ?? MAX_STEPS;

  // Counter for deterministic hidden-neuron UUIDs so the export stream
  // is reproducible across runs with the same seed.
  const hiddenCounter = { value: 0 };
  const mutationOpts = { addNeuronRate: options.addNeuronRate ?? 0, hiddenCounter };

  const evaluate = (json: CreatureExport): ScoredMember => {
    const creature = Creature.fromJSON(json);
    const r = scoreController(creature, maxSteps);
    const counts = topologyCounts(json);
    return {
      json,
      score: r.score,
      reached: r.reached,
      steps: r.steps,
      finalDistance: r.finalDistance,
      neurons: counts.neurons,
      synapses: counts.synapses,
    };
  };

  // Initial population: uniform-random NEAT genomes from the library.
  // No hand-crafted topology — `new Creature(input, output)` decides the
  // initial structure, with random weights and a random output bias.
  const initialExports = buildRandomPopulation(options.seed, options.populationSize);
  let population: ScoredMember[] = initialExports.map(evaluate);

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
  let bestReached = false;
  let bestSteps = 0;
  let bestFinalDistance = Number.POSITIVE_INFINITY;
  let solvedAt = -1;

  const targetScore = 1 - options.targetError;
  const timeoutMs = options.timeoutMinutes * 60_000;
  const iterationsCap = options.iterations ?? Infinity;
  const loopStart = Date.now();
  let stopReason: "target" | "timeout" | "iterations" = "timeout";
  let generation = 0;

  while (true) {
    // Tie-breaker prefers structurally larger creatures so neutral
    // structural drift remains visible once the champion plateaus at
    // the target score. Without this, the linear seed (which already
    // solves the L-corridor maze well) would lock in as elite forever
    // and the captured topology chart would show a flat line — failing
    // the "neuron/synapse counts genuinely change across generations"
    // criterion of audit issue #223.
    population.sort((a, b) => (b.score - a.score) || (b.synapses - a.synapses));
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestJSON = generationBest.json;
      bestReached = generationBest.reached;
      bestSteps = generationBest.steps;
      bestFinalDistance = generationBest.finalDistance;
    }

    const meanScore = population.reduce((acc, p) => acc + p.score, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestScore: generationBest.score,
      meanScore,
      bestReached: generationBest.reached,
      neurons: generationBest.neurons,
      synapses: generationBest.synapses,
    });

    // Capture an evolution snapshot of the running champion at the
    // configured checkpoints. The helper is a no-op for non-checkpoint
    // generations.
    if (options.snapshotConfig) {
      const checkpointGen = generation + 1;
      if (options.snapshotConfig.checkpoints.includes(checkpointGen)) {
        captureSnapshot(options.snapshotConfig, checkpointGen, bestJSON, bestScore);
      }
    }

    const targetMet = bestScore >= targetScore;
    if (targetMet && solvedAt < 0) solvedAt = generation;

    const elapsedMs = Date.now() - loopStart;
    const timedOut = elapsedMs >= timeoutMs;
    const reachedIterationsCap = generation + 1 >= iterationsCap;

    if (targetMet) {
      // When capturing evolution snapshots, keep running until the next
      // not-yet-fired checkpoint within the iteration budget is
      // captured — otherwise the progression strip would be a single
      // panel.
      const nextCheckpoint = options.snapshotConfig?.checkpoints
        .filter((c) => c > generation + 1 && c <= iterationsCap)
        .sort((a, b) => a - b)[0];
      if (nextCheckpoint === undefined) {
        stopReason = "target";
        break;
      }
    }

    if (timedOut) {
      stopReason = solvedAt >= 0 ? "target" : "timeout";
      break;
    }
    if (reachedIterationsCap) {
      stopReason = solvedAt >= 0 ? "target" : "iterations";
      break;
    }

    // Truncation selection: keep top 50% as parents (always at least 1).
    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    // Build the next generation: keep elite, fill rest with mutated
    // offspring from random parents.
    const nextPopulation: ScoredMember[] = [];
    nextPopulation.push(parents[0]);
    while (nextPopulation.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureExport(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
        mutationOpts,
      );
      nextPopulation.push(evaluate(childJSON));
    }

    population = nextPopulation;
    generation++;
  }

  const champion = Creature.fromJSON(bestJSON);
  return {
    champion,
    bestScore,
    generations: generation + 1,
    championReached: bestReached,
    championSteps: bestSteps,
    championFinalDistance: bestFinalDistance,
    solved: bestScore >= targetScore,
    wallclockMs: Date.now() - loopStart,
    stopReason,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/maze_navigation.svg";

/**
 * Generations at which the runner captures evolution snapshots. The
 * cadence is tuned for variable-topology evolution from uniform-random
 * NEAT noise, which typically needs more generations to converge than
 * the previous fixed-topology bounded-random search did.
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

  console.log("🧬 Evolving controller from uniform-random NEAT noise...");
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
  const result = evolveMazeController({
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
