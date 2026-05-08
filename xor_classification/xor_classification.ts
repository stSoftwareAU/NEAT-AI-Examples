/**
 * XOR Classification Example
 *
 * Evolves a NEAT-AI creature to learn the XOR truth table — the
 * canonical "Hello World" of neuroevolution. The network has two
 * inputs, two hidden neurons (TANH), and a single LOGISTIC output.
 * The evolutionary loop and scoring all run in pure TypeScript;
 * the only library dependency is `Creature.activate`.
 *
 * Inputs (per sample): `[a, b]` ∈ {0, 1}^2.
 * Output: a scalar in `(0, 1)`. Sample is classified as `1` when the
 * output is `>= 0.5`, else `0`.
 * Fitness: 1 - mean squared error across the four samples (higher is
 * better). The task is "solved" when all four samples are classified
 * correctly.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { renderDecisionBoundarySVG } from "./svg.ts";

/** Number of input features. */
export const INPUT_COUNT = 2;

/** Number of hidden neurons. */
export const HIDDEN_COUNT = 2;

/** Number of outputs. */
export const OUTPUT_COUNT = 1;

/** Index of the first hidden neuron in the legacy index space. */
const FIRST_HIDDEN_INDEX = INPUT_COUNT;
/** Index of the output neuron. */
const OUTPUT_INDEX = INPUT_COUNT + HIDDEN_COUNT;

/** Number of weights in the genome (input→hidden + hidden→output). */
export const WEIGHT_COUNT = INPUT_COUNT * HIDDEN_COUNT + HIDDEN_COUNT * OUTPUT_COUNT;

/** Number of biases in the genome (hidden + output). */
export const BIAS_COUNT = HIDDEN_COUNT + OUTPUT_COUNT;

/** A single XOR sample: two binary inputs and the expected output. */
export interface XorSample {
  inputs: readonly [number, number];
  target: number;
}

/**
 * The full XOR truth table. The four samples are emitted in a fixed
 * order so any test (and the rendered SVG) can rely on the indexing.
 *
 * Note: the issue asks for the samples to be built "deterministically
 * (using common/deterministic_random.ts)". The truth table itself has
 * no randomness — these four values are the entire data set — so
 * {@link xorSamples} simply emits the canonical order. The seeded PRNG
 * is used for the randomised population initialisation and mutation
 * inside {@link evolveXorController}.
 */
export function xorSamples(): XorSample[] {
  return [
    { inputs: [0, 0], target: 0 },
    { inputs: [0, 1], target: 1 },
    { inputs: [1, 0], target: 1 },
    { inputs: [1, 1], target: 0 },
  ];
}

/** Configuration options for {@link evolveXorController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Maximum number of generations before giving up. */
  maxGenerations: number;
  /** Standard deviation of the weight/bias perturbation noise. */
  mutationStrength: number;
  /** Probability that any given gene is perturbed each generation. */
  mutationRate: number;
  /** Mean-squared-error threshold below which the task counts as solved. */
  errorThreshold: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestFitness: number;
  bestError: number;
  meanFitness: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best fitness reached by the champion (1 - MSE). */
  bestFitness: number;
  /** Mean squared error of the champion across the four samples. */
  bestError: number;
  /** Number of generations actually run. */
  generations: number;
  /** True when the champion classifies all four samples correctly. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 60,
  maxGenerations: 200,
  mutationStrength: 0.6,
  mutationRate: 0.4,
  errorThreshold: 0.05,
};

/**
 * Build a fixed-topology creature: two inputs feed two TANH hidden
 * neurons, which feed a single LOGISTIC output. This is the smallest
 * network capable of representing XOR.
 *
 * Layout of the gene vector:
 * - `weights[0..1]` — input 0/1 → hidden 0
 * - `weights[2..3]` — input 0/1 → hidden 1
 * - `weights[4..5]` — hidden 0/1 → output
 * - `biases[0..1]`  — hidden 0/1
 * - `biases[2]`     — output
 */
