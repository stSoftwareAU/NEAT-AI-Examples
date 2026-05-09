/**
 * Stock Market Direction Prediction Example (audit #218).
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
 * Categorisation (audit #203). The training task is a pre-generated
 * binary `(window, target)` regression set, so the example uses the
 * canonical "binary `.bin` + `evolveDir`" path with `feedbackLoop`
 * unset (forward-only). Per-step `activate()` is reserved for
 * interactive simulations and reinforcement-learning agents — neither
 * applies here.
 *
 * Stop conditions (audit #218):
 *   - `targetError`     — per-example reasonable mean-squared error
 *                         floor (well below chance) so NEAT-AI is
 *                         pressured to grow hidden structure to satisfy
 *                         it. Markets are noisy; the run typically does
 *                         not reach the floor and exits via the
 *                         secondary safety backstop.
 *   - `timeoutMinutes`  — 5-minute wall-clock backstop mandated by
 *                         #218. The library requires a positive
 *                         integer.
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
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import {
  captureSnapshot,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
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

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/stock_market_evolution.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/stock_market/evolution.svg";

/** Per-generation evolution-telemetry CSV path (audit #218). */
export const EVOLUTION_CSV_PATH = "docs/data/stock_market/evolution.csv";

/** CSV header — matches the schema mandated by issue #218. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path (audit #218). */
export const FITNESS_SVG_PATH = "docs/screenshots/stock_market/fitness.svg";

/** Neuron / synapse count chart path (audit #218). */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/stock_market/topology.svg";

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-stock/snapshots";

/**
 * Generations at which the runner captures evolution snapshots. The
 * cadence is the canonical NEAT-AI strip; checkpoints past the
 * configured `maxGenerations` simply do not fire.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 50, 100, 200];

/**
 * Iterations per inner `evolveDir` chunk. Each chunk refreshes the
 * passed-in creature in place, so chunking the run gives the CSV / SVG
 * charts visible step changes in neuron / synapse counts as NEAT
 * mutates the topology. The value matches the convention used by
 * `xor_classification.ts` and `mcmc_acceptance.ts` so all audited
 * examples keep telemetry resolution aligned.
 */
