/**
 * Stock Market Direction Prediction Example (audit #218,
 * per-generation telemetry retired under #301, multi-run persistence
 * wired under #328).
 *
 * Evolves a NEAT-AI network from a **minimal seed** to predict
 * next-period direction (up/down) on the public S&P 500 monthly-close
 * dataset. The training labels are pre-generated into a binary `.bin`
 * file and `Creature.evolveDir(dataDir, ...)` is delegated to the
 * library — exercising back-propagation, structural mutation, and the
 * library's full evolution pipeline.
 *
 * 🌱 **Generation 1 starts from random noise.** A fresh run (no prior
 * persisted champion, or `--fresh` on the command line) builds the seed
 * via {@link buildRandomSeedCreature} — the NEAT-AI library's
 * uniform-random `new Creature(WINDOW_SIZE, 1)` constructor — direct
 * input → output connections, random weights, and a random output bias
 * drawn from the seeded global PRNG. **No topology, weights, or biases
 * are hand-specified by this example.** Hidden neurons are not
 * pre-built — they emerge purely from NEAT-AI's own structural mutation
 * operators while `evolveDir` runs.
 *
 * Under #301 the per-generation `onTrainingEvent` hook and multi-panel
 * checkpoint strip were removed in favour of NEAT-AI's supported
 * milestone-only telemetry surface (see
 * [#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298)
 * for the decision record). Under #328 the runner gained the multi-run
 * idiom (issues #318, #319, #320): with no prior state it behaves like
 * a single random-noise run; after a run it persists the champion + a
 * per-run milestone summary so the next invocation resumes from the
 * saved creature. `--fresh` wipes the persisted state,
 * `--timeout=<minutes>` overrides the wall-clock backstop, and
 * `--target-error=<value>` overrides the early-exit threshold. The
 * runner emits two charts (`milestones.svg` and `complexity.svg`) plus
 * the prediction-glyph chart. The legacy single-run
 * `evolution_summary.svg` artefact (seeded under #301) is superseded by
 * the multi-run chart pair and is no longer generated.
 *
 * Stop conditions (audit #218):
 *   - `targetError`     — per-example reasonable mean-squared error
 *                         floor (well below chance) so NEAT-AI is
 *                         pressured to grow hidden structure to satisfy
 *                         it. Markets are noisy; the run typically does
 *                         not reach the floor and exits via the
 *                         secondary safety backstop.
 *   - `timeoutMinutes`  — 5-minute wall-clock backstop mandated by
 *                         #218.
 *
 * ⚠️ Teaching example only — not investment advice.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  createSeededRng,
  Creature,
  type CreatureExport,
  type NeatOptions,
  safeWriteJson,
  setRandomNumberGenerator,
} from "@stsoftware/neat-ai";

import { fetchDataset } from "../common/data_cache.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  type NewMultiRunSample,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import { renderMultiRunComplexityChartSVG } from "../common/multi_run_complexity_chart.ts";
import { renderMultiRunErrorChartSVG } from "../common/multi_run_error_chart.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
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

/** Number of network inputs. */
export const INPUT_COUNT = WINDOW_SIZE;

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

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "stock_market";

/**
 * Path to the multi-run error-curve chart the runner emits — error vs
 * cumulative generation across every run, with faint run-boundary guide
 * lines. Supersedes the legacy single-run `evolution_summary.svg`
 * (issue #328).
 */
export const MULTI_RUN_ERROR_SVG_PATH = "docs/screenshots/stock_market/milestones.svg";

/**
 * Path to the multi-run complexity chart the runner emits — neurons +
 * synapses vs cumulative generation across every run.
 */
export const MULTI_RUN_COMPLEXITY_SVG_PATH = "docs/screenshots/stock_market/complexity.svg";

/**
 * Default `targetError` for a multi-run invocation. The issue calls for
 * a tight `0.01` floor — well below chance MSE (~0.25) — so NEAT-AI is
 * pressured to grow hidden structure. Markets are intrinsically noisy
 * so the run typically exits via `timeoutMinutes` rather than reaching
 * this floor (issue #328).
 */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = 0.01;

