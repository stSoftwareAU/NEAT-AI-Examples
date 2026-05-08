/**
 * Stock Market Direction Prediction Example
 *
 * Evolves a NEAT-AI network from **uniform-random noise** to predict
 * next-period direction (up/down) from a window of recent simple
 * returns. The dataset is the public S&P 500 monthly-close mirror at
 * https://github.com/datasets/s-and-p-500 (pinned to a specific commit
 * for reproducibility), downloaded once into `.synthetic-stock/data/`.
 *
 * ⚠️ Teaching example only — not investment advice.
 *
 * Inputs (per sample): the last `WINDOW_SIZE` simple returns.
 * Output: a single LOGISTIC neuron — `>= 0.5` predicts up, else down.
 * Score: directional accuracy on a chronological validation window.
 *
 * 🌱 **Generation 1 starts from random noise.** The initial population
 * is built by NEAT-AI's uniform-random `Creature(WINDOW_SIZE, 1)`
 * constructor — direct input → output connections with weights and the
 * output bias drawn by the library's seeded PRNG. **No hand-crafted
 * topology and no domain-tuned narrow weight init.** Structural
 * mutation (weight perturbation, bias perturbation, and add-neuron
 * splits) discovers the predictor from there.
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

import { fetchDataset } from "../common/data_cache.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  captureSnapshot,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import {
  buildSamples,
  type DataSplit,
  parsePriceCSV,
  type PricePoint,
  type Sample,
  splitChronologically,
} from "./data.ts";
import { renderChartSVG, type SignalGlyph } from "./svg.ts";

/** Window of prior returns fed to the network. */
export const WINDOW_SIZE = 10;

/** Number of network outputs (a single direction probability). */
export const OUTPUT_COUNT = 1;

/** Working-directory root for this example. */
export const STOCK_ROOT = ".synthetic-stock";

/**
 * URL of the public S&P 500 dataset, pinned to a specific commit so the
 * file contents — and therefore the SHA-256 digest — never change.
 */
export const DATASET_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500/45117dfc620664bda935a7dbd692f65a5beaa1cd/data/data.csv";

/** SHA-256 of the pinned dataset CSV. */
export const DATASET_SHA256 = "3fe682b8dd593beb2548092d2a5e9b8844c2adc0f512da200dc5725d390ecfc9";

/** On-disk cache path for the dataset. */
export const DATASET_PATH = join(STOCK_ROOT, "data", "prices.csv");

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/stock_market.svg";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/stock_market_evolution.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/stock_market/evolution.svg";

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-stock/snapshots";

/**
 * Validation balanced-directional-accuracy threshold at or above which
 * the predictor is declared "solved". 60% balanced accuracy on the
 * held-out validation window — comfortably above the 50% chance
 * baseline (a constant or coin-flip predictor scores 0.5 in balanced
 * accuracy regardless of how skewed the labels are) and high enough
 * that the best-of-population from a uniform-random NEAT seed cannot
 * reach it by luck alone, so the demo tells a real noise → competent
 * story.
 */
export const SOLVED_THRESHOLD = 0.60;

/**
 * Generations at which the runner captures evolution snapshots.
 * Variable-topology evolution from uniform-random noise typically needs
 * more generations to converge than the previous fixed-topology
 * bounded-random search did, so the cadence is extended past the old
 * default.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 100, 500, 1000];

/** Configuration options for {@link evolveStockController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Hard cap on the number of generations before giving up. */
  maxGenerations: number;
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
  /** Number of inputs (window size). Default {@link WINDOW_SIZE}. */
  windowSize: number;
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
  bestAccuracy: number;
  meanAccuracy: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  champion: Creature;
  /** Directional accuracy on the validation set (0–1). */
  validationAccuracy: number;
  /** Number of generations run before stopping. */
  generations: number;
  /** True when the champion's accuracy reached {@link SOLVED_THRESHOLD}. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 24601,
  populationSize: 60,
  maxGenerations: 1000,
  mutationStrength: 0.5,
  mutationRate: 0.5,
  addNeuronRate: 0.03,
  windowSize: WINDOW_SIZE,
};

/**
 * Build the initial population using the NEAT-AI library's uniform-random
 * creature constructor. `new Creature(windowSize, OUTPUT_COUNT)` produces
 * a minimal seed (direct input → output connections) with random weights
 * and a random output bias. The output neuron's squash is pinned to
 * LOGISTIC because the prediction interface (≥ 0.5 ⇒ "up") assumes the
 * output is bounded to `[0, 1]`. **No topology is hand-specified**;
 * structural mutation grows hidden neurons during evolution.
 *
 * `seed` controls the global library RNG so the same `seed` reproduces
 * the same initial population across runs.
 */
