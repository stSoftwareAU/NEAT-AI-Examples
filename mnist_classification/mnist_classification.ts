/**
 * MNIST Handwritten-Digit Classification Example
 *
 * Evolves a `196 → 10` LOGISTIC linear classifier on a small subset of
 * the canonical MNIST dataset. Each output neuron represents one digit
 * class (0..9); the network's prediction is the argmax of the ten
 * outputs.
 *
 *  - Inputs: a 14×14 mean-pooled version of the 28×28 source image,
 *    normalised into `[0, 1]`. See `data.ts` for the down-sampling.
 *  - Topology: a fully-connected single layer with `196 × 10 = 1960`
 *    weights and 10 biases — small enough that pure mutation finds a
 *    decent classifier in tens of generations.
 *  - Initialisation: each population member starts at the per-class
 *    mean image (a "nearest-template" baseline) plus a small random
 *    perturbation. This warm start keeps the search tractable inside
 *    the CI 5-minute budget while leaving meaningful headroom for
 *    truncation+mutation to discover a better classifier.
 *  - Score: classification accuracy on a held-out fold of the training
 *    set (the validation slice in {@link DigitSplit}).
 *  - Solved: the run reports `solved=true` once the champion's
 *    held-out accuracy crosses {@link EvolveOptions.accuracyThreshold}.
 *
 * The runner downloads the MNIST IDX files into `.synthetic-mnist/data/`
 * (cached on disk and digest-verified), evolves a champion, saves it
 * to `.synthetic-mnist/creatures/champion.json`, writes a confusion
 * matrix to `.synthetic-mnist/output/confusion.json`, and renders an
 * animated `5 × 4` grid SVG to `docs/screenshots/mnist_classification.svg`.
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { fetchDataset } from "../common/data_cache.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import {
  buildDigitSamples,
  CLASS_COUNT,
  type DigitSample,
  type DigitSplit,
  FEATURE_COUNT,
  parseIdxImages,
  parseIdxLabels,
  readGzippedFile,
  splitDataset,
} from "./data.ts";
import { type CellFrame, type DigitCell, GRID_COLS, GRID_ROWS, renderDigitGridSVG } from "./svg.ts";

/** Working-directory root for this example. */
export const MNIST_ROOT = ".synthetic-mnist";

/**
 * Canonical MNIST IDX gzip mirror hosted by the Common Visual Data
 * Foundation on Google Cloud Storage. The files have been digest-pinned
 * below so the exact bytes are byte-stable across runs.
 */
export const TEST_IMAGES_URL =
  "https://storage.googleapis.com/cvdf-datasets/mnist/t10k-images-idx3-ubyte.gz";
/** SHA-256 of `t10k-images-idx3-ubyte.gz`. */
export const TEST_IMAGES_SHA256 =
  "8d422c7b0a1c1c79245a5bcf07fe86e33eeafee792b84584aec276f5a2dbc4e6";
export const TEST_LABELS_URL =
  "https://storage.googleapis.com/cvdf-datasets/mnist/t10k-labels-idx1-ubyte.gz";
/** SHA-256 of `t10k-labels-idx1-ubyte.gz`. */
export const TEST_LABELS_SHA256 =
  "f7ae60f92e00ec6debd23a6088c31dbd2371eca3ffa0defaefb259924204aec6";

/** On-disk cache paths for the gzipped IDX files. */
export const TEST_IMAGES_PATH = join(MNIST_ROOT, "data", "t10k-images-idx3-ubyte.gz");
export const TEST_LABELS_PATH = join(MNIST_ROOT, "data", "t10k-labels-idx1-ubyte.gz");

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mnist_classification.svg";