/**
 * Default wall-clock budget for a single multi-run invocation, in
 * minutes. Five minutes matches the audit-mandated stop condition
 * (audit issue #218) and the multi-run idiom shared with the other
 * in-scope examples.
 */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/** Configuration options for {@link evolveStockController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Hard cap on the number of generations before giving up. */
  maxGenerations: number;
  /**
   * Mean-squared-error threshold below which the task counts as solved.
   * For binary `{0, 1}` direction labels a constant predictor scores
   * about 0.25 (chance) — `errorThreshold` is set well below chance so
   * NEAT-AI is forced to grow structure to satisfy it.
   */
  errorThreshold: number;
  /**
   * Wall-clock backstop in minutes for the whole run, passed verbatim
   * to NEAT-AI's `evolveDir(...)` per the audit policy in issue #218
   * (5-minute upper bound). NEAT-AI requires a positive integer, so a
   * minimum of 1 is enforced internally. Tests pass `0` to skip the
   * backstop because the option loads NEAT-AI's GPU / discovery code
   * path whose dynamic library is flagged by Deno's `--allow-ffi`
   * sanitizer; the production runner still exercises that path.
   */
  timeoutMinutes: number;
  /**
   * Probability that any given creature is mutated each generation. The
   * NEAT-AI default is 0.3 — bumped here so the seed adds hidden
   * structure inside the limited generation budget the markets
   * problem affords.
   */
  mutationRate: number;
  /**
   * Number of mutation operators applied per mutated creature each
   * generation. Higher values bias the search toward structural growth
   * (ADD_NODE, ADD_CONN). The NEAT-AI default is 1.
   */
  mutationAmount: number;
  /** Number of inputs (window size). Default {@link WINDOW_SIZE}. */
  windowSize: number;
  /**
   * Existing data directory containing the binary training file. When
   * omitted the caller is expected to populate the directory before
   * calling — see {@link writeStockTrainingDataset}.
   */
  dataDir: string;
  /**
   * Optional pre-seeded creature export, used by the multi-run resume
   * flow to continue evolution from a prior champion. When supplied, the
   * evolveDir seed is built via {@link Creature.fromJSON} instead of a
   * fresh uniform-random {@link buildRandomSeedCreature} (issue #328).
   */
  seedCreatureExport?: CreatureExport;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  champion: Creature;
  /** Best fitness reached by the champion (≈ `1 - bestError`). */
  bestFitness: number;
  /** Mean squared error of the champion on the training set. */
  bestError: number;
  /** Number of generations actually run. */
  generations: number;
  /** True when the champion's training error fell below `errorThreshold`. */
  solved: boolean;
  /** Wall-clock duration of the evolveDir call in milliseconds. */
  wallClockMs: number;
  /** Neuron count of the seed creature before evolveDir ran. */
  seedNeurons: number;
  /** Synapse count of the seed creature before evolveDir ran. */
  seedSynapses: number;
}

/**
 * Sensible defaults for the demonstration runner.
 *
 * - `errorThreshold = 0.18` is well below the chance MSE (~0.25) so
 *   NEAT-AI is pressured to grow hidden structure to reach it. Markets
 *   are intrinsically noisy, so the run typically exits via
 *   `maxGenerations` or `timeoutMinutes` — the README quotes the
 *   measured outcome.
 * - `timeoutMinutes = 5` is the audit-mandated wall-clock backstop.
 * - `maxGenerations = 200` keeps the example inside `quality.sh`'s
 *   wall-clock budget while still showing meaningful topology growth
 *   from the minimal seed.
 */
export const DEFAULT_EVOLVE_OPTIONS: Omit<EvolveOptions, "dataDir"> = {
  seed: 24601,
  populationSize: 30,
  maxGenerations: 200,
  errorThreshold: 0.18,
  timeoutMinutes: 5,
  mutationRate: 0.6,
  mutationAmount: 3,
  windowSize: WINDOW_SIZE,
};