export function buildInitialCreatureJSON(
  weights: readonly number[],
  biases: readonly number[],
): LegacyCreatureJSON {
  if (weights.length !== WEIGHT_COUNT) {
    throw new Error(`weights must contain exactly ${WEIGHT_COUNT} entries, got ${weights.length}`);
  }
  if (biases.length !== BIAS_COUNT) {
    throw new Error(`biases must contain exactly ${BIAS_COUNT} entries, got ${biases.length}`);
  }
  const neurons: LegacyCreatureJSON["neurons"] = [
    { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
    { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
    {
      type: "hidden",
      squash: "TANH",
      index: FIRST_HIDDEN_INDEX,
      bias: biases[0],
      uuid: "hidden-0",
    },
    {
      type: "hidden",
      squash: "TANH",
      index: FIRST_HIDDEN_INDEX + 1,
      bias: biases[1],
      uuid: "hidden-1",
    },
    {
      type: "output",
      squash: "LOGISTIC",
      index: OUTPUT_INDEX,
      bias: biases[2],
      uuid: "output-0",
    },
  ];
  const synapses: LegacyCreatureJSON["synapses"] = [
    { from: 0, to: FIRST_HIDDEN_INDEX, weight: weights[0] },
    { from: 1, to: FIRST_HIDDEN_INDEX, weight: weights[1] },
    { from: 0, to: FIRST_HIDDEN_INDEX + 1, weight: weights[2] },
    { from: 1, to: FIRST_HIDDEN_INDEX + 1, weight: weights[3] },
    { from: FIRST_HIDDEN_INDEX, to: OUTPUT_INDEX, weight: weights[4] },
    { from: FIRST_HIDDEN_INDEX + 1, to: OUTPUT_INDEX, weight: weights[5] },
  ];
  return { neurons, synapses, input: INPUT_COUNT, output: OUTPUT_COUNT };
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/**
 * Construct a random initial creature JSON. Weights are drawn from
 * `[-2, 2]` and biases from `[-1, 1]` — a region wide enough that
 * the seeded population covers both XOR-correct and XOR-incorrect
 * tendencies from the first generation.
 */
export function randomCreatureJSON(random: () => number): LegacyCreatureJSON {
  const weights = new Array(WEIGHT_COUNT).fill(0).map(() => uniformSigned(random, 2));
  const biases = new Array(BIAS_COUNT).fill(0).map(() => uniformSigned(random, 1));
  return buildInitialCreatureJSON(weights, biases);
}

/** Decode a creature JSON into its weight and bias gene vectors. */
export function genesFromCreatureJSON(
  json: LegacyCreatureJSON,
): { weights: number[]; biases: number[] } {
  const weights = new Array<number>(WEIGHT_COUNT).fill(0);
  for (const synapse of json.synapses) {
    if (synapse.from === 0 && synapse.to === FIRST_HIDDEN_INDEX) weights[0] = synapse.weight;
    else if (synapse.from === 1 && synapse.to === FIRST_HIDDEN_INDEX) weights[1] = synapse.weight;
    else if (synapse.from === 0 && synapse.to === FIRST_HIDDEN_INDEX + 1) {
      weights[2] = synapse.weight;
    } else if (synapse.from === 1 && synapse.to === FIRST_HIDDEN_INDEX + 1) {
      weights[3] = synapse.weight;
    } else if (synapse.from === FIRST_HIDDEN_INDEX && synapse.to === OUTPUT_INDEX) {
      weights[4] = synapse.weight;
    } else if (synapse.from === FIRST_HIDDEN_INDEX + 1 && synapse.to === OUTPUT_INDEX) {
      weights[5] = synapse.weight;
    }
  }
  const biases: number[] = [
    json.neurons.find((n) => n.uuid === "hidden-0")?.bias ?? 0,
    json.neurons.find((n) => n.uuid === "hidden-1")?.bias ?? 0,
    json.neurons.find((n) => n.uuid === "output-0")?.bias ?? 0,
  ];
  return { weights, biases };
}

/**
 * Mutate a creature genome: each gene is perturbed independently with
 * probability `mutationRate`. Noise is drawn uniformly from
 * `[-mutationStrength, mutationStrength]`.
 */
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
  );
  return buildInitialCreatureJSON(newWeights, newBiases);
}

/** Activate the creature on a single sample, returning the scalar output. */
export function predict(creature: Creature, inputs: readonly [number, number]): number {
  creature.clearState();
  const out = creature.activate(Float32Array.from([inputs[0], inputs[1]]));
  return out[0];
}

/**
 * Mean squared error of a creature across the four XOR samples. Lower
 * is better; perfect fit is 0, worst is 1.
 */
export function meanSquaredError(creature: Creature): number {
  const samples = xorSamples();
  let sum = 0;
  for (const { inputs, target } of samples) {
    const prediction = predict(creature, inputs);
    const diff = prediction - target;
    sum += diff * diff;
  }
  return sum / samples.length;
}

/**
 * Number of samples (out of four) the creature classifies correctly,
 * using a 0.5 threshold on the output.
 */
export function correctCount(creature: Creature): number {
  const samples = xorSamples();
  let correct = 0;
  for (const { inputs, target } of samples) {
    const predicted = predict(creature, inputs) >= 0.5 ? 1 : 0;
    if (predicted === target) correct++;
  }
  return correct;
}

/**
 * Run a generational evolutionary algorithm over creature genomes. The
 * top half of each generation seeds the next via mutation; the elite
 * is carried over unchanged so the best fitness is monotonically
 * non-decreasing. Evolution stops early when the champion's MSE drops
 * below `errorThreshold`.
 */
export function evolveXorController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);

  let population: { json: LegacyCreatureJSON; fitness: number; error: number }[] = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const error = meanSquaredError(creature);
    population.push({ json, fitness: 1 - error, error });
  }

  let bestJSON = population[0].json;
  let bestFitness = -Infinity;
  let bestError = Infinity;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.fitness - a.fitness);
    const generationBest = population[0];
    if (generationBest.fitness > bestFitness) {
      bestFitness = generationBest.fitness;
      bestError = generationBest.error;
      bestJSON = generationBest.json;
    }

    const meanFitness = population.reduce((acc, p) => acc + p.fitness, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestFitness: generationBest.fitness,
      bestError: generationBest.error,
      meanFitness,
      neurons: generationBest.json.neurons.length,
      synapses: generationBest.json.synapses.length,
    });

    if (bestError <= options.errorThreshold) {
      solvedAt = generation;
      break;
    }

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
      const error = meanSquaredError(childCreature);
      next.push({ json: childJSON, fitness: 1 - error, error });
    }
    population = next;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestFitness,
    bestError,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestError <= options.errorThreshold && correctCount(champion) === 4,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/xor_decision_boundary.svg";