/** Configuration options for {@link evolveClassifier}. */
export interface EvolveOptions {
  seed: number;
  populationSize: number;
  maxGenerations: number;
  /** Standard deviation of the per-gene mutation noise. */
  mutationStrength: number;
  /** Probability that any given gene is perturbed each generation. */
  mutationRate: number;
  /** Number of input features (must match {@link DigitSample.features}). */
  inputCount: number;
  /** Number of output classes. */
  classCount: number;
  /**
   * Held-out accuracy at or above which the run is reported as solved
   * and evolution stops early.
   */
  accuracyThreshold: number;
  /**
   * Per-gene noise applied around the per-class mean template at
   * population initialisation. Smaller values keep the warm start
   * close to the template; larger values spread the population wider.
   */
  initNoise: number;
  /** Optional per-generation progress callback. */
  onGeneration?: (info: GenerationInfo) => void;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  /** Best held-out accuracy in the current generation. */
  bestAccuracy: number;
  /** Mean held-out accuracy across the population. */
  meanAccuracy: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** Fittest creature found across the run. */
  champion: Creature;
  /** Held-out accuracy of the champion (on the validation slice). */
  validationAccuracy: number;
  /** Number of generations actually executed. */
  generations: number;
  /** True when {@link validationAccuracy} >= the threshold. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 42424242,
  populationSize: 24,
  maxGenerations: 60,
  mutationStrength: 0.05,
  mutationRate: 0.05,
  inputCount: FEATURE_COUNT,
  classCount: CLASS_COUNT,
  accuracyThreshold: 0.7,
  initNoise: 0.01,
};

/**
 * Build a dense `inputCount → classCount` LOGISTIC creature from a
 * weight matrix and bias vector. The legacy index space lays inputs
 * `0..inputCount-1` first, followed by output neurons
 * `inputCount..inputCount+classCount-1`, and one synapse per
 * (input, output) pair.
 */
export function buildInitialCreatureJSON(
  weightMatrix: readonly number[][],
  biases: readonly number[],
): LegacyCreatureJSON {
  const classCount = weightMatrix.length;
  if (classCount === 0) {
    throw new Error("buildInitialCreatureJSON: weight matrix must have at least one row");
  }
  const inputCount = weightMatrix[0].length;
  if (inputCount === 0) {
    throw new Error("buildInitialCreatureJSON: weight matrix rows must be non-empty");
  }
  for (let c = 0; c < classCount; c++) {
    if (weightMatrix[c].length !== inputCount) {
      throw new Error(
        `buildInitialCreatureJSON: row ${c} has ${weightMatrix[c].length} weights, ` +
          `expected ${inputCount}`,
      );
    }
  }
  if (biases.length !== classCount) {
    throw new Error(
      `buildInitialCreatureJSON: biases length ${biases.length} != classCount ${classCount}`,
    );
  }

  const neurons: LegacyCreatureJSON["neurons"] = [];
  for (let i = 0; i < inputCount; i++) {
    neurons.push({ type: "input", squash: "LOGISTIC", index: i, uuid: `input-${i}` });
  }
  for (let c = 0; c < classCount; c++) {
    neurons.push({
      type: "output",
      squash: "LOGISTIC",
      index: inputCount + c,
      bias: biases[c],
      uuid: `output-${c}`,
    });
  }
  const synapses: LegacyCreatureJSON["synapses"] = [];
  for (let c = 0; c < classCount; c++) {
    const offset = inputCount + c;
    for (let i = 0; i < inputCount; i++) {
      synapses.push({ from: i, to: offset, weight: weightMatrix[c][i] });
    }
  }
  return { neurons, synapses, input: inputCount, output: classCount };
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/**
 * Compute per-class mean feature vectors across `samples`. Returns a
 * `classCount × inputCount` matrix. Classes absent from `samples`
 * (`count == 0`) get a zero row so the call never divides by zero.
 */
export function classMeanFeatures(
  samples: readonly DigitSample[],
  inputCount: number,
  classCount: number,
): number[][] {
  const sums: number[][] = Array.from(
    { length: classCount },
    () => new Array<number>(inputCount).fill(0),
  );
  const counts = new Array<number>(classCount).fill(0);
  for (const s of samples) {
    if (s.label < 0 || s.label >= classCount) continue;
    counts[s.label]++;
    const row = sums[s.label];
    for (let i = 0; i < inputCount; i++) row[i] += s.features[i];
  }
  for (let c = 0; c < classCount; c++) {
    const n = counts[c];
    if (n === 0) continue;
    const row = sums[c];
    for (let i = 0; i < inputCount; i++) row[i] /= n;
  }
  return sums;
}

/**
 * Construct a creature whose weights are the per-class mean feature
 * template (shifted by the grand mean, so `W·x` is a centred
 * similarity score) plus uniform noise of magnitude
 * {@link EvolveOptions.initNoise}.
 *
 * This warm start dramatically narrows the search space — pure
 * mutation from random weights would barely beat 10% on MNIST inside
 * the CI budget, but starting near the nearest-template solution
 * lets evolution refine to 70%+.
 */
export function templateCreatureJSON(
  random: () => number,
  samples: readonly DigitSample[],
  inputCount: number,
  classCount: number,
  noise: number,
): LegacyCreatureJSON {
  if (samples.length === 0) {
    throw new Error("templateCreatureJSON: samples must not be empty");
  }
  const classMeans = classMeanFeatures(samples, inputCount, classCount);
  const grand = new Array<number>(inputCount).fill(0);
  for (const s of samples) {
    for (let i = 0; i < inputCount; i++) grand[i] += s.features[i];
  }
  for (let i = 0; i < inputCount; i++) grand[i] /= samples.length;

  const W: number[][] = [];
  for (let c = 0; c < classCount; c++) {
    const row = new Array<number>(inputCount);
    for (let i = 0; i < inputCount; i++) {
      row[i] = (classMeans[c][i] - grand[i]) + uniformSigned(random, noise);
    }
    W.push(row);
  }
  const biases = new Array<number>(classCount).fill(0).map(() => uniformSigned(random, noise));
  return buildInitialCreatureJSON(W, biases);
}

/** Decode a creature genome into its weight matrix and bias vector. */
export function genesFromCreatureJSON(
  json: LegacyCreatureJSON,
): { weights: number[][]; biases: number[] } {
  const inputCount = json.input;
  const classCount = json.output;
  const W: number[][] = Array.from(
    { length: classCount },
    () => new Array<number>(inputCount).fill(0),
  );
  for (const s of json.synapses) {
    const c = s.to - inputCount;
    if (c >= 0 && c < classCount && s.from >= 0 && s.from < inputCount) {
      W[c][s.from] = s.weight;
    }
  }
  const biases = new Array<number>(classCount).fill(0);
  for (let c = 0; c < classCount; c++) {
    const out = json.neurons.find((n) => n.uuid === `output-${c}`);
    biases[c] = out?.bias ?? 0;
  }
  return { weights: W, biases };
}

/**
 * Mutate a creature genome by perturbing each weight and bias with
 * uniform noise. Each gene is independently mutated with probability
 * `mutationRate`.
 */
export function mutateCreatureJSON(
  parent: LegacyCreatureJSON,
  random: () => number,
  mutationRate: number,
  mutationStrength: number,
): LegacyCreatureJSON {
  const { weights, biases } = genesFromCreatureJSON(parent);
  const newW = weights.map((row) =>
    row.map((w) => random() < mutationRate ? w + uniformSigned(random, mutationStrength) : w)
  );
  const newB = biases.map((b) =>
    random() < mutationRate ? b + uniformSigned(random, mutationStrength) : b
  );
  return buildInitialCreatureJSON(newW, newB);
}

/**
 * Activate the creature on a single feature vector and return the
 * argmax of the ten LOGISTIC outputs (the predicted digit class).
 */
export function predict(creature: Creature, features: readonly number[]): number {
  creature.clearState();
  const out = creature.activate(Float32Array.from(features));
  let argmax = 0;
  let max = out[0];
  for (let i = 1; i < out.length; i++) {
    if (out[i] > max) {
      max = out[i];
      argmax = i;
    }
  }
  return argmax;
}

/** Fraction of correctly classified samples in `[0, 1]`. */
export function classificationAccuracy(
  creature: Creature,
  samples: readonly DigitSample[],
): number {
  if (samples.length === 0) return 0;
  let correct = 0;
  for (const s of samples) {
    if (predict(creature, s.features) === s.label) correct++;
  }
  return correct / samples.length;
}

/**
 * Build a `classCount × classCount` confusion matrix where row `t` is
 * the true label and column `p` is the predicted label.
 */
export function confusionMatrix(
  creature: Creature,
  samples: readonly DigitSample[],
  classCount: number = CLASS_COUNT,
): number[][] {
  const m: number[][] = Array.from(
    { length: classCount },
    () => new Array<number>(classCount).fill(0),
  );
  for (const s of samples) {
    if (s.label < 0 || s.label >= classCount) continue;
    const pred = predict(creature, s.features);
    if (pred < 0 || pred >= classCount) continue;
    m[s.label][pred]++;
  }
  return m;
}

/**
 * Run a generational evolutionary algorithm over linear classifier
 * genomes. The held-out accuracy on `split.validation` is the fitness
 * signal; the elite is always carried over so accuracy is monotonic.
 *
 * Throws when the train or validation slice is empty — there is no
 * meaningful template to seed from or fitness signal to score against.
 */
export function evolveClassifier(
  split: DigitSplit,
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  if (split.train.length === 0) {
    throw new Error("evolveClassifier: training set must not be empty");
  }
  if (split.validation.length === 0) {
    throw new Error("evolveClassifier: validation set must not be empty");
  }

  const random = createDeterministicRandom(options.seed);

  type Member = { json: LegacyCreatureJSON; accuracy: number };

  const score = (json: LegacyCreatureJSON): number => {
    const c = Creature.fromJSON(asCreatureExport(json));
    return classificationAccuracy(c, split.validation);
  };

  let population: Member[] = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = templateCreatureJSON(
      random,
      split.train,
      options.inputCount,
      options.classCount,
      options.initNoise,
    );
    population.push({ json, accuracy: score(json) });
  }

  let bestJSON = population[0].json;
  let bestAcc = -1;
  let solvedAt = -1;

  for (let g = 0; g < options.maxGenerations; g++) {
    population.sort((a, b) => b.accuracy - a.accuracy);
    const gb = population[0];
    if (gb.accuracy > bestAcc) {
      bestAcc = gb.accuracy;
      bestJSON = gb.json;
    }
    const meanAcc = population.reduce((acc, p) => acc + p.accuracy, 0) / population.length;
    options.onGeneration?.({
      generation: g,
      bestAccuracy: gb.accuracy,
      meanAccuracy: meanAcc,
    });

    if (bestAcc >= options.accuracyThreshold) {
      solvedAt = g;
      break;
    }

    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);
    const next: Member[] = [parents[0]];
    while (next.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureJSON(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
      );
      next.push({ json: childJSON, accuracy: score(childJSON) });
    }
    population = next;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    validationAccuracy: bestAcc,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestAcc >= options.accuracyThreshold,
  };
}