/**
 * Build a uniform-random NEAT seed creature. Seeds the library's global
 * PRNG with {@link createSeededRng} and then defers to
 * `new Creature(windowSize, OUTPUT_COUNT)` — the library's
 * uniform-random constructor. **No topology, weight, or bias is
 * hand-specified by this example.**
 *
 * The single output neuron's activation is pinned to LOGISTIC because
 * the prediction interface (`>= 0.5` ⇒ "up") assumes the output is
 * bounded to `[0, 1]`. Hidden neurons added later by NEAT-AI's
 * structural mutation operators are not constrained.
 */
export function buildRandomSeedCreature(
  seed: number,
  windowSize: number = WINDOW_SIZE,
): CreatureExport {
  setRandomNumberGenerator(createSeededRng(seed));
  const json = new Creature(windowSize, OUTPUT_COUNT).exportJSON();
  for (const neuron of json.neurons) {
    if (neuron.type === "output") neuron.squash = "LOGISTIC";
  }
  return json;
}

/**
 * Write the training samples as a Float32 binary file the NEAT-AI
 * library can consume via `creature.evolveDir(dir, ...)`. Each record
 * is `windowSize + OUTPUT_COUNT` floats: the window of prior returns
 * followed by the binary direction label (`0` or `1`).
 *
 * Returns the path to the written `.bin` file.
 */
export function writeStockTrainingDataset(
  samples: readonly Sample[],
  dataDir: string,
  windowSize: number = WINDOW_SIZE,
): string {
  if (samples.length === 0) {
    throw new Error("writeStockTrainingDataset: samples must not be empty");
  }
  ensureDirSync(dataDir);
  const stride = windowSize + OUTPUT_COUNT;
  const buffer = new Float32Array(samples.length * stride);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.features.length !== windowSize) {
      throw new Error(
        `writeStockTrainingDataset: sample ${i} has ${sample.features.length} features, ` +
          `expected ${windowSize}`,
      );
    }
    for (let j = 0; j < windowSize; j++) {
      buffer[i * stride + j] = sample.features[j];
    }
    buffer[i * stride + windowSize] = sample.label;
  }
  const path = join(dataDir, "stock_market.bin");
  Deno.writeFileSync(path, new Uint8Array(buffer.buffer));
  return path;
}

/**
 * Run NEAT structural evolution to learn next-period direction.
 *
 * The runner builds the **uniform-random seed creature** via
 * {@link buildRandomSeedCreature} (no hidden neurons, random weights and
 * output bias from the seeded PRNG) and delegates structural mutation
 * to the library via `creature.evolveDir(dataDir, ...)`. One call
 * covers the whole budget; the return value's
 * `{ error, score, time, generation }` fields plus the seed and final
 * topology counts feed an {@link EvolveDirSummary} for the milestone
 * summary chart (issue #301).
 *
 * Determinism: the seed flows through `NeatOptions.seed` and is also
 * used to construct the initial creature, so two runs with the same
 * `seed` produce the same gen-1 seed creature and similar (but not
 * always byte-identical, due to threading) champions.
 */