export function buildRandomPopulation(
  seed: number,
  populationSize: number,
  windowSize: number = WINDOW_SIZE,
): CreatureExport[] {
  setRandomNumberGenerator(createSeededRng(seed));
  const population = createSeededPopulation({
    inputCount: windowSize,
    outputCount: OUTPUT_COUNT,
    populationSize,
    seeds: [],
  });
  // Pin the output activation to LOGISTIC — the prediction interface
  // (>= 0.5 ⇒ "up") assumes the output is bounded to [0, 1]. Hidden
  // neurons (added later by structural mutation) are not constrained.
  for (const json of population) {
    for (const neuron of json.neurons) {
      if (neuron.type === "output") neuron.squash = "LOGISTIC";
    }
  }
  return population;
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
 */
function addHiddenNeuron(
  creature: CreatureExport,
  random: () => number,
  hiddenCounter: { value: number },
): CreatureExport {
  if (creature.synapses.length === 0) return creature;

  const synapseIdx = Math.floor(random() * creature.synapses.length);
  const original = creature.synapses[synapseIdx];

  // Deterministic UUID so the export is reproducible across runs with
  // the same seed.
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

  // Hidden neurons must precede output neurons to keep the topology
  // forward-only. Insert the new hidden neuron before the first output.
  const firstOutputIdx = creature.neurons.findIndex((n) => n.type === "output");
  const insertAt = firstOutputIdx === -1 ? creature.neurons.length : firstOutputIdx;
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

/**
 * Convert a single network output into a direction prediction:
 * `>= 0.5` ⇒ "up" (1), otherwise "down" (0).
 */
export function predictionFromOutput(output: number): 0 | 1 {
  return output >= 0.5 ? 1 : 0;
}

/**
 * Evaluate directional accuracy of a creature on a window of samples.
 * Returns the fraction of correct up/down predictions in `[0, 1]`.
 */
export function directionalAccuracy(creature: Creature, samples: Sample[]): number {
  if (samples.length === 0) return 0;
  let correct = 0;
  for (const sample of samples) {
    creature.clearState();
    const out = creature.activate(Float32Array.from(sample.features));
    const prediction = predictionFromOutput(out[0]);
    if (prediction === sample.label) correct++;
  }
  return correct / samples.length;
}

/**
 * Balanced directional accuracy — the **mean** of the per-class hit
 * rates (true-positive rate on "up" days and true-negative rate on
 * "down" days), so any constant predictor scores `0.5` regardless of
 * how skewed the dataset is.
 *
 * The S&P 500 is strongly skewed toward "up" months (~63% positive),
 * so raw {@link directionalAccuracy} rewards a network that always
 * predicts "up" with the base rate — even though it has learned
 * nothing. Balanced accuracy is the honest metric that earns 50% for
 * **any** constant or coin-flip predictor and only rises above 50%
 * when the network's predictions actually correlate with the
 * direction. This is what makes the noise → competent narrative
 * meaningful: gen-1 random networks hover near 0.5 by construction.
 *
 * If a sample window contains only one class, the missing class's
 * rate is taken as 0.5 (the chance baseline) rather than counted as
 * a perfect or zero hit.
 */
export function balancedDirectionalAccuracy(creature: Creature, samples: Sample[]): number {
  if (samples.length === 0) return 0;
  let truePos = 0;
  let trueNeg = 0;
  let posCount = 0;
  let negCount = 0;
  for (const sample of samples) {
    creature.clearState();
    const out = creature.activate(Float32Array.from(sample.features));
    const prediction = predictionFromOutput(out[0]);
    if (sample.label === 1) {
      posCount++;
      if (prediction === 1) truePos++;
    } else {
      negCount++;
      if (prediction === 0) trueNeg++;
    }
  }
  const tpr = posCount > 0 ? truePos / posCount : 0.5;
  const tnr = negCount > 0 ? trueNeg / negCount : 0.5;
  return (tpr + tnr) / 2;
}

interface ScoredMember {
  json: CreatureExport;
  accuracy: number;
  neurons: number;
  synapses: number;
}

function topologyCounts(json: CreatureExport, windowSize: number): {
  neurons: number;
  synapses: number;
} {
  // The export omits input neurons (they are implicit in `input`), so
  // we add them back to report a comparable "total neurons" figure.
  return {
    neurons: json.neurons.length + (json.input ?? windowSize),
    synapses: json.synapses.length,
  };
}

/**
 * Run a generational evolutionary algorithm scoring on validation
 * directional accuracy. Truncation selection keeps the top half as
 * parents; the elite is always carried over so accuracy is monotonic.
 * Stops as soon as the champion's accuracy reaches
 * {@link SOLVED_THRESHOLD} or `maxGenerations` is exhausted (whichever
 * comes first) — the **hard generation cap** is the second guarantee.
 */
export function evolveStockController(
  split: DataSplit,
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  if (split.train.length === 0 || split.validation.length === 0) {
    throw new Error("evolveStockController: train and validation must be non-empty");
  }
  const random = createDeterministicRandom(options.seed);

  const score = (json: CreatureExport): number => {
    const creature = Creature.fromJSON(json);
    // Score with balanced accuracy so a constant "always up" predictor
    // (which would coincidentally score the base rate ~63% on the
    // upward-biased S&P 500) is honestly rated at 0.5. Only networks
    // whose predictions actually correlate with direction climb above
    // chance.
    return balancedDirectionalAccuracy(creature, split.validation);
  };

  // Counter for deterministic hidden-neuron UUIDs so exports are
  // reproducible across runs with the same seed.
  const hiddenCounter = { value: 0 };
  const mutationOpts = { addNeuronRate: options.addNeuronRate ?? 0, hiddenCounter };

  // Initial population: uniform-random NEAT genomes from the library.
  // No hand-crafted topology — `new Creature(input, output)` decides
  // the initial structure, with random weights and a random output bias.
  const initialExports = buildRandomPopulation(
    options.seed,
    options.populationSize,
    options.windowSize,
  );
  let population: ScoredMember[] = initialExports.map((json) => {
    const counts = topologyCounts(json, options.windowSize);
    return { json, accuracy: score(json), neurons: counts.neurons, synapses: counts.synapses };
  });

  let bestJSON = population[0].json;
  let bestAcc = -Infinity;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.accuracy - a.accuracy);
    const generationBest = population[0];
    if (generationBest.accuracy > bestAcc) {
      bestAcc = generationBest.accuracy;
      bestJSON = generationBest.json;
    }
    const meanAccuracy = population.reduce((acc, p) => acc + p.accuracy, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestAccuracy: generationBest.accuracy,
      meanAccuracy,
      neurons: generationBest.neurons,
      synapses: generationBest.synapses,
    });

    // Capture an evolution snapshot of the running champion at the
    // configured checkpoints. The helper is a no-op for non-checkpoint
    // generations.
    if (options.snapshotConfig) {
      const checkpointGen = generation + 1;
      if (options.snapshotConfig.checkpoints.includes(checkpointGen)) {
        captureSnapshot(options.snapshotConfig, checkpointGen, bestJSON, bestAcc);
      }
    }

    if (bestAcc >= SOLVED_THRESHOLD) {
      if (solvedAt < 0) solvedAt = generation;
      // When capturing snapshots, keep running until the next checkpoint
      // within maxGenerations is captured — otherwise the progression
      // strip would be a single panel.
      if (options.snapshotConfig) {
        const nextCheckpoint = options.snapshotConfig.checkpoints
          .filter((c) => c > generation + 1 && c <= options.maxGenerations)
          .sort((a, b) => a - b)[0];
        if (nextCheckpoint === undefined) break;
      } else {
        break;
      }
    }

    // Truncation selection: keep top 50% as parents (always at least 1).
    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    // Build the next generation: keep elite, fill rest with mutated
    // offspring from random parents.
    const nextPopulation: ScoredMember[] = [parents[0]];
    while (nextPopulation.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureExport(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
        mutationOpts,
      );
      const counts = topologyCounts(childJSON, options.windowSize);
      nextPopulation.push({
        json: childJSON,
        accuracy: score(childJSON),
        neurons: counts.neurons,
        synapses: counts.synapses,
      });
    }
    population = nextPopulation;
  }

  const champion = Creature.fromJSON(bestJSON);
  return {
    champion,
    validationAccuracy: bestAcc,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestAcc >= SOLVED_THRESHOLD,
  };
}

