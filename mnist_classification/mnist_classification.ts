/**
 * MNIST Handwritten Digit Classification Example
 *
 * Evolves a NEAT-AI creature to classify handwritten digits from a
 * small subset of the classic MNIST dataset. The 28×28 greyscale
 * images are downsampled to a 14×14 grid (196 pixels), giving a
 * 196-input, 10-output classifier. Each output is a LOGISTIC neuron
 * representing the probability that the input image is digit 0..9.
 *
 * Inputs (per sample): the 196 normalised greyscale pixel intensities
 * in `[0, 1]`, ordered row-major.
 * Output: a 10-vector of class probabilities. The predicted digit is
 * `argmax`.
 * Fitness: classification accuracy on a held-out fold of the training
 * set. The task is "solved" when accuracy meets a configurable
 * threshold (default ≥ 70%).
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { fetchDataset } from "../common/data_cache.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import { renderMnistGridSVG } from "./svg.ts";

/** Side length of the original MNIST images. */
export const SOURCE_GRID = 28;

/** Side length of the downsampled grid fed to the classifier. */
export const INPUT_GRID = 14;

/** Number of input pixels (downsampled grid area). */
export const INPUT_COUNT = INPUT_GRID * INPUT_GRID;

/** Number of output classes (digits 0..9). */
export const OUTPUT_COUNT = 10;

/** Index of the first output neuron in the legacy index space. */
const OUTPUT_INDEX_OFFSET = INPUT_COUNT;

/** Number of weights — fully connected input → output. */
export const WEIGHT_COUNT = INPUT_COUNT * OUTPUT_COUNT;

/** Number of biases — one per output. */
export const BIAS_COUNT = OUTPUT_COUNT;

/** A labelled training/test sample. */
export interface MnistSample {
  /** Ground-truth digit class in `0..9`. */
  label: number;
  /** Normalised pixel intensities, length `INPUT_COUNT`, row-major. */
  pixels: Float32Array;
  /** Original 28×28 row-major pixels (also normalised) for rendering. */
  source?: Float32Array;
}

/**
 * Parse a single MNIST CSV line of the form `label,p0,p1,...,p783`
 * (785 fields) and return the label plus the 784-pixel array
 * normalised to `[0, 1]`.
 */
export function parseMnistCsvLine(line: string): { label: number; pixels: Float32Array } {
  const fields = line.split(",");
  if (fields.length !== SOURCE_GRID * SOURCE_GRID + 1) {
    throw new Error(
      `MNIST CSV row must have ${SOURCE_GRID * SOURCE_GRID + 1} fields, got ${fields.length}`,
    );
  }
  const label = Number.parseInt(fields[0], 10);
  if (!Number.isInteger(label) || label < 0 || label > 9) {
    throw new Error(`MNIST CSV label must be an integer in 0..9, got "${fields[0]}"`);
  }
  const pixels = new Float32Array(SOURCE_GRID * SOURCE_GRID);
  for (let i = 0; i < pixels.length; i++) {
    const raw = Number.parseInt(fields[i + 1], 10);
    if (!Number.isFinite(raw)) {
      throw new Error(`MNIST CSV pixel ${i} is not a number: "${fields[i + 1]}"`);
    }
    pixels[i] = Math.max(0, Math.min(255, raw)) / 255;
  }
  return { label, pixels };
}

/**
 * Average-pool a `from`×`from` greyscale image into `to`×`to`. The
 * factor `from / to` must be an integer; each output cell is the mean
 * of a `factor`×`factor` block of the input image.
 */
