/**
 * Stock Market Direction Prediction Example
 *
 * Evolves a small NEAT-AI network to predict next-period direction
 * (up/down) from a window of recent simple returns. The dataset is the
 * public S&P 500 monthly-close mirror at
 * https://github.com/datasets/s-and-p-500 (pinned to a specific commit
 * for reproducibility), downloaded once into `.synthetic-stock/data/`.
 *
 * ⚠️ Teaching example only — not investment advice.
 *
 * Inputs (per sample): the last `WINDOW_SIZE` simple returns.
 * Output: a single LOGISTIC neuron — `>= 0.5` predicts up, else down.
 * Score: directional accuracy on a chronological validation window.
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

/** Configuration options for {@link evolveStockController}. */
export interface EvolveOptions {
  seed: number;
  populationSize: number;
  maxGenerations: number;
  mutationStrength: number;
  mutationRate: number;
  windowSize: number;
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
  champion: Creature;
  /** Directional accuracy on the validation set (0–1). */
  validationAccuracy: number;
  generations: number;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 24601,
  populationSize: 40,
  maxGenerations: 30,
  mutationStrength: 0.3,
  mutationRate: 0.4,
  windowSize: WINDOW_SIZE,
};

/**
 * Build a small linear network: `windowSize` LOGISTIC inputs feeding a
 * single LOGISTIC output. With `windowSize` weights and one bias this
 * is a logistic-regression-style classifier — enough capacity to pick
 * up momentum / mean-reversion patterns and small enough to train fast.
 */
export function buildInitialCreatureJSON(
  weights: number[],
  bias: number,
): LegacyCreatureJSON {
  if (weights.length < 1) {
    throw new Error("buildInitialCreatureJSON: need at least one weight");
  }
  const neurons = weights.map((_, i) => ({
    type: "input" as const,
    squash: "LOGISTIC",
    index: i,
    uuid: `input-${i}`,
  }));
  const outputIndex = weights.length;
  neurons.push(
    {
      type: "output" as const,
      squash: "LOGISTIC",
      index: outputIndex,
      bias,
      uuid: "output-0",
    } as unknown as (typeof neurons)[number],
  );
  const synapses = weights.map((w, i) => ({
    from: i,
    to: outputIndex,
    weight: w,
  }));
  return {
    neurons,
    synapses,
    input: weights.length,
    output: 1,
  };
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/** Construct a random initial creature genome of the right shape. */
export function randomCreatureJSON(
  random: () => number,
  windowSize: number,
): LegacyCreatureJSON {
  const weights = Array.from({ length: windowSize }, () => uniformSigned(random, 0.5));
  return buildInitialCreatureJSON(weights, uniformSigned(random, 0.2));
}

/** Decode a creature genome into its weight vector and output bias. */
export function genesFromCreatureJSON(
  json: LegacyCreatureJSON,
): { weights: number[]; bias: number } {
  const outputIndex = json.input;
  const weights: number[] = new Array(json.input).fill(0);
  for (const synapse of json.synapses) {
    if (synapse.to === outputIndex && synapse.from >= 0 && synapse.from < json.input) {
      weights[synapse.from] = synapse.weight;
    }
  }
  const output = json.neurons.find((n) => n.uuid === "output-0");
  return { weights, bias: output?.bias ?? 0 };
}

/**
 * Mutate a creature genome by perturbing each weight and the bias with
 * uniform noise. Each gene is independently mutated with probability
 * `mutationRate`.
 */
export function mutateCreatureJSON(
  parent: LegacyCreatureJSON,
  random: () => number,
  mutationRate: number,
  mutationStrength: number,
): LegacyCreatureJSON {
  const { weights, bias } = genesFromCreatureJSON(parent);
  const newWeights = weights.map((w) =>
    random() < mutationRate ? w + uniformSigned(random, mutationStrength) : w
  );
  const newBias = random() < mutationRate ? bias + uniformSigned(random, mutationStrength) : bias;
  return buildInitialCreatureJSON(newWeights, newBias);
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
 * Run a generational evolutionary algorithm scoring on validation
 * directional accuracy. Truncation selection keeps the top half as
 * parents; the elite is always carried over so accuracy is monotonic.
 */
export function evolveStockController(
  split: DataSplit,
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  if (split.train.length === 0 || split.validation.length === 0) {
    throw new Error("evolveStockController: train and validation must be non-empty");
  }
  const random = createDeterministicRandom(options.seed);

  type Member = { json: LegacyCreatureJSON; accuracy: number };

  const score = (json: LegacyCreatureJSON): number => {
    const creature = Creature.fromJSON(asCreatureExport(json));
    return directionalAccuracy(creature, split.validation);
  };

  let population: Member[] = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random, options.windowSize);
    population.push({ json, accuracy: score(json) });
  }

  let bestJSON = population[0].json;
  let bestAcc = -1;

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
    });

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
    generations: options.maxGenerations,
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

  console.log("\n🧬 Evolving controller…");
  const result = evolveStockController(split, {
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestAccuracy, meanAccuracy }) => {
      if (generation % 5 === 0 || generation === DEFAULT_EVOLVE_OPTIONS.maxGenerations - 1) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  ` +
            `best=${(bestAccuracy * 100).toFixed(2)}%  ` +
            `mean=${(meanAccuracy * 100).toFixed(2)}%`,
        );
      }
    },
  });

  console.log(
    `\n📏 Validation directional accuracy: ${(result.validationAccuracy * 100).toFixed(2)}%`,
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

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
