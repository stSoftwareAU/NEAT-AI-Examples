/**
 * MNIST Handwritten-Digit Classification Example
 *
 * Direct supervised-batch demo: seed NEAT-AI with `new Creature(784, 10)`
 * — no hidden hint, no warm start, no `NeatOptions` overrides — and
 * call `Creature.evolveDir(dataDir, { targetError, timeoutMinutes })`
 * exactly once over the full 60 000-record MNIST training set encoded
 * as a binary `.bin` stream.
 *
 *  - Inputs: the raw 28×28 source image, normalised into `[0, 1]`
 *    (784 features in row-major order). See `data.ts`.
 *  - Output topology: 10 outputs (one per digit class). The network's
 *    prediction is the argmax of the ten outputs.
 *
 * The runner downloads the MNIST IDX files into `.synthetic-mnist/data/`
 * (cached on disk and digest-verified), encodes the entire 60 000-image
 * training file into `.synthetic-mnist/bin/mnist_train.bin`, evolves
 * the seed, saves the champion to
 * `.synthetic-mnist/creatures/champion.json`, writes the confusion
 * matrix to `.synthetic-mnist/output/confusion.json`, and renders the
 * prediction-grid SVG under `docs/screenshots/`.
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { fetchDataset } from "../common/data_cache.ts";
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  buildDigitSamples,
  CLASS_COUNT,
  type DigitSample,
  type DigitSplit,
  FEATURE_COUNT,
  parseIdxImages,
  parseIdxLabels,
  readGzippedFile,
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

/** Canonical MNIST IDX gzip mirror — full **training** set (60 000 images). */
export const TRAIN_IMAGES_URL =
  "https://storage.googleapis.com/cvdf-datasets/mnist/train-images-idx3-ubyte.gz";
/** SHA-256 of `train-images-idx3-ubyte.gz`. */
export const TRAIN_IMAGES_SHA256 =
  "440fcabf73cc546fa21475e81ea370265605f56be210a4024d2ca8f203523609";
export const TRAIN_LABELS_URL =
  "https://storage.googleapis.com/cvdf-datasets/mnist/train-labels-idx1-ubyte.gz";
/** SHA-256 of `train-labels-idx1-ubyte.gz`. */
export const TRAIN_LABELS_SHA256 =
  "3552534a0a558bbed6aed32b30c495cca23d567ec52cac8be1a0730e8010255c";

/** On-disk cache paths for the training-set IDX files. */
export const TRAIN_IMAGES_PATH = join(MNIST_ROOT, "data", "train-images-idx3-ubyte.gz");
export const TRAIN_LABELS_PATH = join(MNIST_ROOT, "data", "train-labels-idx1-ubyte.gz");

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mnist_classification.svg";

/**
 * Path to the milestone summary SVG sourced from `Creature.evolveDir`'s
 * return value (final error, score, generation count) plus the seed and
 * post-evolution topology counts. Added under #285 to replace the
 * "deferred (#273)" placeholder — milestone stats only, no per-generation
 * telemetry.
 */
export const EVOLUTION_SUMMARY_SVG_PATH =
  "docs/screenshots/mnist_classification/evolution_summary.svg";

/**
 * Committed copy of the run summary JSON. The README quotes numbers
 * from this file (audited by `readme_screenshot_honesty_test.ts`), so
 * the runner writes a small canonical copy under `docs/data/` in
 * addition to the working-directory copy under `.synthetic-mnist/`.
 */
export const RUN_SUMMARY_DOCS_PATH = "docs/data/mnist_classification/run_summary.json";

/** Sub-directory under `MNIST_ROOT` holding the binary `.bin` training set. */
export const BIN_TRAIN_DIR = `${MNIST_ROOT}/bin`;

/**
 * Small JSON written next to the champion + confusion matrix capturing
 * the measured numbers the README quotes. Keep the schema small and
 * stable — `readme_screenshot_honesty_test.ts` cross-checks the README
 * against this file.
 */