export async function evolveStockController(options: EvolveOptions): Promise<EvolveResult> {
  if (!options.dataDir) {
    throw new Error("evolveStockController: dataDir must be supplied");
  }

  // Resume from the prior champion when supplied, otherwise build the
  // uniform-random minimal seed via the seeded global PRNG.
  const creature = options.seedCreatureExport !== undefined
    ? Creature.fromJSON(options.seedCreatureExport)
    : Creature.fromJSON(buildRandomSeedCreature(options.seed, options.windowSize));
  const seedNeurons = creature.neurons.length;
  const seedSynapses = creature.synapses.length;

  const neatOptions: NeatOptions = {
    seed: options.seed,
    populationSize: options.populationSize,
    iterations: options.maxGenerations,
    targetError: Math.max(0, Math.min(1, options.errorThreshold)),
    ...(options.timeoutMinutes > 0
      ? { timeoutMinutes: Math.max(1, Math.floor(options.timeoutMinutes)) }
      : {}),
    // No `feedbackLoop` key → engine runs forward-only, the canonical
    // mode for binary `.bin` regression sets.
    costOfGrowth: 0,
    mutationRate: options.mutationRate,
    mutationAmount: options.mutationAmount,
    verbose: false,
    log: 0,
    threads: 1,
  };

  const start = Date.now();
  const result = await creature.evolveDir(options.dataDir, neatOptions);
  const wallClockMs = Date.now() - start;

  const finalError = Number.isFinite(result.error) ? result.error : 0;
  const finalScore = Number.isFinite(result.score) ? result.score : 0;
  const generations = Math.max(1, result.generation ?? 1);
  const solved = finalError <= options.errorThreshold;

  return {
    champion: creature,
    bestFitness: finalScore,
    bestError: finalError,
    generations,
    solved,
    wallClockMs,
    seedNeurons,
    seedSynapses,
  };
}

/**
 * Convert an {@link EvolveResult} into a {@link NewMultiRunSample}.
 * `Creature.evolveDir` returns a single end-of-run summary, so each run
 * contributes exactly one milestone to the merged history.
 */
export function evolveResultToMultiRunSample(result: EvolveResult): NewMultiRunSample {
  const error = Math.max(0, Math.min(1, result.bestError));
  return {
    runGen: result.generations,
    bestScore: result.bestFitness,
    error,
    neurons: result.champion.neurons.length,
    synapses: result.champion.synapses.length,
    generationWallClockMs: result.wallClockMs,
  };
}

/** Options accepted by {@link runMultiRunStock}. */
export interface RunMultiRunStockOptions {
  /** Directory containing the binary `.bin` training stream consumed by
   * `Creature.evolveDir`. */
  dataDir: string;
  /** Argv (defaults to `Deno.args`). Recognised flags: `--fresh`,
   * `--timeout=<minutes>`, `--target-error=<value>`. */
  argv?: readonly string[];
  /** Base directory override for the multi-run persistence helpers and
   * chart artefacts (used by tests). Defaults to `docs`. */
  baseDir?: string;
  /** Optional overrides applied to the resolved {@link EvolveOptions}
   * (used by tests to cap iterations without depending on wall-clock
   * timing). */
  evolveOverrides?: Partial<EvolveOptions>;
}

