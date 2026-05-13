/**
 * Stock Market Direction Prediction Example (audit #218,
 * per-generation telemetry retired under #301).
 *
 * Evolves a NEAT-AI network from a **minimal seed** to predict
 * next-period direction (up/down) on the public S&P 500 monthly-close
 * dataset. The training labels are pre-generated into a binary `.bin`
 * file and `Creature.evolveDir(dataDir, ...)` is delegated to the
 * library — exercising back-propagation, structural mutation, and the
 * library's full evolution pipeline.
 *
 * 🌱 **Generation 1 starts from random noise.** The seed is built by the
 * NEAT-AI library's uniform-random `new Creature(WINDOW_SIZE, 1)`
 * constructor — direct input → output connections, with random weights
 * and a random output bias drawn from the seeded global PRNG. **No
 * topology, weights, or biases are hand-specified by this example.**
 * Hidden neurons are not pre-built — they emerge purely from NEAT-AI's
 * own structural mutation operators while `evolveDir` runs.
 *
 * Under #301 the per-generation `onTrainingEvent` hook, the chunked
 * `evolveDir` loop, and the multi-panel checkpoint strip were removed
 * in favour of NEAT-AI's supported milestone-only telemetry surface
 * (see [#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298)
 * for the decision record). The run now makes one `evolveDir` call and
 * renders a single milestone summary SVG from its return value via the
 * shared `EvolveDirSummary` helper from #284.
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
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
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

/** Milestone summary SVG path — sourced from `evolveDir`'s return value (#301). */
export const EVOLUTION_SUMMARY_SVG_PATH = "docs/screenshots/stock_market/evolution_summary.svg";

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
  /** Milestone summary built from `evolveDir`'s return value (issue #301). */
  summary: EvolveDirSummary;
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

  const creature = Creature.fromJSON(buildRandomSeedCreature(options.seed, options.windowSize));
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

  const summary: EvolveDirSummary = {
    finalError,
    finalScore,
    wallClockMs,
    generations,
    seedNeurons,
    seedSynapses,
    finalNeurons: creature.neurons.length,
    finalSynapses: creature.synapses.length,
    targetError: options.errorThreshold,
    ...(options.timeoutMinutes > 0 ? { timeoutMinutes: options.timeoutMinutes } : {}),
  };

  return {
    champion: creature,
    bestFitness: finalScore,
    bestError: finalError,
    generations,
    solved,
    summary,
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

  console.log("📈 Stock-Market Direction Prediction Example");
  console.log("⚠️  Teaching example — not investment advice.");
  console.log("");

  const { creaturesDir, outputDir, dataDir } = setupWorkingDirs(STOCK_ROOT);

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

  console.log("\n🧬 Evolving controller from a minimal NEAT seed via evolveDir...");
  const result = await evolveStockController({
    ...DEFAULT_EVOLVE_OPTIONS,
    dataDir,
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve (within budget)"} ` +
      `after ${result.generations} generations ` +
      `(error=${result.bestError.toFixed(4)}, fitness=${result.bestFitness.toFixed(4)}, ` +
      `wall-clock=${(result.summary.wallClockMs / 1000).toFixed(1)}s).`,
  );

  // Save champion creature.
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

  // Render animated chart.
  const svg = renderChartSVG({
    records,
    glyphFor: classifyGlyph,
    validationAccuracy: valBalanced,
    testAccuracy,
    cumulativeStrategyReturn: cumulativeReturn,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  // Milestone summary SVG sourced from the evolveDir return value
  // (issue #301): one chart, no per-generation telemetry.
  ensureDirSync("docs/screenshots/stock_market");
  const summarySvg = renderEvolveDirSummarySvg(result.summary, {
    title: "Stock Market — evolveDir Run Summary",
  });
  await Deno.writeTextFile(EVOLUTION_SUMMARY_SVG_PATH, summarySvg);
  console.log(`📈 Wrote milestone summary ${EVOLUTION_SUMMARY_SVG_PATH}`);

  console.log(
    `\n🏁 Final summary: generations=${result.summary.generations}  ` +
      `bestFitness=${result.summary.finalScore.toFixed(4)}  ` +
      `bestError=${result.summary.finalError.toFixed(4)}  ` +
      `seed=${result.summary.seedNeurons}/${result.summary.seedSynapses}  ` +
      `final=${result.summary.finalNeurons}/${result.summary.finalSynapses}`,
  );
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
