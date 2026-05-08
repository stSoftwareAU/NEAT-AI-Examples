/**
 * Maze Navigation Example.
 *
 * Evolves a NEAT-AI controller to navigate a fixed grid maze from a
 * start cell to a goal cell using local sensor inputs (wall distances
 * plus a packed heading-to-goal). Truncation selection plus per-gene
 * mutation drives a small linear policy (5 inputs, 4 logistic outputs,
 * no hidden layer) toward a successful trajectory.
 *
 * Score = `1 / (1 + manhattan_to_goal_at_terminal_step) − step_count
 * × STEP_PENALTY`. A controller that reaches the goal scores 1 minus
 * the per-step cost; one that gets stuck scores significantly less.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import { decodeAction, encodeState, INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { defaultMaze, initialState, manhattan, type MazeState, step } from "./maze.ts";
import { renderRunSVG } from "./svg.ts";

/** Index of the first output neuron. */
const FIRST_OUTPUT_INDEX = INPUT_COUNT;

/** Hard cap on the number of ticks a single episode is allowed. */
export const MAX_STEPS = 200;

/** Penalty applied per step taken (subtracted from the terminal score). */
export const STEP_PENALTY = 0.001;

/** Configuration options for {@link evolveMazeController}. */
export interface EvolveOptions {
  seed: number;
  populationSize: number;
  maxGenerations: number;
  mutationStrength: number;
  mutationRate: number;
  /** Hard cap on episode length. Defaults to {@link MAX_STEPS}. */
  maxSteps?: number;
  onGeneration?: (info: GenerationInfo) => void;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
  bestReached: boolean;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  champion: Creature;
  bestScore: number;
  generations: number;
  championReached: boolean;
  championSteps: number;
  championFinalDistance: number;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 42,
  populationSize: 80,
  maxGenerations: 60,
  mutationStrength: 0.5,
  mutationRate: 0.4,
};

/**
 * Build a small linear network: five inputs feeding directly into
 * four LOGISTIC outputs (one per cardinal action). 20 weights and 4
 * biases is a compact search space that captures simple "head toward
 * the goal while avoiding walls" policies without inflating evolution
 * time.
 */
export function buildInitialCreatureJSON(
  weights: number[],
  biases: [number, number, number, number],
): LegacyCreatureJSON {
  if (weights.length !== INPUT_COUNT * OUTPUT_COUNT) {
    throw new Error(
      `weights must contain exactly ${INPUT_COUNT * OUTPUT_COUNT} entries, ` +
        `got ${weights.length}`,
    );
  }
  const neurons: LegacyCreatureJSON["neurons"] = [];
  for (let i = 0; i < INPUT_COUNT; i++) {
    neurons.push({ type: "input", squash: "LOGISTIC", index: i, uuid: `input-${i}` });
  }
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    neurons.push({
      type: "output",
      squash: "LOGISTIC",
      index: FIRST_OUTPUT_INDEX + o,
      bias: biases[o],
      uuid: `output-${o}`,
    });
  }
  const synapses: LegacyCreatureJSON["synapses"] = [];
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    for (let i = 0; i < INPUT_COUNT; i++) {
      synapses.push({
        from: i,
        to: FIRST_OUTPUT_INDEX + o,
        weight: weights[o * INPUT_COUNT + i],
      });
    }
  }
  return { neurons, synapses, input: INPUT_COUNT, output: OUTPUT_COUNT };
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/** Random initial creature: weights in `[-1, 1]`, biases in `[-0.5, 0.5]`. */
export function randomCreatureJSON(random: () => number): LegacyCreatureJSON {
  const weights: number[] = [];
  for (let i = 0; i < INPUT_COUNT * OUTPUT_COUNT; i++) {
    weights.push(uniformSigned(random, 1));
  }
  const biases: [number, number, number, number] = [
    uniformSigned(random, 0.5),
    uniformSigned(random, 0.5),
    uniformSigned(random, 0.5),
    uniformSigned(random, 0.5),
  ];
  return buildInitialCreatureJSON(weights, biases);
}