/** Path to the evolution-chart SVG the runner emits for the README. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/xor_classification/evolution.svg";

/** Resolution (cells per side) of the decision-boundary grid. */
export const DECISION_BOUNDARY_GRID = 40;

if (import.meta.main) {
  const start = Date.now();

  console.log("🧠 XOR Classification Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-xor");

  console.log("📊 Training samples:");
  for (const { inputs, target } of xorSamples()) {
    console.log(`   (${inputs[0]}, ${inputs[1]}) → ${target}`);
  }

  console.log("\n🧬 Evolving classifier...");
  const evolutionSamples: EvolutionSample[] = [];
  const result = evolveXorController({
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestFitness, bestError, neurons, synapses }) => {
      evolutionSamples.push({
        generation,
        score: bestFitness,
        neurons,
        synapses,
      });
      if (generation % 10 === 0 || bestError <= DEFAULT_EVOLVE_OPTIONS.errorThreshold) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  ` +
            `bestFitness=${bestFitness.toFixed(4)}  ` +
            `bestError=${bestError.toFixed(4)}`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(error=${result.bestError.toFixed(4)}, fitness=${result.bestFitness.toFixed(4)}).`,
  );

  console.log("\n🎯 Champion predictions:");
  for (const { inputs, target } of xorSamples()) {
    const out = predict(result.champion, inputs);
    const predicted = out >= 0.5 ? 1 : 0;
    const tick = predicted === target ? "✓" : "✗";
    console.log(`   (${inputs[0]}, ${inputs[1]}) → ${out.toFixed(4)} (target=${target}) ${tick}`);
  }

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`\n💾 Saved champion to ${championPath}`);

  // Render the decision-boundary SVG.
  const svg = renderDecisionBoundarySVG(result.champion, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "XOR Classification — Evolution",
      scoreLabel: "best fitness (1 - MSE)",
    });
    ensureDirSync("docs/screenshots/xor_classification");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
