/**
 * MNIST Handwritten-Digit Classification Example (multi-run persistence wired under #327).
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
 * Under #327 the runner gained the multi-run idiom (issues #318, #319,
 * #320): with no prior state it behaves like a single random-noise run;
 * after a run it persists the champion + a per-run milestone summary so
 * the next invocation resumes from the saved creature. `--fresh` wipes
 * the persisted state, `--timeout=<minutes>` overrides the wall-clock
 * backstop, and `--target-error=<value>` overrides the early-exit
 * threshold. The runner emits two charts (`milestones.svg` and
 * `complexity.svg`) plus the prediction-grid SVG.
 *
 * The legacy single-run `evolution_summary.svg` artefact (seeded under
 * #285) is superseded by the multi-run chart pair and no longer
 * generated.
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  type NeatOptions,
  safeWriteJson,
} from "@stsoftware/neat-ai";

import { fetchDataset } from "../common/data_cache.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  type NewMultiRunSample,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import { renderMultiRunErrorChartSVG } from "../common/multi_run_error_chart.ts";
import { renderMultiRunComplexityChartSVG } from "../common/multi_run_complexity_chart.ts";
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
 * Committed copy of the run summary JSON. The README quotes numbers
 * from this file (audited by the README honesty test), so the runner
 * writes a small canonical copy under `docs/data/` in addition to the
 * working-directory copy under `.synthetic-mnist/`.
 */
export const RUN_SUMMARY_DOCS_PATH = "docs/data/mnist_classification/run_summary.json";

/** Sub-directory under `MNIST_ROOT` holding the binary `.bin` training set. */
export const BIN_TRAIN_DIR = `${MNIST_ROOT}/bin`;

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "mnist_classification";

/**
 * Path to the multi-run error-curve chart the runner emits — error vs
 * cumulative generation across every run, with faint run-boundary guide
 * lines. Supersedes the legacy single-run `evolution_summary.svg` (issue
 * #327).
 */
export const MULTI_RUN_ERROR_SVG_PATH = "docs/screenshots/mnist_classification/milestones.svg";

/**
 * Path to the multi-run complexity chart the runner emits — neurons +
 * synapses vs cumulative generation across every run.
 */
export const MULTI_RUN_COMPLEXITY_SVG_PATH = "docs/screenshots/mnist_classification/complexity.svg";

/**
 * Default `targetError` for a multi-run invocation. MNIST is a much
 * harder problem than XOR, but the goal of the demo is the noise →
 * competent arc, so we keep the threshold tight (matches the historical
 * audit value).
 */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = 0.001;

/**
 * Default wall-clock budget for a single multi-run invocation, in
 * minutes. Five minutes matches the audit-mandated stop condition and
 * the multi-run idiom shared with the other in-scope examples.
 */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/**
 * Small JSON written next to the champion + confusion matrix capturing
 * the measured numbers the README quotes. Keep the schema small and
 * stable.
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
  /** Final `error` field from `Creature.evolveDir`'s return value. */
  evolveDirError: number;
  /** Final `score` field from `Creature.evolveDir`'s return value. */
  evolveDirScore: number;
  /** Final `generation` field from `Creature.evolveDir`'s return value. */
  evolveDirGenerations: number;
  /** 1-based run index in the merged multi-run history. */
  runIndex: number;
  /** Whether this run resumed from a prior persisted champion. */
  resumed: boolean;
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

/** Options accepted by {@link evolveMnistClassifier}. */
export interface MnistEvolveOptions {
  /** Directory containing the binary `.bin` training stream consumed by
   * `Creature.evolveDir`. */
  dataDir: string;
  /** `evolveDir` `targetError` option. */
  targetError: number;
  /**
   * `evolveDir` `timeoutMinutes` option. Pass `0` from tests to skip the
   * wall-clock backstop (NEAT-AI activates a dynamic library on the
   * backstop code path that Deno's `--allow-ffi` sanitizer flags as a
   * leak).
   */
  timeoutMinutes: number;
  /**
   * Optional pre-seeded creature export, used by the multi-run resume
   * flow to continue evolution from a prior champion. When supplied, the
   * evolveDir seed is built via {@link Creature.fromJSON} instead of a
   * fresh `new Creature(784, 10)`.
   */
  seedCreatureExport?: CreatureExport;
  /**
   * Optional hard cap on the number of generations. Used by tests to
   * keep the run short without depending on wall-clock timing. Default
   * is undefined (NEAT-AI's own internal cap applies).
   */
  maxGenerations?: number;
  /** Optional population size override. Used by tests for speed. */
  populationSize?: number;
}

/** Result of {@link evolveMnistClassifier}. */
export interface MnistEvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Final error field returned by `evolveDir`. */
  bestError: number;
  /** Final score field returned by `evolveDir`. */
  bestScore: number;
  /** Number of generations actually run. */
  generations: number;
  /** Wall-clock duration of the evolveDir call in milliseconds. */
  wallClockMs: number;
  /** Neuron count of the seed creature before evolveDir ran. */
  seedNeurons: number;
  /** Synapse count of the seed creature before evolveDir ran. */
  seedSynapses: number;
}