/** Decode a creature export back into its weights and biases. */
export function genesFromCreatureJSON(
  json: LegacyCreatureJSON,
): { weights: number[]; biases: [number, number, number, number] } {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  for (const synapse of json.synapses) {
    const o = synapse.to - FIRST_OUTPUT_INDEX;
    if (o >= 0 && o < OUTPUT_COUNT && synapse.from >= 0 && synapse.from < INPUT_COUNT) {
      weights[o * INPUT_COUNT + synapse.from] = synapse.weight;
    }
  }
  const biases: [number, number, number, number] = [0, 0, 0, 0];
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    const neuron = json.neurons.find((n) => n.uuid === `output-${o}`);
    biases[o] = neuron?.bias ?? 0;
  }
  return { weights, biases };
}

/** Mutate each gene independently with probability `mutationRate`. */
export function mutateCreatureJSON(
  parent: LegacyCreatureJSON,
  random: () => number,
  mutationRate: number,
  mutationStrength: number,
): LegacyCreatureJSON {
  const { weights, biases } = genesFromCreatureJSON(parent);
  const newWeights = weights.map((w) =>
    random() < mutationRate ? w + uniformSigned(random, mutationStrength) : w
  );
  const newBiases = biases.map((b) =>
    random() < mutationRate ? b + uniformSigned(random, mutationStrength) : b
  ) as [number, number, number, number];
  return buildInitialCreatureJSON(newWeights, newBiases);
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
 * Run a generational evolutionary algorithm. Truncation selection
 * keeps the top half as parents; the elite carries over so the best
 * score is monotonically non-decreasing.
 */
export function evolveMazeController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);
  const maxSteps = options.maxSteps ?? MAX_STEPS;

  let population: Array<{
    json: LegacyCreatureJSON;
    score: number;
    reached: boolean;
    steps: number;
    finalDistance: number;
  }> = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const r = scoreController(creature, maxSteps);
    population.push({
      json,
      score: r.score,
      reached: r.reached,
      steps: r.steps,
      finalDistance: r.finalDistance,
    });
  }

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
  let bestReached = false;
  let bestSteps = 0;
  let bestFinalDistance = Number.POSITIVE_INFINITY;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.score - a.score);
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
    });

    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    const next: typeof population = [];
    next.push(parents[0]); // elite
    while (next.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureJSON(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
      );
      const childCreature = Creature.fromJSON(asCreatureExport(childJSON));
      const r = scoreController(childCreature, maxSteps);
      next.push({
        json: childJSON,
        score: r.score,
        reached: r.reached,
        steps: r.steps,
        finalDistance: r.finalDistance,
      });
    }
    population = next;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestScore,
    generations: options.maxGenerations,
    championReached: bestReached,
    championSteps: bestSteps,
    championFinalDistance: bestFinalDistance,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/maze_navigation.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🗺️  Maze Navigation Example");
  console.log("");

  const { creaturesDir, outputDir } = setupWorkingDirs(".synthetic-maze");

  console.log("🧬 Evolving controller...");
  const result = evolveMazeController({
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestScore, meanScore, bestReached }) => {
      if (generation % 5 === 0) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  ` +
            `best=${bestScore.toFixed(3).padStart(8)}  ` +
            `mean=${meanScore.toFixed(3).padStart(8)}  ` +
            `reached=${bestReached ? "✅" : "··"}`,
        );
      }
    },
  });

  const verdictIcon = result.championReached ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} Champion ` +
      `${result.championReached ? "reached the goal" : "did not reach the goal"} ` +
      `in ${result.championSteps} steps (final distance ${result.championFinalDistance}, ` +
      `score=${result.bestScore.toFixed(3)}, generations=${result.generations}).`,
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

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