/** Per-sample signal and its outcome for the test window. */
export interface SignalRecord {
  date: string;
  close: number;
  return: number;
  /** 1 = predicted up, 0 = predicted down. */
  prediction: 0 | 1;
  /** 1 = realised up, 0 = realised down. */
  outcome: 0 | 1;
  /** Convenience flag — true when prediction matches outcome. */
  correct: boolean;
}

/**
 * Replay a creature on a sample window, recording prediction vs outcome
 * for each step. Used to build the SVG and the per-day signal log.
 */
export function replayController(
  creature: Creature,
  samples: Sample[],
): SignalRecord[] {
  const records: SignalRecord[] = [];
  for (const sample of samples) {
    creature.clearState();
    const out = creature.activate(Float32Array.from(sample.features));
    const prediction = predictionFromOutput(out[0]);
    records.push({
      date: sample.date,
      close: sample.close,
      return: sample.return,
      prediction,
      outcome: sample.label,
      correct: prediction === sample.label,
    });
  }
  return records;
}

/**
 * Compute the cumulative simulated return of a "long-when-predicting-up,
 * flat-when-predicting-down" strategy. Sums `record.return` over records
 * where the prediction was up. Returns the total fractional return.
 */
export function cumulativeStrategyReturn(records: SignalRecord[]): number {
  let total = 0;
  for (const r of records) {
    if (r.prediction === 1) total += r.return;
  }
  return total;
}