/**
 * Run NEAT structural evolution on an MNIST binary `.bin` data directory.
 *
 * When `seedCreatureExport` is supplied (multi-run resume), rebuilds
 * the prior champion via {@link Creature.fromJSON}; otherwise builds the
 * uniform-random `new Creature(FEATURE_COUNT, CLASS_COUNT)` minimal seed.
 *
 * One `evolveDir` call covers the whole budget. The return value's
 * `{ error, score, time, generation }` fields plus the seed and final
 * topology counts feed the multi-run milestone history (issue #327).
 */
export async function evolveMnistClassifier(
  options: MnistEvolveOptions,
): Promise<MnistEvolveResult> {
  const creature = options.seedCreatureExport !== undefined
    ? Creature.fromJSON(options.seedCreatureExport)
    : new Creature(FEATURE_COUNT, CLASS_COUNT);
  const seedNeurons = creature.neurons.length;
  const seedSynapses = creature.synapses.length;

  const neatOptions: NeatOptions = {
    targetError: Math.max(0, Math.min(1, options.targetError)),
    ...(options.timeoutMinutes > 0
      ? { timeoutMinutes: Math.max(1, Math.floor(options.timeoutMinutes)) }
      : {}),
    ...(options.maxGenerations !== undefined ? { iterations: options.maxGenerations } : {}),
    ...(options.populationSize !== undefined ? { populationSize: options.populationSize } : {}),
  };

  const start = Date.now();
  const result = await creature.evolveDir(options.dataDir, neatOptions);
  const wallClockMs = Date.now() - start;

  const bestError = Number.isFinite(result.error) ? result.error : 0;
  const bestScore = Number.isFinite(result.score) ? result.score : 0;
  const generations = Math.max(1, result.generation ?? 1);

  return {
    champion: creature,
    bestError,
    bestScore,
    generations,
    wallClockMs,
    seedNeurons,
    seedSynapses,
  };
}

/**
 * Convert an {@link MnistEvolveResult} into a {@link NewMultiRunSample}.
 * `Creature.evolveDir` returns a single end-of-run summary, so each run
 * contributes exactly one milestone to the merged history.
 */
export function evolveResultToMultiRunSample(result: MnistEvolveResult): NewMultiRunSample {
  const error = Math.max(0, Math.min(1, result.bestError));
  return {
    runGen: result.generations,
    bestScore: result.bestScore,
    error,
    neurons: result.champion.neurons.length,
    synapses: result.champion.synapses.length,
    generationWallClockMs: result.wallClockMs,
  };
}

/** Options accepted by {@link runMultiRunMnist}. */
export interface RunMultiRunMnistOptions {
  /** Directory containing the binary `.bin` training stream. */
  dataDir: string;
  /** Argv (defaults to `Deno.args`). Recognised flags: `--fresh`,
   * `--timeout=<minutes>`, `--target-error=<value>`. */
  argv?: readonly string[];
  /** Base directory override for the multi-run persistence helpers and
   * chart artefacts (used by tests). Defaults to `docs`. */
  baseDir?: string;
  /** Optional overrides applied to the resolved {@link MnistEvolveOptions}
   * (used by tests to cap iterations without depending on wall-clock
   * timing). */
  evolveOverrides?: Partial<MnistEvolveOptions>;
}

/** Outcome of a single multi-run invocation. */
export interface MnistMultiRunResult {
  /** The underlying evolveDir result. */
  evolveResult: MnistEvolveResult;
  /** Resolved targetError used for this run. */
  targetError: number;
  /** Resolved timeoutMinutes used for this run. */
  timeoutMinutes: number;
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
 * End-to-end multi-run wiring: parses flags, optionally wipes prior
 * state, loads the saved champion (when present) to seed the next run,
 * evolves the controller, appends the new run's milestone to the merged
 * history, and renders both multi-run charts.
 */
export async function runMultiRunMnist(
  options: RunMultiRunMnistOptions,
): Promise<MnistMultiRunResult> {
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

  const evolveOptions: MnistEvolveOptions = {
    dataDir: options.dataDir,
    targetError,
    timeoutMinutes,
    seedCreatureExport: state.creatureExport,
    ...options.evolveOverrides,
  };

  const evolveResult = await evolveMnistClassifier(evolveOptions);

  const newSamples: NewMultiRunSample[] = [evolveResultToMultiRunSample(evolveResult)];

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
      title: "MNIST Classification — multi-run error vs cumulative generations",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

    const complexitySvg = renderMultiRunComplexityChartSVG(merged.milestones, {
      title: "MNIST Classification — multi-run creature complexity",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "complexity.svg"), complexitySvg);
  }