export function downsample(
  pixels: Float32Array | readonly number[],
  from = SOURCE_GRID,
  to = INPUT_GRID,
): Float32Array {
  if (pixels.length !== from * from) {
    throw new Error(`downsample: expected ${from * from} pixels, got ${pixels.length}`);
  }
  if (to < 1 || from % to !== 0) {
    throw new Error(`downsample: target size ${to} must divide source size ${from}`);
  }
  const factor = from / to;
  const out = new Float32Array(to * to);
  for (let r = 0; r < to; r++) {
    for (let c = 0; c < to; c++) {
      let sum = 0;
      for (let dr = 0; dr < factor; dr++) {
        for (let dc = 0; dc < factor; dc++) {
          sum += pixels[(r * factor + dr) * from + (c * factor + dc)];
        }
      }
      out[r * to + c] = sum / (factor * factor);
    }
  }
  return out;
}

/**
 * Load up to `maxRows` samples from an MNIST CSV file. Each row is
 * parsed, the 28×28 image is downsampled to {@link INPUT_GRID}, and
 * the original pixels are kept on each sample for rendering.
 *
 * Throws when the file cannot be read or contains zero usable rows so
 * callers see a clear error rather than silently training on nothing.
 */
export async function loadMnistDataset(
  csvPath: string,
  opts: { maxRows: number } = { maxRows: Number.POSITIVE_INFINITY },
): Promise<MnistSample[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(csvPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`loadMnistDataset: cannot read "${csvPath}": ${message}`);
  }

  const samples: MnistSample[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    // Skip a header row if the first field is non-numeric.
    if (samples.length === 0 && /^[^0-9-]/.test(line)) continue;
    const { label, pixels } = parseMnistCsvLine(line);
    samples.push({
      label,
      pixels: downsample(pixels, SOURCE_GRID, INPUT_GRID),
      source: pixels,
    });
    if (samples.length >= opts.maxRows) break;
  }

  if (samples.length === 0) {
    throw new Error(`loadMnistDataset: "${csvPath}" produced no usable samples`);
  }
  return samples;
}

/** Configuration options for {@link evolveMnistClassifier}. */
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
  /** Accuracy threshold (in `[0, 1]`) at which the task counts as solved. */
  accuracyThreshold: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestAccuracy: number;
  meanAccuracy: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Accuracy of the champion on the validation fold (in `[0, 1]`). */
  bestAccuracy: number;
  /** Number of generations actually run. */
  generations: number;
  /** True when the champion's accuracy met or exceeded the threshold. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 60,
  maxGenerations: 80,
  mutationStrength: 0.3,
  mutationRate: 0.05,
  accuracyThreshold: 0.7,
};

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/**
 * Build a fully-connected `INPUT_COUNT`-input, `OUTPUT_COUNT`-output
 * creature. Inputs use the LOGISTIC squash (acting as identity in the
 * `[0, 1]` input range), outputs are LOGISTIC so the network produces
 * a per-digit probability.
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
  const neurons: LegacyCreatureJSON["neurons"] = [];
  for (let i = 0; i < INPUT_COUNT; i++) {
    neurons.push({ type: "input", squash: "LOGISTIC", index: i, uuid: `input-${i}` });
  }
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    neurons.push({
      type: "output",
      squash: "LOGISTIC",
      index: OUTPUT_INDEX_OFFSET + o,
      bias: biases[o],
      uuid: `output-${o}`,
    });
  }
  const synapses: LegacyCreatureJSON["synapses"] = [];
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    for (let i = 0; i < INPUT_COUNT; i++) {
      synapses.push({
        from: i,
        to: OUTPUT_INDEX_OFFSET + o,
        weight: weights[o * INPUT_COUNT + i],
      });
    }
  }
  return { neurons, synapses, input: INPUT_COUNT, output: OUTPUT_COUNT };
}

/**
 * Construct a random initial creature. Weights are drawn from a small
 * range `[-0.1, 0.1]` so the initial outputs sit near 0.5; the
 * evolutionary loop then pushes the weights into a discriminative
 * regime.
 */
export function randomCreatureJSON(random: () => number): LegacyCreatureJSON {
  const weights = new Array(WEIGHT_COUNT).fill(0).map(() => uniformSigned(random, 0.1));
  const biases = new Array(BIAS_COUNT).fill(0).map(() => uniformSigned(random, 0.1));
  return buildInitialCreatureJSON(weights, biases);
}

