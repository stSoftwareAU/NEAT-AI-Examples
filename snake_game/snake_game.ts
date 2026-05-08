/**
 * Snake Game Example.
 *
 * Evolves a NEAT-AI controller to play the classic Snake grid game.
 * Each agent observes a small sensor pack (wall distances, food
 * direction, tail direction, length — see `agent.ts`) and emits four
 * logistic activations, one per heading; the argmax becomes the next
 * heading. The simulator (`snake.ts`), evolutionary loop, and
 * animated SVG renderer (`svg.ts`) all run in pure TypeScript; the
 * only external dependency is NEAT-AI's `Creature.activate`.
 *
 * Score = `food × FOOD_REWARD − stepCount × STEP_PENALTY` minus a
 * one-off `DEATH_PENALTY` if the snake collided with a wall or
 * itself. Survival without eating cannot out-score eating quickly,
 * because the per-step penalty only adds up over time.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import { decodeAction, encodeState, INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { newGame, type SnakeState, step } from "./snake.ts";
import { renderRunSVG } from "./svg.ts";

/** Index of the first output neuron. */
const FIRST_OUTPUT_INDEX = INPUT_COUNT;

/** Hard cap on the number of ticks a single episode is allowed. */
export const MAX_STEPS = 500;

/** Score reward per food item eaten. */
export const FOOD_REWARD = 100;

/** Per-step penalty applied at the end of the episode. */
export const STEP_PENALTY = 0.1;

/** Flat penalty applied when the snake dies (wall or self collision). */
export const DEATH_PENALTY = 50;

/** Configuration options for {@link evolveSnakeController}. */
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
  bestEaten: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  champion: Creature;
  bestScore: number;
  generations: number;
  championEaten: number;
  championSteps: number;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 60,
  maxGenerations: 80,
  mutationStrength: 0.6,
  mutationRate: 0.5,
};

/**
 * Build a small linear network: eight inputs feeding directly into
 * four LOGISTIC outputs (one per heading). 32 weights and 4 biases is
 * a compact search space that captures simple "head toward food while
 * avoiding walls" policies without inflating evolution time.
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
  eaten: number;
  steps: number;
  died: boolean;
  finalState: SnakeState;
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
  let state = newGame(episodeRandom);
  for (let i = 0; i < maxSteps; i++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action, episodeRandom);
    if (state.dead) break;
  }
  const score = state.eaten * FOOD_REWARD - state.steps * STEP_PENALTY -
    (state.dead ? DEATH_PENALTY : 0);
  return {
    score,
    eaten: state.eaten,
    steps: state.steps,
    died: state.dead,
    finalState: state,
  };
}

/**
 * Replay a creature's run from the same initial state, returning the
 * full state trace (one entry per tick, including the initial state)
 * suitable for the SVG renderer.
 */
export function replayController(
  creature: Creature,
  episodeSeed: number,
  maxSteps: number = MAX_STEPS,
): SnakeState[] {
  const episodeRandom = createDeterministicRandom(episodeSeed);
  let state = newGame(episodeRandom);
  const trace: SnakeState[] = [state];
  for (let i = 0; i < maxSteps; i++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action, episodeRandom);
    trace.push(state);
    if (state.dead) break;
  }
  return trace;
}

/**
 * Run a generational evolutionary algorithm. Truncation selection
 * keeps the top half as parents; the elite carries over so the best
 * score is monotonically non-decreasing.
 */
export function evolveSnakeController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  // Pick a fixed episode seed for the whole run so every creature
  // faces the same initial conditions.
  const episodeSeed = options.seed ^ 0x5eed;

  let population: Array<{
    json: LegacyCreatureJSON;
    score: number;
    eaten: number;
    steps: number;
  }> = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const r = scoreController(creature, episodeSeed, maxSteps);
    population.push({ json, score: r.score, eaten: r.eaten, steps: r.steps });
  }

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
  let bestEaten = 0;
  let bestSteps = 0;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.score - a.score);
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestJSON = generationBest.json;
      bestEaten = generationBest.eaten;
      bestSteps = generationBest.steps;
    }

    const meanScore = population.reduce((acc, p) => acc + p.score, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestScore: generationBest.score,
      meanScore,
      bestEaten: generationBest.eaten,
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
      const r = scoreController(childCreature, episodeSeed, maxSteps);
      next.push({ json: childJSON, score: r.score, eaten: r.eaten, steps: r.steps });
    }
    population = next;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestScore,
    generations: options.maxGenerations,
    championEaten: bestEaten,
    championSteps: bestSteps,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/snake_game.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🐍 Snake Game Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-snake");

  console.log("🧬 Evolving controller...");
  const result = evolveSnakeController({
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestScore, meanScore, bestEaten }) => {
      if (generation % 5 === 0) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  ` +
            `best=${bestScore.toFixed(1).padStart(8)}  ` +
            `mean=${meanScore.toFixed(1).padStart(8)}  ` +
            `eaten=${bestEaten}`,
        );
      }
    },
  });

  const verdictIcon = result.championEaten > 0 ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} Champion ate ${result.championEaten} food in ${result.championSteps} steps ` +
      `(score=${result.bestScore.toFixed(2)}, generations=${result.generations}).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the animated SVG showing the champion's playthrough.
  const episodeSeed = DEFAULT_EVOLVE_OPTIONS.seed ^ 0x5eed;
  const trace = replayController(result.champion, episodeSeed);
  const svg = renderRunSVG(trace);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