export interface MnistRunSummary {
  /** Training-set record count fed to `evolveDir`. */
  trainingRecords: number;
  /** Wall-clock time taken by the single `evolveDir` call, in ms. */
  evolveWallClockMs: number;
  /** `evolveDir` `targetError` option used for the run. */
  targetError: number;
  /** `evolveDir` `timeoutMinutes` option used for the run. */
  timeoutMinutes: number;
  /** Neuron count of the minimal seed before evolution. */
  seedNeurons: number;
  /** Synapse count of the minimal seed before evolution. */
  seedSynapses: number;
  /** Neuron count of the post-evolution champion. */
  finalNeurons: number;
  /** Synapse count of the post-evolution champion. */
  finalSynapses: number;
  /**
   * Argmax accuracy on the held-out validation slice (tail of the
   * 60 000-image training file).
   */
  validationAccuracy: number;
  /** Argmax accuracy on the canonical 10 000-image test set. */
  testAccuracy: number;
  /**
   * Which stop condition fired. Inferred from wall-clock vs the
   * `timeoutMinutes` budget: if the run consumed (effectively) the full
   * budget it is reported as `timeoutMinutes`; otherwise as
   * `targetError`.
   */
  stopCondition: "targetError" | "timeoutMinutes";
  /**
   * Final `error` field from `Creature.evolveDir`'s return value
   * (milestone stat — populated under #285).
   */
  evolveDirError: number;
  /**
   * Final `score` field from `Creature.evolveDir`'s return value
   * (milestone stat — populated under #285).
   */
  evolveDirScore: number;
  /**
   * Final `generation` field from `Creature.evolveDir`'s return value:
   * the generation count completed before the run terminated. Milestone
   * stat — populated under #285.
   */
  evolveDirGenerations: number;
}

/**
 * Activate the creature on a single feature vector and return the
 * argmax of the ten outputs (the predicted digit class).
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

/**
 * Encode `samples` into the binary `.bin` training-stream format
 * documented in `docs/binary_training_stream.md`. Each record is
 * `FEATURE_COUNT` Float32 input pixels followed by `classCount`
 * Float32 one-hot target outputs (1.0 for the labelled class, 0.0
 * elsewhere), so the file matches the shape NEAT-AI's `evolveDir`
 * expects for a `784 → 10` classifier.
 *
 * The writer is deterministic — `samples` is consumed in order and
 * every value goes through `Float32Array` rounding — so two runs over
 * the same input produce byte-identical files.
 */
export function writeMnistTrainingBin(
  samples: readonly DigitSample[],
  outPath: string,
  classCount: number = CLASS_COUNT,
  featureCount: number = FEATURE_COUNT,
): void {
  if (samples.length === 0) {
    throw new Error("writeMnistTrainingBin: samples must not be empty");
  }
  const stride = featureCount + classCount;
  const buffer = new Uint8Array(samples.length * stride * 4);
  const view = new Float32Array(buffer.buffer);
  let offset = 0;
  for (const s of samples) {
    if (s.features.length !== featureCount) {
      throw new Error(
        `writeMnistTrainingBin: expected ${featureCount} features, got ${s.features.length}`,
      );
    }
    if (s.label < 0 || s.label >= classCount) {
      throw new Error(
        `writeMnistTrainingBin: label ${s.label} out of range [0, ${classCount})`,
      );
    }
    for (let i = 0; i < featureCount; i++) {
      view[offset + i] = s.features[i];
    }
    // One-hot target: 1.0 for the labelled class, 0.0 elsewhere.
    for (let c = 0; c < classCount; c++) {
      view[offset + featureCount + c] = c === s.label ? 1 : 0;
    }
    offset += stride;
  }
  ensureDirSync(dirnameOf(outPath));
  Deno.writeFileSync(outPath, buffer);
}

/** Tiny path helper — keeps the `@std/path` import surface small. */
function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/**
 * Decide which stop condition fired for an `evolveDir` call configured
 * with `targetError` + `timeoutMinutes`. The NEAT-AI promise resolves
 * without surfacing the reason directly, so we infer from the realised
 * wall-clock vs the budget: if the run ate at least 95 % of the
 * timeout it is reported as `timeoutMinutes`, otherwise `targetError`.
 */