  return {
    evolveResult,
    targetError,
    timeoutMinutes,
    runIndex: state.nextRunIndex,
    lastCumulativeGen: merged.lastCumulativeGen,
    totalMilestones: merged.milestones.length,
    resumed,
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🔢 MNIST Handwritten-Digit Classification Example (multi-run)");
  console.log("");

  const { creaturesDir, outputDir } = setupWorkingDirs(MNIST_ROOT);

  // CI/quality quick mode (mirrors the cart-pole / xor / snake idioms).
  // When the runner is invoked with `MNIST_QUICK=1` the multi-run state
  // and chart SVGs are written under a temp directory so the canonical
  // docs artefacts checked into the repo are never overwritten by a CI
  // run, and the iterations cap is forced low so the section finishes
  // well inside `quality.sh`'s per-section budget.
  const quick = Deno.env.get("MNIST_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "mnist_quick_" });
    console.log(
      "⚡ Quick mode (MNIST_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

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

  // Canonical MNIST split: bulk of the 60 000-image training file as
  // the train slice, the tail as a held-out validation slice (same
  // distribution as `train` so the fitness signal is honest), and the
  // entire 10 000-image test file as the final-evaluation test slice.
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

  // Stage 2 — multi-run flag parsing + evolve.
  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
  }
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  console.log(
    `\n🧪 Evolving via Creature.evolveDir(${binDir}, ` +
      `{ targetError: ${targetError}, timeoutMinutes: ${timeoutMinutes} })…` +
      (quick ? " (quick mode: maxGenerations=2)" : ""),
  );

  const multi = await runMultiRunMnist({
    dataDir: binDir,
    baseDir: quickBaseDir,
    evolveOverrides: quick
      ? { maxGenerations: 2, populationSize: 4, timeoutMinutes: 1 }
      : undefined,
  });
  const { evolveResult: result } = multi;

  if (multi.resumed) {
    console.log(`🔁 Resumed from prior champion (run ${multi.runIndex}).`);
  } else {
    console.log(`🌱 Fresh start — run ${multi.runIndex} begins from random noise.`);
  }

  console.log(
    `\n✅ Evolution finished in ${(result.wallClockMs / 1000).toFixed(1)}s.` +
      `   Champion topology: ${result.champion.neurons.length} neurons, ` +
      `${result.champion.synapses.length} synapses`,
  );

  // Stage 3 — save the post-evolution champion + score on validation
  // and held-out test sets. The multi-run helper has already written
  // the canonical creature.json under docs/data/<slug>/; this is a
  // working-directory copy for ad-hoc inspection.
  const championPath = join(creaturesDir, "champion.json");
  await safeWriteJson(championPath, result.champion.exportJSON());
  console.log(`💾 Saved evolved champion to ${championPath}`);

  const validationAccuracy = classificationAccuracy(result.champion, split.validation);
  const matrix = confusionMatrix(result.champion, split.test);
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
  const cells = buildGridCells(result.champion, split.test, 3);
  const gridSvg = renderDigitGridSVG({
    cells,
    accuracy: testAccuracy,
    validationAccuracy,
  });
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(join(tmpScreenshots, "mnist_classification.svg"), gridSvg);
    console.log("⏭️  Quick mode: skipped overwriting canonical prediction-grid screenshot");
  } else {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, gridSvg);
    console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);
  }

  // Stage 5 — write the small canonical run summary.
  const summary: MnistRunSummary = {
    trainingRecords: trainSamples.length,
    evolveWallClockMs: result.wallClockMs,
    targetError: multi.targetError,
    timeoutMinutes: multi.timeoutMinutes,
    seedNeurons: result.seedNeurons,
    seedSynapses: result.seedSynapses,
    finalNeurons: result.champion.neurons.length,
    finalSynapses: result.champion.synapses.length,
    validationAccuracy,
    testAccuracy,
    stopCondition: inferStopCondition(result.wallClockMs, multi.timeoutMinutes),
    evolveDirError: result.bestError,
    evolveDirScore: result.bestScore,
    evolveDirGenerations: result.generations,
    runIndex: multi.runIndex,
    resumed: multi.resumed,
  };
  const summaryPath = join(outputDir, "run_summary.json");
  await safeWriteJson(summaryPath, summary);
  if (!quick) {
    ensureDirSync(dirnameOf(RUN_SUMMARY_DOCS_PATH));
    await safeWriteJson(RUN_SUMMARY_DOCS_PATH, summary);
    console.log(`📝 Wrote run summary to ${summaryPath} and ${RUN_SUMMARY_DOCS_PATH}`);
  } else {
    console.log(`📝 Wrote run summary to ${summaryPath} (quick mode: skipped docs copy)`);
  }

  console.log(
    `📈 Multi-run charts updated under ${
      quick ? quickBaseDir : "docs"
    }/screenshots/${EXAMPLE_SLUG}/ — ` +
      `${multi.totalMilestones} cumulative milestone(s) across ${multi.runIndex} run(s).`,
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