/**
 * Pick `count` test samples covering as many distinct digit classes
 * as possible (round-robin per class), so the rendered grid shows a
 * good spread rather than 20 copies of "9". Returns an empty array
 * when `samples` is empty.
 */
export function pickGridSamples(
  samples: readonly DigitSample[],
  count: number,
  classCount: number = CLASS_COUNT,
): DigitSample[] {
  if (samples.length === 0 || count <= 0) return [];
  const buckets: DigitSample[][] = Array.from({ length: classCount }, () => []);
  for (const s of samples) {
    if (s.label >= 0 && s.label < classCount) buckets[s.label].push(s);
  }
  const out: DigitSample[] = [];
  let cursor = 0;
  while (out.length < count) {
    const bucket = buckets[cursor % classCount];
    const pickIdx = Math.floor(out.length / classCount);
    if (pickIdx < bucket.length) {
      out.push(bucket[pickIdx]);
    }
    cursor++;
    // Stop if we've made a full sweep without picking anything new.
    if (cursor > classCount * Math.ceil(count / classCount) + classCount) break;
  }
  return out.slice(0, count);
}

/**
 * Build the `GRID_ROWS × GRID_COLS` cell list consumed by the SVG
 * renderer. Every cell rotates through `framesPerCell` test samples
 * via SMIL opacity switching.
 */