export function inferStopCondition(
  evolveWallClockMs: number,
  timeoutMinutes: number,
): "targetError" | "timeoutMinutes" {
  const budgetMs = timeoutMinutes * 60_000;
  return evolveWallClockMs >= budgetMs * 0.95 ? "timeoutMinutes" : "targetError";
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🔢 MNIST Handwritten-Digit Classification Example");
  console.log("");

  const { creaturesDir, outputDir } = setupWorkingDirs(MNIST_ROOT);

  console.log(`📥 Fetching MNIST IDX files (cached in ${MNIST_ROOT}/data)…`);
  await Promise.all([
    fetchDataset({
      url: TRAIN_IMAGES_URL,
      path: TRAIN_IMAGES_PATH,
      sha256: TRAIN_IMAGES_SHA256,
    }),
    fetchDataset({
      url: TRAIN_LABELS_URL,
      path: TRAIN_LABELS_PATH,
      sha256: TRAIN_LABELS_SHA256,
    }),
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

  const [trainImageBytes, trainLabelBytes, testImageBytes, testLabelBytes] = await Promise.all([
    readGzippedFile(TRAIN_IMAGES_PATH),
    readGzippedFile(TRAIN_LABELS_PATH),
    readGzippedFile(TEST_IMAGES_PATH),
    readGzippedFile(TEST_LABELS_PATH),
  ]);
  const trainSamples = buildDigitSamples(
    parseIdxImages(trainImageBytes),
    parseIdxLabels(trainLabelBytes),
  );
  const testSamples = buildDigitSamples(
    parseIdxImages(testImageBytes),
    parseIdxLabels(testLabelBytes),
  );
  console.log(
    `   Parsed ${trainSamples.length + testSamples.length} samples ` +
      `(train=${trainSamples.length}, test=${testSamples.length}, 28×28 pixels).`,
  );

  // Canonical MNIST split: take the bulk of the 60 000-image training
  // file as the train slice, the tail of the same file as a held-out
  // validation slice (same distribution as `train` so the fitness
  // signal is honest), and the entire 10 000-image test file as the
  // final-evaluation test slice. Source-order slicing keeps the run
  // byte-deterministic.
  const TRAIN_COUNT = 50000;
  const VAL_COUNT = 10000;
  if (trainSamples.length < TRAIN_COUNT + VAL_COUNT) {
    throw new Error(
      `Need at least ${TRAIN_COUNT + VAL_COUNT} samples in the training file, ` +
        `got ${trainSamples.length}`,
    );
  }
  const split: DigitSplit = {
    train: trainSamples.slice(0, TRAIN_COUNT),
    validation: trainSamples.slice(TRAIN_COUNT, TRAIN_COUNT + VAL_COUNT),
    test: testSamples,
  };
  console.log(
    `📊 Split: train=${split.train.length}  ` +
      `val=${split.validation.length}  test=${split.test.length}  ` +
      `(features=${FEATURE_COUNT}, classes=${CLASS_COUNT})`,
  );

  // Stage 1 — write the FULL 60 000-record training set as a binary
  // `.bin` file. Per the audit (#270): no slice — every training image
  // becomes one record.
  const binDir = BIN_TRAIN_DIR;
  ensureDirSync(binDir);
  const binPath = join(binDir, "mnist_train.bin");
  writeMnistTrainingBin(trainSamples, binPath);
  console.log(
    `📦 Wrote ${trainSamples.length}-record training set to ${binPath}` +
      ` (${(Deno.statSync(binPath).size / 1024 / 1024).toFixed(2)} MiB)`,
  );

  // Stage 2 — minimal seed → single `evolveDir` call. The only options
  // permitted by issue #270 are `targetError` and `timeoutMinutes`.
  const TARGET_ERROR = 0.001;
  const TIMEOUT_MINUTES = 10;
  const seed = new Creature(FEATURE_COUNT, CLASS_COUNT);
  const seedNeurons = seed.neurons.length;
  const seedSynapses = seed.synapses.length;
  console.log(
    `🌱 Seed topology: ${seedNeurons} neurons, ` +
      `${seedSynapses} synapses (no hidden neurons)`,
  );
  console.log(
    `\n🧪 Evolving via Creature.evolveDir(${binDir}, ` +
      `{ targetError: ${TARGET_ERROR}, timeoutMinutes: ${TIMEOUT_MINUTES} })…`,
  );
  const evolveStart = Date.now();
  const evolveResult = await seed.evolveDir(binDir, {
    targetError: TARGET_ERROR,
    timeoutMinutes: TIMEOUT_MINUTES,
  });
  const evolveMs = Date.now() - evolveStart;
  // Pull milestone stats out of `evolveDir`'s return value (issue #285).
  // The library resolves with `{ error, score, time, generation }`; we
  // coerce non-finite fields to safe defaults so the summary JSON stays
  // well-formed even on a degenerate run.
  const evolveDirError = Number.isFinite(evolveResult.error) ? evolveResult.error : 0;
  const evolveDirScore = Number.isFinite(evolveResult.score) ? evolveResult.score : 0;
  const evolveDirGenerations = Math.max(1, evolveResult.generation ?? 1);
  console.log(
    `\n✅ Evolution finished in ${(evolveMs / 1000).toFixed(1)}s.` +
      `   Champion topology: ${seed.neurons.length} neurons, ` +
      `${seed.synapses.length} synapses`,
  );

  // Stage 3 — save the post-evolution champion + score on validation
  // and held-out test sets.
  const championPath = join(creaturesDir, "champion.json");
  await safeWriteJson(championPath, seed.exportJSON());
  console.log(`💾 Saved evolved champion to ${championPath}`);

  const validationAccuracy = classificationAccuracy(seed, split.validation);
  const matrix = confusionMatrix(seed, split.test);
  const testAccuracy = matrix.reduce((acc, row, i) => acc + row[i], 0) /
    (split.test.length || 1);
  const confusionPath = join(outputDir, "confusion.json");
  await safeWriteJson(confusionPath, {
    classes: CLASS_COUNT,
    testAccuracy,
    validationAccuracy,
    matrix,
  });
  console.log(
    `📝 Wrote confusion matrix to ${confusionPath}  ` +
      `(test accuracy ${(testAccuracy * 100).toFixed(2)}%, ` +
      `validation accuracy ${(validationAccuracy * 100).toFixed(2)}%)`,
  );

  // Stage 4 — render the prediction grid SVG.
  const cells = buildGridCells(seed, split.test, 3);
  const gridSvg = renderDigitGridSVG({
    cells,
    accuracy: testAccuracy,
    validationAccuracy,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, gridSvg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  // Stage 5 — write the small canonical run summary (the README quotes
  // these numbers and `readme_screenshot_honesty_test.ts` cross-checks
  // them against the published prose).
  const summary: MnistRunSummary = {
    trainingRecords: trainSamples.length,
    evolveWallClockMs: evolveMs,
    targetError: TARGET_ERROR,
    timeoutMinutes: TIMEOUT_MINUTES,
    seedNeurons,
    seedSynapses,
    finalNeurons: seed.neurons.length,
    finalSynapses: seed.synapses.length,
    validationAccuracy,
    testAccuracy,
    stopCondition: inferStopCondition(evolveMs, TIMEOUT_MINUTES),
    evolveDirError,
    evolveDirScore,
    evolveDirGenerations,
  };
  const summaryPath = join(outputDir, "run_summary.json");
  await safeWriteJson(summaryPath, summary);
  ensureDirSync(dirnameOf(RUN_SUMMARY_DOCS_PATH));
  await safeWriteJson(RUN_SUMMARY_DOCS_PATH, summary);
  console.log(`📝 Wrote run summary to ${summaryPath} and ${RUN_SUMMARY_DOCS_PATH}`);

  // Stage 6 — render the milestone summary SVG sourced from the
  // captured `evolveDir` return value (issue #285). Milestone stats
  // only — no per-generation telemetry.
  const evolveSummary: EvolveDirSummary = {
    finalError: evolveDirError,
    finalScore: evolveDirScore,
    wallClockMs: evolveMs,
    generations: evolveDirGenerations,
    seedNeurons,
    seedSynapses,
    finalNeurons: seed.neurons.length,
    finalSynapses: seed.synapses.length,
    targetError: TARGET_ERROR,
    timeoutMinutes: TIMEOUT_MINUTES,
  };
  ensureDirSync(dirnameOf(EVOLUTION_SUMMARY_SVG_PATH));
  await Deno.writeTextFile(
    EVOLUTION_SUMMARY_SVG_PATH,
    renderEvolveDirSummarySvg(evolveSummary, {
      title: "MNIST Classification — evolveDir Run Summary",
    }),
  );
  console.log(`📈 Wrote milestone summary ${EVOLUTION_SUMMARY_SVG_PATH}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