/** Decode a creature JSON into its weight and bias gene vectors. */
export function genesFromCreatureJSON(
  json: LegacyCreatureJSON,
): { weights: number[]; biases: number[] } {
  const weights = new Array<number>(WEIGHT_COUNT).fill(0);
  for (const synapse of json.synapses) {
    const out = synapse.to - OUTPUT_INDEX_OFFSET;
    if (out < 0 || out >= OUTPUT_COUNT) continue;
    weights[out * INPUT_COUNT + synapse.from] = synapse.weight;
  }
  const biases: number[] = new Array(OUTPUT_COUNT).fill(0);
  for (const neuron of json.neurons) {
    if (neuron.type !== "output") continue;
    const out = neuron.index - OUTPUT_INDEX_OFFSET;
    biases[out] = neuron.bias ?? 0;
  }
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

/** Activate the creature on a single sample, returning the 10-vector of outputs. */
export function predictProbabilities(creature: Creature, pixels: Float32Array): Float32Array {
  creature.clearState();
  return creature.activate(pixels);
}

/** Predict the digit class for a sample (the `argmax` of the output vector). */
export function predictDigit(creature: Creature, pixels: Float32Array): number {
  const out = predictProbabilities(creature, pixels);
  let bestIdx = 0;
  let bestVal = out[0];
  for (let i = 1; i < out.length; i++) {
    if (out[i] > bestVal) {
      bestVal = out[i];
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Compute classification accuracy of a creature across a sample set. */
export function accuracy(creature: Creature, samples: readonly MnistSample[]): number {
  if (samples.length === 0) return 0;
  let correct = 0;
  for (const sample of samples) {
    if (predictDigit(creature, sample.pixels) === sample.label) correct++;
  }
  return correct / samples.length;
}

/**
 * Build a 10×10 confusion matrix where `m[actual][predicted]` is the
 * count of samples whose true class is `actual` and the network
 * predicted `predicted`.
 */
export function confusionMatrix(
  creature: Creature,
  samples: readonly MnistSample[],
): number[][] {
  const matrix: number[][] = Array.from(
    { length: OUTPUT_COUNT },
    () => new Array<number>(OUTPUT_COUNT).fill(0),
  );
  for (const sample of samples) {
    const predicted = predictDigit(creature, sample.pixels);
    matrix[sample.label][predicted]++;
  }
  return matrix;
}

/**
 * Run a generational evolutionary algorithm with truncation selection
 * and per-gene mutation. Each candidate is scored by classification
 * accuracy on the validation fold; the elite is carried forward
 * unchanged so the best score is monotonically non-decreasing.
 */
export function evolveMnistClassifier(
  trainSamples: readonly MnistSample[],
  validationSamples: readonly MnistSample[],
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  if (trainSamples.length === 0) {
    throw new Error("evolveMnistClassifier: trainSamples must be non-empty");
  }
  if (validationSamples.length === 0) {
    throw new Error("evolveMnistClassifier: validationSamples must be non-empty");
  }
  const random = createDeterministicRandom(options.seed);

  const score = (json: LegacyCreatureJSON): number => {
    const creature = Creature.fromJSON(asCreatureExport(json));
    return accuracy(creature, validationSamples);
  };

  let population: { json: LegacyCreatureJSON; fitness: number }[] = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random);
    population.push({ json, fitness: score(json) });
  }

  let bestJSON = population[0].json;
  let bestFitness = -Infinity;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.fitness - a.fitness);
    const generationBest = population[0];
    if (generationBest.fitness > bestFitness) {
      bestFitness = generationBest.fitness;
      bestJSON = generationBest.json;
    }

    const meanAccuracy = population.reduce((acc, p) => acc + p.fitness, 0) / population.length;
    options.onGeneration?.({
      generation,
      bestAccuracy: generationBest.fitness,
      meanAccuracy,
    });

    if (bestFitness >= options.accuracyThreshold) {
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
      next.push({ json: childJSON, fitness: score(childJSON) });
    }
    population = next;
  }

  // Re-evaluate over training samples too so we do not retreat below
  // the best validation score discovered.
  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestAccuracy: bestFitness,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestFitness >= options.accuracyThreshold,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mnist_classification.svg";

/** Number of test cells displayed in the rendered grid (5 × 4 = 20). */
export const GRID_COLS = 5;
export const GRID_ROWS = 4;

/** Number of test samples cross-faded inside each cell. */
export const SAMPLES_PER_CELL = 3;

/**
 * Default URLs for the small MNIST CSV. Both mirrors hold a 100-row,
 * `label,p0,..,p783` formatted MNIST sample — small enough to download
 * and train in well under a minute, large enough to cover every digit
 * class. The original `pjreddie.com` mirror that hosted the full
 * 10 000-row test fold went offline in 2025; the GitHub-hosted samples
 * below are far more stable.
 */
export const DEFAULT_DATASET_URLS = [
  "https://raw.githubusercontent.com/eth-sri/eran/master/data/mnist_test.csv",
  "https://raw.githubusercontent.com/makeyourownneuralnetwork/makeyourownneuralnetwork/master/mnist_dataset/mnist_train_100.csv",
];

/** How many rows we use for training and testing in the demonstration. */
export const TRAIN_ROWS = 80;
export const TEST_ROWS = 20;

/**
 * Split a sample list into `train` / `validation` folds by interleaving
 * digit classes so each fold sees every class. Deterministic — given
 * the same input the output is byte-identical.
 */
export function splitTrainValidation(
  samples: readonly MnistSample[],
  trainRows: number,
  validationRows: number,
): { train: MnistSample[]; validation: MnistSample[] } {
  if (trainRows + validationRows > samples.length) {
    throw new Error(
      `splitTrainValidation: ${trainRows}+${validationRows} > ${samples.length} available`,
    );
  }
  return {
    train: samples.slice(0, trainRows),
    validation: samples.slice(trainRows, trainRows + validationRows),
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🔢 MNIST Handwritten Digit Classification Example");
  console.log("");

  const { dataDir, creaturesDir, outputDir } = setupWorkingDirs(".synthetic-mnist");

  const csvPath = join(dataDir, "mnist_test.csv");
  console.log(`📥 Fetching MNIST CSV → ${csvPath}`);
  await fetchDataset({ url: DEFAULT_DATASET_URLS, path: csvPath });

  console.log("📊 Loading samples and downsampling to 14×14...");
  const total = TRAIN_ROWS + TEST_ROWS;
  const samples = await loadMnistDataset(csvPath, { maxRows: total });
  const { train, validation } = splitTrainValidation(samples, TRAIN_ROWS, TEST_ROWS);
  console.log(`   ${train.length} training rows, ${validation.length} test rows`);

  console.log("\n🧬 Evolving classifier...");
  const result = evolveMnistClassifier(train, validation, {
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestAccuracy, meanAccuracy }) => {
      if (generation % 5 === 0 || bestAccuracy >= DEFAULT_EVOLVE_OPTIONS.accuracyThreshold) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  ` +
            `bestAcc=${(bestAccuracy * 100).toFixed(2)}%  ` +
            `meanAcc=${(meanAccuracy * 100).toFixed(2)}%`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(accuracy=${(result.bestAccuracy * 100).toFixed(2)}%).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`\n💾 Saved champion to ${championPath}`);

  // Compute and save the confusion matrix.
  const matrix = confusionMatrix(result.champion, validation);
  const confusionPath = join(outputDir, "confusion.json");
  await safeWriteJson(confusionPath, matrix);
  console.log(`📈 Saved confusion matrix to ${confusionPath}`);

  // Render the animated SVG.
  const svg = renderMnistGridSVG(result.champion, validation, {
    cols: GRID_COLS,
    rows: GRID_ROWS,
    samplesPerCell: SAMPLES_PER_CELL,
    accuracy: result.bestAccuracy,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