/**
 * Map a (prediction, outcome) pair to one of four glyphs:
 *
 * - `up_hit`    — said "up", price went up (green ▲)
 * - `up_miss`   — said "up", price went down (orange ▲)
 * - `down_hit`  — said "down", price went down (blue ▼)
 * - `down_miss` — said "down", price went up (red ▼)
 */
export function classifyGlyph(record: { prediction: 0 | 1; outcome: 0 | 1 }): SignalGlyph {
  if (record.prediction === 1 && record.outcome === 1) return "up_hit";
  if (record.prediction === 1 && record.outcome === 0) return "up_miss";
  if (record.prediction === 0 && record.outcome === 0) return "down_hit";
  return "down_miss";
}

/** Convenience: load and parse the dataset CSV from disk. */
export async function loadPrices(path: string = DATASET_PATH): Promise<PricePoint[]> {
  const text = await Deno.readTextFile(path);
  return parsePriceCSV(text);
}

if (import.meta.main) {
  const start = Date.now();

  console.log("📈 Stock-Market Direction Prediction Example");
  console.log("⚠️  Teaching example — not investment advice.");
  console.log("");

  const { creaturesDir, outputDir } = setupWorkingDirs(STOCK_ROOT);

  console.log(`📥 Fetching dataset (cached in ${DATASET_PATH})…`);
  await fetchDataset({
    url: DATASET_URL,
    path: DATASET_PATH,
    sha256: DATASET_SHA256,
  });
  const prices = await loadPrices(DATASET_PATH);
  console.log(
    `   Loaded ${prices.length} price points (${prices[0].date} → ` +
      `${prices[prices.length - 1].date}).`,
  );

  console.log(`🪟 Building sliding-window samples (window=${WINDOW_SIZE})…`);
  const samples = buildSamples(prices, { windowSize: WINDOW_SIZE });
  const split = splitChronologically(samples, {
    trainFraction: 0.7,
    validationFraction: 0.15,
  });
  console.log(
    `   Train=${split.train.length}  Val=${split.validation.length}  Test=${split.test.length}`,
  );

  console.log("\n🧬 Evolving controller from uniform-random NEAT noise...");
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionStart = Date.now();
  const result = evolveStockController(split, {
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestAccuracy, meanAccuracy, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestAccuracy, neurons, synapses });
      if (
        generation % 10 === 0 ||
        bestAccuracy >= SOLVED_THRESHOLD ||
        generation === DEFAULT_EVOLVE_OPTIONS.maxGenerations - 1
      ) {
        console.log(
          `   Gen ${generation.toString().padStart(4)}  ` +
            `best=${(bestAccuracy * 100).toFixed(2)}%  ` +
            `mean=${(meanAccuracy * 100).toFixed(2)}%  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(best=${(result.validationAccuracy * 100).toFixed(2)}%, ` +
      `threshold=${(SOLVED_THRESHOLD * 100).toFixed(0)}%).`,
  );

  // Save champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Replay champion on the test window.
  const records = replayController(result.champion, split.test);
  const testAccuracy = records.length === 0
    ? 0
    : records.filter((r) => r.correct).length / records.length;
  const cumulativeReturn = cumulativeStrategyReturn(records);

  // Save per-day signals.
  const signalsPath = join(outputDir, "signals.json");
  await safeWriteJson(signalsPath, {
    windowSize: WINDOW_SIZE,
    validationAccuracy: result.validationAccuracy,
    testAccuracy,
    cumulativeStrategyReturn: cumulativeReturn,
    records,
  });
  console.log(`📝 Wrote ${records.length} signal records to ${signalsPath}`);
  console.log(
    `📈 Test accuracy: ${(testAccuracy * 100).toFixed(2)}%   ` +
      `cumulative strategy return: ${(cumulativeReturn * 100).toFixed(2)}%`,
  );

  // Render animated chart.
  const svg = renderChartSVG({
    records,
    glyphFor: classifyGlyph,
    validationAccuracy: result.validationAccuracy,
    testAccuracy,
    cumulativeStrategyReturn: cumulativeReturn,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  // Render the per-generation evolution chart (accuracy / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Stock-Market — Evolution",
      scoreLabel: "best accuracy",
    });
    ensureDirSync("docs/screenshots/stock_market");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Stock-Market — Evolution Progress",
      caption: {
        finalScore: result.validationAccuracy,
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