const TELEMETRY_CHUNK_ITERATIONS = 25;

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
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, the running champion
   * is captured at every generation matching `snapshotConfig.checkpoints`
   * and written to `snapshotConfig.outputDir`.
   */
  snapshotConfig?: SnapshotConfig;
  /**
   * Existing data directory containing the binary training file. When
   * omitted the caller is expected to populate the directory before
   * calling — see {@link writeStockTrainingDataset}.
   */
  dataDir: string;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  /** Best fitness in this generation (max across the population). */
  bestFitness: number;
  /** Best mean-squared error in this generation (≈ `1 - bestFitness`). */
  bestError: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** One row of per-generation evolution telemetry (audit issue #218). */
export interface EvolutionRow {
  /** 1-based generation index. */
  generation: number;
  /** Best fitness in this generation (max across the population). */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /** Neuron count of this generation's champion. */
  neuronCount: number;
  /** Synapse count of this generation's champion. */
  synapseCount: number;
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
 * Compute the schedule of segment endpoints. The list always ends at
 * `maxGenerations`. Checkpoint values that fall within
 * `[1, maxGenerations]` become extra segment boundaries so a snapshot
 * can be captured at exactly that generation.
 */
export function planSegments(
  checkpoints: readonly number[],
  maxGenerations: number,
): number[] {
  const set = new Set<number>();
  for (const c of checkpoints) {
    if (c >= 1 && c <= maxGenerations) set.add(c);
  }
  set.add(maxGenerations);
  return [...set].sort((a, b) => a - b);
}

/**
 * Run NEAT structural evolution to learn next-period direction.
 *
 * The runner builds the **uniform-random seed creature** via
 * {@link buildRandomSeedCreature} (no hidden neurons, random weights and
 * output bias from the seeded PRNG) and delegates structural mutation
 * to the library via `creature.evolveDir(dataDir, ...)`. Snapshots are
 * captured at `options.snapshotConfig.checkpoints` by splitting the run
 * into segments that end at each checkpoint, allowing the running
 * champion (and its discovered topology) to be recorded as it grows.
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

  const checkpoints = options.snapshotConfig ? [...options.snapshotConfig.checkpoints] : [];
  const segmentEnds = planSegments(checkpoints, options.maxGenerations);

  let priorGenerations = 0;
  let lastError = Number.POSITIVE_INFINITY;
  let lastScore = -Infinity;
  let solved = false;

  // Read the live `creature.neurons` / `creature.synapses` arrays
  // rather than `exportJSON()` — the latter produces a compacted /
  // canonicalised view that does not always reflect mid-run structural
  // growth, while the live arrays do (matching the pattern used by
  // `xor_classification.ts`, issue #205).
  const countTopology = () => ({
    neurons: creature.neurons.length,
    synapses: creature.synapses.length,
  });
  let topology = countTopology();

  for (const endGen of segmentEnds) {
    const segmentIterations = endGen - priorGenerations;
    if (segmentIterations <= 0) continue;

    let segmentEvolved = 0;
    while (segmentEvolved < segmentIterations) {
      const remaining = segmentIterations - segmentEvolved;
      const chunkIterations = Math.min(TELEMETRY_CHUNK_ITERATIONS, remaining);
      topology = countTopology();

      const chunkOffset = priorGenerations;
      const neatOptions: NeatOptions = {
        seed: options.seed + chunkOffset,
        populationSize: options.populationSize,
        iterations: chunkIterations,
        targetError: Math.max(0, Math.min(1, options.errorThreshold)),
        // Audit policy: 5-minute safety backstop. Tests pass 0 to skip
        // because activating the option loads NEAT-AI's GPU / discovery
        // dynamic library that Deno's --allow-ffi sanitizer flags.
        ...(options.timeoutMinutes > 0
          ? { timeoutMinutes: Math.max(1, Math.floor(options.timeoutMinutes)) }
          : {}),
        // No `feedbackLoop` key → engine runs forward-only, the
        // canonical mode for binary `.bin` regression sets.
        costOfGrowth: 0,
        mutationRate: options.mutationRate,
        mutationAmount: options.mutationAmount,
        verbose: false,
        log: 0,
        threads: 1,
        onTrainingEvent: (event) => {
          if (event.kind !== "generation_complete") return;
          const fitness = event.bestFitness;
          // score = 1 - error - growthPenalty. With costOfGrowth=0 the
          // growth penalty is 0, so error ≈ 1 - fitness within 1e-6.
          const error = Math.max(0, 1 - fitness);
          options.onGeneration?.({
            generation: chunkOffset + event.generation,
            bestFitness: fitness,
            bestError: error,
            meanFitness: event.averageFitness,
            neurons: topology.neurons,
            synapses: topology.synapses,
          });
        },
      };

      const result = await creature.evolveDir(options.dataDir, neatOptions);
      const completed = result.generation ?? chunkIterations;
      priorGenerations += completed;
      segmentEvolved += completed;
      lastError = result.error;
      lastScore = result.score;

      // Per-generation events fired during evolveDir capture the
      // chunk's starting topology — NEAT-AI's structural mutations
      // happen inside the call and the live `creature` arrays only
      // reflect them once it returns. Emit one "post-chunk" event so
      // the CSV / SVG charts pick up topology growth that landed
      // during the chunk.
      const postTopology = countTopology();
      if (
        postTopology.neurons !== topology.neurons ||
        postTopology.synapses !== topology.synapses
      ) {
        options.onGeneration?.({
          generation: priorGenerations,
          bestFitness: lastScore,
          bestError: Math.max(0, lastError),
          meanFitness: Number.NaN,
          neurons: postTopology.neurons,
          synapses: postTopology.synapses,
        });
      }

      if (lastError <= options.errorThreshold) {
        solved = true;
        break;
      }
      if (completed < chunkIterations) break;
    }
    topology = countTopology();

    // Capture a snapshot whenever this segment ends on a configured
    // checkpoint.
    if (options.snapshotConfig && checkpoints.includes(endGen)) {
      captureSnapshot(
        options.snapshotConfig,
        endGen,
        creature.exportJSON() as unknown,
        lastScore,
      );
    }

    if (solved) break;
  }

  return {
    champion: creature,
    bestFitness: lastScore,
    bestError: lastError,
    generations: priorGenerations,
    solved,
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

/**
 * Format a finite number for CSV emission. Trailing zeros are trimmed
 * so byte-deterministic identical inputs produce one canonical string.
 */
function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/** Format the per-generation telemetry as a CSV string. */
export function formatEvolutionCsv(rows: readonly EvolutionRow[]): string {
  const lines: string[] = [EVOLUTION_CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.generation,
        formatCsvNumber(r.bestFitness),
        formatCsvNumber(r.meanFitness),
        r.neuronCount,
        r.synapseCount,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ---- Telemetry SVG renderers -------------------------------------------
// Two purpose-built charts requested by issue #218: best/mean fitness on
// one chart, neuron/synapse count on another. Pure string emission to
// match the convention used by xor_classification.ts and
// mcmc_acceptance.ts.
const TELEMETRY_SVG_WIDTH = 720;
const TELEMETRY_SVG_HEIGHT = 320;
const TELEMETRY_MARGIN = { top: 36, right: 70, bottom: 44, left: 60 };

interface PolylinePoint {
  x: number;
  y: number;
}

function buildPolyline(points: readonly PolylinePoint[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

/**
 * Render a two-line chart: best fitness (blue) and mean fitness
 * (orange) versus generation. Throws if `rows` is empty.
 */
export function renderFitnessChartSvg(rows: readonly EvolutionRow[]): string {
  if (rows.length === 0) {
    throw new Error("renderFitnessChartSvg requires at least one row");
  }
  const innerW = TELEMETRY_SVG_WIDTH - TELEMETRY_MARGIN.left - TELEMETRY_MARGIN.right;
  const innerH = TELEMETRY_SVG_HEIGHT - TELEMETRY_MARGIN.top - TELEMETRY_MARGIN.bottom;
  const innerX = TELEMETRY_MARGIN.left;
  const innerY = TELEMETRY_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const allFitness = rows.flatMap((r) => [r.bestFitness, r.meanFitness]).filter(
    Number.isFinite,
  );
  const minF = allFitness.length > 0 ? Math.min(...allFitness) : 0;
  const maxF = allFitness.length > 0 ? Math.max(...allFitness) : 1;
  const fSpan = (maxF - minF) || 1;

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const yScale = (f: number) => innerY + innerH - ((f - minF) / fSpan) * innerH;
  const safeY = (f: number): number => Number.isFinite(f) ? yScale(f) : (innerY + innerH);

  const bestPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: safeY(r.bestFitness),
  }));
  const meanPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: safeY(r.meanFitness),
  }));

  const yTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const v = minF + t * fSpan;
    const ty = innerY + innerH - t * innerH;
    yTicks.push(
      `    <line x1="${innerX.toFixed(2)}" y1="${ty.toFixed(2)}" ` +
        `x2="${(innerX + innerW).toFixed(2)}" y2="${ty.toFixed(2)}" ` +
        `stroke="#eeeeee" stroke-width="0.6"/>`,
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ty + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#444">` +
        `${v.toFixed(3)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TELEMETRY_SVG_WIDTH} ${TELEMETRY_SVG_HEIGHT}" ` +
    `width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" role="img" ` +
    `aria-label="Stock-Market — best vs mean fitness per generation">`,
    `  <title>Stock Market — Best vs Mean Fitness</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Stock Market — Best vs Mean Fitness</text>`,
    yTicks.join("\n"),
    `  <polyline class="best-fitness" fill="none" stroke="#1f77b4" stroke-width="2" ` +
    `points="${buildPolyline(bestPts)}"/>`,
    `  <polyline class="mean-fitness" fill="none" stroke="#ff7f0e" stroke-width="1.4" ` +
    `stroke-dasharray="4 3" points="${buildPolyline(meanPts)}"/>`,
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`,
    `    <rect x="${(innerX + innerW - 178).toFixed(2)}" y="${(innerY + 6).toFixed(2)}" ` +
    `width="172" height="44" fill="#ffffff" fill-opacity="0.9" stroke="#cccccc"/>`,
    `    <line x1="${(innerX + innerW - 168).toFixed(2)}" y1="${(innerY + 18).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 144).toFixed(2)}" y2="${(innerY + 18).toFixed(2)}" ` +
    `stroke="#1f77b4" stroke-width="2"/>`,
    `    <text x="${(innerX + innerW - 138).toFixed(2)}" y="${(innerY + 21).toFixed(2)}">` +
    `best fitness</text>`,
    `    <line x1="${(innerX + innerW - 168).toFixed(2)}" y1="${(innerY + 36).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 144).toFixed(2)}" y2="${(innerY + 36).toFixed(2)}" ` +
    `stroke="#ff7f0e" stroke-width="1.4" stroke-dasharray="4 3"/>`,
    `    <text x="${(innerX + innerW - 138).toFixed(2)}" y="${(innerY + 39).toFixed(2)}">` +
    `mean fitness</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/**
 * Render the neuron / synapse count chart for the README. Two lines
 * share an X axis; the right Y axis shows synapse counts on a separate
 * scale so the synapse line does not compress the neuron line into
 * invisibility.
 */
export function renderTopologyChartSvg(rows: readonly EvolutionRow[]): string {
  if (rows.length === 0) {
    throw new Error("renderTopologyChartSvg requires at least one row");
  }
  const innerW = TELEMETRY_SVG_WIDTH - TELEMETRY_MARGIN.left - TELEMETRY_MARGIN.right;
  const innerH = TELEMETRY_SVG_HEIGHT - TELEMETRY_MARGIN.top - TELEMETRY_MARGIN.bottom;
  const innerX = TELEMETRY_MARGIN.left;
  const innerY = TELEMETRY_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const neurons = rows.map((r) => r.neuronCount);
  const synapses = rows.map((r) => r.synapseCount);
  const maxNeurons = Math.max(...neurons, 1);
  const maxSynapses = Math.max(...synapses, 1);

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const neuronY = (n: number) => innerY + innerH - (n / maxNeurons) * innerH;
  const synapseY = (s: number) => innerY + innerH - (s / maxSynapses) * innerH;

  const neuronPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: neuronY(r.neuronCount),
  }));
  const synapsePts = rows.map((r) => ({
    x: xScale(r.generation),
    y: synapseY(r.synapseCount),
  }));

  const leftTicks: string[] = [];
  const rightTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const ly = innerY + innerH - t * innerH;
    leftTicks.push(
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#2ca02c">` +
        `${(t * maxNeurons).toFixed(0)}</text>`,
    );
    rightTicks.push(
      `    <text x="${(innerX + innerW + 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="start" font-family="sans-serif" font-size="10" fill="#d62728">` +
        `${(t * maxSynapses).toFixed(0)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TELEMETRY_SVG_WIDTH} ${TELEMETRY_SVG_HEIGHT}" ` +
    `width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" role="img" ` +
    `aria-label="Stock-Market — neuron and synapse counts per generation">`,
    `  <title>Stock Market — Topology Growth</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Stock Market — Topology Growth</text>`,
    leftTicks.join("\n"),
    rightTicks.join("\n"),
    `  <polyline class="neuron-count" fill="none" stroke="#2ca02c" stroke-width="2" ` +
    `points="${buildPolyline(neuronPts)}"/>`,
    `  <polyline class="synapse-count" fill="none" stroke="#d62728" stroke-width="2" ` +
    `stroke-dasharray="6 3" points="${buildPolyline(synapsePts)}"/>`,
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`,
    `    <rect x="${(innerX + innerW - 198).toFixed(2)}" y="${(innerY + 6).toFixed(2)}" ` +
    `width="190" height="44" fill="#ffffff" fill-opacity="0.9" stroke="#cccccc"/>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 18).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 18).toFixed(2)}" ` +
    `stroke="#2ca02c" stroke-width="2"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 21).toFixed(2)}">` +
    `neurons (left axis)</text>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 36).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 36).toFixed(2)}" ` +
    `stroke="#d62728" stroke-width="2" stroke-dasharray="6 3"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 39).toFixed(2)}">` +
    `synapses (right axis)</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
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
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionRows: EvolutionRow[] = [];
  const evolutionStart = Date.now();
  const result = await evolveStockController({
    ...DEFAULT_EVOLVE_OPTIONS,
    dataDir,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestFitness, bestError, meanFitness, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestFitness, neurons, synapses });
      evolutionRows.push({
        generation,
        bestFitness,
        meanFitness,
        neuronCount: neurons,
        synapseCount: synapses,
      });
      if (
        generation % 10 === 0 ||
        bestError <= DEFAULT_EVOLVE_OPTIONS.errorThreshold ||
        generation === DEFAULT_EVOLVE_OPTIONS.maxGenerations - 1
      ) {
        console.log(
          `   Gen ${generation.toString().padStart(4)}  ` +
            `bestFitness=${bestFitness.toFixed(4)}  ` +
            `bestError=${bestError.toFixed(4)}  ` +
            `meanFitness=${Number.isFinite(meanFitness) ? meanFitness.toFixed(4) : "n/a"}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const wallClockMs = Date.now() - evolutionStart;
  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve (within budget)"} ` +
      `after ${result.generations} generations ` +
      `(error=${result.bestError.toFixed(4)}, fitness=${result.bestFitness.toFixed(4)}, ` +
      `wall-clock=${(wallClockMs / 1000).toFixed(1)}s).`,
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

  // Render the per-generation evolution chart (best score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Stock-Market — Evolution",
      scoreLabel: "best fitness (1 - MSE)",
    });
    ensureDirSync("docs/screenshots/stock_market");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Per-generation telemetry artefacts mandated by issue #218: CSV +
  // best/mean fitness chart + neuron/synapse count chart.
  if (evolutionRows.length > 0) {
    ensureDirSync("docs/data/stock_market");
    ensureDirSync("docs/screenshots/stock_market");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(evolutionRows));
    console.log(
      `🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${evolutionRows.length} rows)`,
    );
    await Deno.writeTextFile(FITNESS_SVG_PATH, renderFitnessChartSvg(evolutionRows));
    console.log(`📈 Wrote best/mean fitness chart ${FITNESS_SVG_PATH}`);
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, renderTopologyChartSvg(evolutionRows));
    console.log(`📈 Wrote neuron/synapse chart ${TOPOLOGY_SVG_PATH}`);
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Stock-Market — Evolution Progress",
      caption: {
        finalScore: result.bestFitness,
        totalGenerations: result.generations,
        wallClockMs,
      },
    });
    await Deno.writeTextFile(EVOLUTION_PROGRESS_SVG_PATH, progressionSvg);
    console.log(
      `🧬 Wrote evolution-progression strip ${EVOLUTION_PROGRESS_SVG_PATH} ` +
        `(${snapshots.length} panels)`,
    );
  }

  // Final summary line so the README can quote real measured numbers.
  const finalRow = evolutionRows[evolutionRows.length - 1];
  if (finalRow) {
    console.log(
      `\n🏁 Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${
          Number.isFinite(finalRow.meanFitness) ? finalRow.meanFitness.toFixed(4) : "n/a"
        }  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