/** Outcome of a single multi-run invocation. */
export interface StockMultiRunResult {
  /** The underlying evolveDir result. */
  evolveResult: EvolveResult;
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
export async function runMultiRunStock(
  options: RunMultiRunStockOptions,
): Promise<StockMultiRunResult> {
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

  const evolveOptions: EvolveOptions = {
    ...DEFAULT_EVOLVE_OPTIONS,
    dataDir: options.dataDir,
    timeoutMinutes,
    errorThreshold: targetError,
    // Multi-run runs are bounded by `timeoutMinutes` / `targetError` —
    // raise the historical 200-generation cap so a real 5-minute run
    // never exits via `maxGenerations` first (issue #328).
    maxGenerations: 1_000_000,
    seedCreatureExport: state.creatureExport,
    ...options.evolveOverrides,
  };

  const evolveResult = await evolveStockController(evolveOptions);

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
      title: "Stock Market — multi-run error vs cumulative generations",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

    const complexitySvg = renderMultiRunComplexityChartSVG(merged.milestones, {
      title: "Stock Market — multi-run creature complexity",
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
 * direction.
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

  console.log("📈 Stock-Market Direction Prediction Example (multi-run)");
  console.log("⚠️  Teaching example — not investment advice.");
  console.log("");

  const { creaturesDir, outputDir, dataDir } = setupWorkingDirs(STOCK_ROOT);

  // CI/quality quick mode (mirrors the cart-pole / xor / mnist idioms).
  // When the runner is invoked with `STOCK_QUICK=1` the multi-run state
  // and chart SVGs are written under a temp directory so the canonical
  // docs artefacts checked into the repo are never overwritten by a CI
  // run, and the iterations cap is forced low so the section finishes
  // well inside `quality.sh`'s per-section budget.
  const quick = Deno.env.get("STOCK_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "stock_quick_" });
    console.log(
      "⚡ Quick mode (STOCK_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

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
  const split: DataSplit = splitChronologically(samples, {
    trainFraction: 0.7,
    validationFraction: 0.15,
  });
  console.log(
    `   Train=${split.train.length}  Val=${split.validation.length}  Test=${split.test.length}`,
  );

  // Pre-generate the binary `.bin` training set for `evolveDir`.
  const trainBin = writeStockTrainingDataset(split.train, dataDir);
  console.log(`📦 Wrote training set to ${trainBin}`);

  // Multi-run flag parsing (logged here for the operator; the runner
  // also re-parses inside `runMultiRunStock`).
  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
  }
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  console.log(
    `\n🧬 Evolving via Creature.evolveDir(${dataDir}, ` +
      `{ targetError: ${targetError}, timeoutMinutes: ${timeoutMinutes} })…` +
      (quick ? " (quick mode: maxGenerations=2)" : ""),
  );

  const multi = await runMultiRunStock({
    dataDir,
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
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve (within budget)"} ` +
      `after ${result.generations} generations ` +
      `(error=${result.bestError.toFixed(4)}, fitness=${result.bestFitness.toFixed(4)}, ` +
      `wall-clock=${(result.wallClockMs / 1000).toFixed(1)}s).`,
  );

  // The champion creature is persisted by `runMultiRunStock` under
  // `docs/data/stock_market/creature.json`. Also drop a copy under the
  // example's working directory for ad-hoc inspection.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Replay champion on validation + test windows.
  const valAccuracy = directionalAccuracy(result.champion, split.validation);
  const valBalanced = balancedDirectionalAccuracy(result.champion, split.validation);
  const records = replayController(result.champion, split.test);
  const testAccuracy = records.length === 0
    ? 0
    : records.filter((r) => r.correct).length / records.length;
  const testBalanced = balancedDirectionalAccuracy(result.champion, split.test);
  const cumulativeReturn = cumulativeStrategyReturn(records);

  // Save per-day signals.
  const signalsPath = join(outputDir, "signals.json");
  await safeWriteJson(signalsPath, {
    windowSize: WINDOW_SIZE,
    validationAccuracy: valAccuracy,
    validationBalancedAccuracy: valBalanced,
    testAccuracy,
    testBalancedAccuracy: testBalanced,
    cumulativeStrategyReturn: cumulativeReturn,
    records,
  });
  console.log(`📝 Wrote ${records.length} signal records to ${signalsPath}`);
  console.log(
    `📈 Validation: raw=${(valAccuracy * 100).toFixed(2)}% balanced=${
      (valBalanced * 100).toFixed(2)
    }%   ` +
      `Test: raw=${(testAccuracy * 100).toFixed(2)}% balanced=${
        (testBalanced * 100).toFixed(2)
      }%   ` +
      `cumulative strategy return: ${(cumulativeReturn * 100).toFixed(2)}%`,
  );

  // Render animated chart. Quick mode keeps this under the temp
  // directory so a CI invocation never overwrites the canonical docs
  // screenshot.
  const svg = renderChartSVG({
    records,
    glyphFor: classifyGlyph,
    validationAccuracy: valBalanced,
    testAccuracy,
    cumulativeStrategyReturn: cumulativeReturn,
  });
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(join(tmpScreenshots, "stock_market.svg"), svg);
    console.log("⏭️  Quick mode: skipped overwriting canonical prediction-glyph screenshot");
  } else {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);
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
    `\n🏁 Final summary: generations=${result.generations}  ` +
      `bestFitness=${result.bestFitness.toFixed(4)}  ` +
      `bestError=${result.bestError.toFixed(4)}  ` +
      `seed=${result.seedNeurons}/${result.seedSynapses}  ` +
      `final=${result.champion.neurons.length}/${result.champion.synapses.length}`,
  );
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