export function buildGridCells(
  creature: Creature,
  testSamples: readonly DigitSample[],
  framesPerCell: number,
): DigitCell[] {
  const cellCount = GRID_ROWS * GRID_COLS;
  const total = cellCount * framesPerCell;
  const picks = pickGridSamples(testSamples, total);
  const cells: DigitCell[] = [];
  for (let cell = 0; cell < cellCount; cell++) {
    const frames: CellFrame[] = [];
    for (let f = 0; f < framesPerCell; f++) {
      const idx = cell * framesPerCell + f;
      const sample = picks[idx % Math.max(1, picks.length)];
      if (!sample) continue;
      frames.push({
        pixels: sample.pixels,
        label: sample.label,
        prediction: predict(creature, sample.features),
      });
    }
    if (frames.length === 0) continue;
    cells.push({ frames });
  }
  return cells;
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🔢 MNIST Handwritten-Digit Classification Example");
  console.log("");

  const { creaturesDir, outputDir } = setupWorkingDirs(MNIST_ROOT);

  console.log(`📥 Fetching MNIST test-set IDX files (cached in ${MNIST_ROOT}/data)…`);
  await Promise.all([
    fetchDataset({
      url: TEST_IMAGES_URL,
      path: TEST_IMAGES_PATH,
      sha256: TEST_IMAGES_SHA256,
    }),
    fetchDataset({
      url: TEST_LABELS_URL,
      path: TEST_LABELS_PATH,
      sha256: TEST_LABELS_SHA256,
    }),
  ]);

  const [imageBytes, labelBytes] = await Promise.all([
    readGzippedFile(TEST_IMAGES_PATH),
    readGzippedFile(TEST_LABELS_PATH),
  ]);
  const images = parseIdxImages(imageBytes);
  const labels = parseIdxLabels(labelBytes);
  const allSamples = buildDigitSamples(images, labels);
  console.log(`   Parsed ${allSamples.length} samples (${images.rows}×${images.cols} pixels).`);

  const split = splitDataset(allSamples, {
    trainCount: 1000,
    validationCount: 200,
    testCount: 200,
  });
  console.log(
    `📊 Split: train=${split.train.length}  ` +
      `val=${split.validation.length}  test=${split.test.length}  ` +
      `(features=${FEATURE_COUNT}, classes=${CLASS_COUNT})`,
  );

  console.log("\n🧬 Evolving classifier…");
  const result = evolveClassifier(split, {
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestAccuracy, meanAccuracy }) => {
      if (generation % 2 === 0 || generation === DEFAULT_EVOLVE_OPTIONS.maxGenerations - 1) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  ` +
            `best=${(bestAccuracy * 100).toFixed(2)}%  ` +
            `mean=${(meanAccuracy * 100).toFixed(2)}%`,
        );
      }
    },
  });
  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not reach threshold"} ` +
      `after ${result.generations} generations ` +
      `(validation accuracy ${(result.validationAccuracy * 100).toFixed(2)}%).`,
  );

  // Save champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Confusion matrix on the held-out test set.
  const matrix = confusionMatrix(result.champion, split.test);
  const testAccuracy = matrix.reduce((acc, row, i) => acc + row[i], 0) /
    (split.test.length || 1);
  const confusionPath = join(outputDir, "confusion.json");
  await safeWriteJson(confusionPath, {
    classes: CLASS_COUNT,
    testAccuracy,
    validationAccuracy: result.validationAccuracy,
    matrix,
  });
  console.log(
    `📝 Wrote confusion matrix to ${confusionPath}  ` +
      `(test accuracy ${(testAccuracy * 100).toFixed(2)}%)`,
  );

  // Render the animated digit grid.
  const cells = buildGridCells(result.champion, split.test, 3);
  const svg = renderDigitGridSVG({
    cells,
    accuracy: testAccuracy,
    validationAccuracy: result.validationAccuracy,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
