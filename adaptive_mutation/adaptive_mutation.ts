/**
 * Adaptive Mutation Rate Demo (issue #86, audited under #212, rewired #263).
 *
 * Demonstrates NEAT-AI's hidden but important **adaptive mutation
 * policy**: tiny seed creatures need new structure (add-neuron,
 * add-synapse), but once a creature has grown enough hidden neurons to
 * represent the task, the remaining error is overwhelmingly down to
 * weight tuning, so the policy automatically shifts away from topology
 * mutations toward weight/bias mutations.
 *
 * Under issue #263 the synthetic "imitate a hand-shaped target network"
 * regression framing was replaced with the concrete binary
 * classification task added in #262 — 4-bit even parity. The example
 * now demonstrates the library finding a real solution to a common
 * problem (parity, the textbook XOR generalisation) from a
 * uniform-random seed, satisfying issue #254's mandate.
 *
 * Policy compliance:
 *
 * 1. The creature passed to NEAT-AI is built **only** from
 *    `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — no hidden-layer hint,
 *    no pre-built `network.json` seed, no hand-tuned shape, no warm
 *    start. NEAT-AI random-initialises the rest.
 * 2. Evolution runs through `Creature.evolveDir(dataDir, neatOptions)`
 *    over a pre-generated binary `.bin` classification training set —
 *    the topology is learned by NEAT, not bolted on by the example.
 * 3. Stop conditions are a per-example `targetError` plus a
 *    `timeoutMinutes: 5` safety backstop.
 * 4. Per-generation telemetry (best/mean fitness, accuracy, neuron
 *    count, synapse count) is captured during `evolveDir` and written
 *    out as CSV plus two summary SVG charts. The README quotes real
 *    measured numbers from the latest run only.
 *
 * The "adaptive mutation" narrative is preserved by the **measured
 * topology trajectory**: from a minimal direct-only seed (which cannot
 * represent parity at all), NEAT aggressively adds hidden neurons and
 * synapses in the early generations (high topology-mutation share),
 * then stabilises as the adaptive policy reduces topology probability
 * and weight tuning takes over. The chart of neuron / synapse count vs
 * generation is the adaptive policy in action; accuracy climbs from
 * near-chance to high values as the topology grows.
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

import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  classifierAccuracy,
  type DataPoint,
  generateClassificationDataset,
  INPUT_COUNT as TASK_INPUT_COUNT,
  OUTPUT_COUNT as TASK_OUTPUT_COUNT,
  TASK_NAME,
  TRUTH_TABLE_SIZE,
  writeBinaryClassificationDataset,
} from "./classification_task.ts";
import { renderAdaptiveMutationSVG, renderFitnessChartSvg, renderTopologyChartSvg } from "./svg.ts";

/** Re-export so downstream callers continue to use a single import surface. */
export type { DataPoint };
export { TASK_NAME };

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".adaptive-mutation";

/** Headline SVG path embedded at the top of the README. */
export const SCREENSHOT_PATH = "docs/screenshots/adaptive_mutation.svg";

/** Mirror copy of the headline SVG under `WORKING_ROOT/output/`. */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "adaptive_mutation.svg");

/** Per-generation telemetry CSV path (audit #212 schema, extended in #263). */
export const EVOLUTION_CSV_PATH = "docs/data/adaptive_mutation/evolution.csv";

/**
 * CSV header — matches the schema mandated by issue #212 plus the
 * `accuracy` column added under issue #263 so the classification
 * progress is captured alongside fitness and topology.
 */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,accuracy,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/adaptive_mutation/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/adaptive_mutation/topology.svg";

/**
 * Number of input neurons fed to the NEAT-AI seed. Sourced from the
 * classification task primitives (4-bit parity).
 */
export const INPUT_COUNT = TASK_INPUT_COUNT;

/** Number of output neurons fed to the NEAT-AI seed. */
export const OUTPUT_COUNT = TASK_OUTPUT_COUNT;

/**
 * Iterations per inner `evolveDir` chunk. Each chunk refreshes the
 * passed-in creature in place, so chunking the run gives the CSV / SVG
 * charts visible step changes in neuron/synapse counts as NEAT mutates
 * the topology. The value matches the convention used by the other
 * audited examples (#205, #206) so telemetry resolution stays aligned
 * across the suite.
 */
const TELEMETRY_CHUNK_ITERATIONS = 50;

/** Configuration for {@link runAdaptiveMutationDemo}. */
export interface AdaptiveMutationConfig {
  /** Random seed for the classification dataset and NEAT mutation. */
  seed: number;
  /**
   * Number of training records written to the binary `.bin` file.
   * For 4-bit parity, the full truth table is 16 rows; the demo defaults
   * to the full table so class balance is perfect.
   */
  trainingSize: number;
  /** Per-example `targetError` driving early exit from evolution. */
  targetError: number;
  /**
   * Wall-clock backstop in minutes for the run. Issue #212 mandates
   * 5 minutes as the upper bound. NEAT-AI requires a positive integer,
   * so a minimum of 1 is enforced internally. Tests may set this to 0
   * to suppress NEAT-AI's GPU/discovery FFI cleanup paths and keep the
   * Deno test sanitiser clean.
   */
  timeoutMinutes: number;
  /** NEAT population size. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /**
   * Probability that any given creature is mutated each generation.
   * NEAT-AI's default (0.3) is too conservative for a tiny direct-only
   * seed that needs to grow at least one hidden neuron before it can
   * fit parity — push the rate up so the early generations exhibit
   * visible structural growth (the adaptive policy then naturally
   * tapers it as size grows).
   */
  mutationRate: number;
  /** Number of mutation operators applied per mutated creature. */
  mutationAmount: number;
}

/**
 * Defaults chosen so the demo converges via `targetError` well inside
 * the 5-minute backstop on a developer machine while still showing the
 * adaptive policy in action through visible neuron/synapse growth from
 * the minimal seed. The training set is the full 4-bit parity truth
 * table (16 rows), so class balance is exact.
 */
export const DEFAULT_ADAPTIVE_MUTATION_CONFIG: AdaptiveMutationConfig = {
  seed: 86086086,
  trainingSize: TRUTH_TABLE_SIZE,
  targetError: 0.05,
  timeoutMinutes: 5,
  populationSize: 50,
  maxIterations: 2000,
  mutationRate: 0.7,
  mutationAmount: 3,
};

/** One row of per-generation evolution telemetry (#212 + #263 schema). */
export interface EvolutionRow {
  /** 1-based generation index. */
  generation: number;
  /** Best fitness in this generation (max across the population). */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /**
   * Population-best classification accuracy in `[0, 1]` measured against
   * the training set at the chunk boundary. Within a chunk every row
   * reports the pre-chunk accuracy; the post-chunk row reports the new
   * accuracy. NaN where accuracy was not measurable.
   */
  accuracy: number;
  /** Neuron count of this generation's champion. */
  neuronCount: number;
  /** Synapse count of this generation's champion. */
  synapseCount: number;
}

/** Combined result of running the adaptive-mutation demo. */
export interface AdaptiveMutationResult {
  /** Final champion creature after evolution. */
  champion: Creature;
  /** Per-generation telemetry rows. */
  evolutionRows: EvolutionRow[];
  /**
   * Held-out classification accuracy in `[0, 1]` of the champion on a
   * separate seeded sample of the classification task.
   */
  heldOutAccuracy: number;
  /**
   * Held-out score (-MSE — higher is better) of the champion against
   * the held-out classification labels. Retained as a numeric secondary
   * metric and consumed by the headline SVG caption renderer.
   */
  heldOutScore: number;
  /** Total wall-clock time of the run, in milliseconds. */
  wallClockMs: number;
  /** True when the champion's training error fell below `targetError`. */
  solved: boolean;
  /** Total generations actually evolved. */
  generations: number;
}

/** Configuration for the documented {@link AdaptivePolicyConfig}. */
export interface AdaptivePolicyConfig {
  /**
   * Topology-mutation probability for a vanishingly small creature
   * (size → 0). Must lie in (0, 1]. NEAT-AI defaults bias toward
   * topology growth on tiny networks; the documented value below is
   * representative.
   */
  baseTopologyProb: number;
  /**
   * Size scale at which the topology probability is halved. Larger
   * values keep topology mutations active for bigger creatures. Must
   * be > 0.
   */
  sizeScale: number;
}

/**
 * Documented analytic policy used by the README to explain how
 * NEAT-AI's mutation operator distribution shifts as a creature grows.
 * This is the closed-form curve the README plots alongside the
 * measured topology trajectory; NEAT-AI's internal policy is more
 * elaborate but follows the same shape.
 */
export const DEFAULT_POLICY_CONFIG: AdaptivePolicyConfig = {
  baseTopologyProb: 0.6,
  sizeScale: 80,
};

/**
 * Probability the policy chooses a **topology** operator for a
 * creature of the given (hidden + synapses) size. Pure function of
 * size; useful in tests, in the SVG legend caption, and in the README
 * where the analytic curve is overlaid against the measured trajectory.
 */
export function topologyProbability(
  size: number,
  policy: AdaptivePolicyConfig = DEFAULT_POLICY_CONFIG,
): number {
  if (policy.baseTopologyProb <= 0 || policy.baseTopologyProb > 1) {
    throw new Error(
      `baseTopologyProb must be in (0, 1], got ${policy.baseTopologyProb}`,
    );
  }
  if (policy.sizeScale <= 0) {
    throw new Error(`sizeScale must be > 0, got ${policy.sizeScale}`);
  }
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`size must be a non-negative finite number, got ${size}`);
  }
  return policy.baseTopologyProb / (1 + size / policy.sizeScale);
}

/**
 * MSE-style held-out score (negated so higher is better) of `creature`
 * against `dataset`. The single-output binary classification target is
 * treated as a real-valued regression target so the renderer can quote
 * a continuous secondary metric alongside accuracy.
 */
export function creatureHeldOutScore(
  creature: Creature,
  dataset: readonly DataPoint[],
): number {
  if (dataset.length === 0) return 0;
  let sum = 0;
  for (const point of dataset) {
    creature.clearState();
    const out = creature.activate(point.inputs);
    for (let o = 0; o < OUTPUT_COUNT; o++) {
      const err = out[o] - point.targets[o];
      sum += err * err;
    }
  }
  return -(sum / dataset.length);
}

/**
 * Run the adaptive-mutation demo end-to-end:
 *
 *   1. Pre-generate a binary `.bin` classification training set from
 *      the 4-bit parity truth table.
 *   2. Seed `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (minimal, no
 *      hidden hint, uniform-random weights — NO warm start).
 *   3. evolveDir over the binary training set in chunks, capturing
 *      per-generation telemetry until `targetError` is met or
 *      iterations / timeout are exhausted.
 *
 * Returns the champion plus the captured telemetry rows.
 */
export async function runAdaptiveMutationDemo(
  config: AdaptiveMutationConfig = DEFAULT_ADAPTIVE_MUTATION_CONFIG,
  options: { dataDir?: string } = {},
): Promise<AdaptiveMutationResult> {
  if (config.trainingSize <= 0) {
    throw new Error(`trainingSize must be positive, got ${config.trainingSize}`);
  }
  if (config.maxIterations <= 0) {
    throw new Error(`maxIterations must be positive, got ${config.maxIterations}`);
  }
  if (config.populationSize <= 0) {
    throw new Error(`populationSize must be positive, got ${config.populationSize}`);
  }
  if (config.timeoutMinutes < 0) {
    throw new Error(`timeoutMinutes must be >= 0, got ${config.timeoutMinutes}`);
  }

  const start = Date.now();
  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ??
    Deno.makeTempDirSync({ prefix: "adaptive_mutation_data_" });

  try {
    // Synthesise the training and held-out classification datasets.
    // The training set is the full truth table; the held-out set is a
    // separate seeded sample so accuracy reporting reflects a distinct
    // draw (even though for parity the truth table is closed).
    const trainingSet = generateClassificationDataset(
      config.seed ^ 0x1234_5678,
      config.trainingSize,
    );
    const heldOutSet = generateClassificationDataset(
      config.seed ^ 0x9abc_def0,
      Math.max(TRUTH_TABLE_SIZE, config.trainingSize * 2),
    );

    if (ownDataDir) writeBinaryClassificationDataset(trainingSet, dataDir);

    // Seed = minimal direct-only creature. NEAT-AI random-initialises
    // weights and bias for direct input → output edges; no hidden
    // neurons exist yet. This is a uniform-random noise seed — NO
    // warm start, no hand-crafted topology, no pretrained champion.
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);

    const rows: EvolutionRow[] = [];
    let evolved = 0;
    let lastError = Number.POSITIVE_INFINITY;
    let solved = false;

    // Read live `creature.neurons` / `creature.synapses` arrays to
    // capture mid-run topology growth.
    const countTopology = () => ({
      neurons: creature.neurons.length,
      synapses: creature.synapses.length,
    });

    // Accuracy of the live creature against the training set; used at
    // chunk boundaries so each row carries a measured accuracy.
    const measureAccuracy = (): number => {
      try {
        return classifierAccuracy(creature, trainingSet);
      } catch {
        return Number.NaN;
      }
    };

    while (evolved < config.maxIterations) {
      // Pre-chunk topology + accuracy snapshot. NEAT-AI only updates
      // the passed-in `creature` at the end of each evolveDir call, so
      // the event handler reports these counts for every event inside
      // the chunk; the next chunk re-reads after the await resolves.
      const segmentStart = countTopology();
      const segmentAccuracy = measureAccuracy();
      const remaining = config.maxIterations - evolved;
      const chunkIterations = Math.min(TELEMETRY_CHUNK_ITERATIONS, remaining);

      const neatOptions: NeatOptions = {
        seed: config.seed + evolved,
        populationSize: config.populationSize,
        iterations: chunkIterations,
        targetError: Math.max(0, config.targetError),
        // The audit policy in #212 mandates a 5-minute backstop. The
        // option triggers NEAT-AI's GPU/discovery FFI cleanup, which
        // Deno's test sanitiser flags as a leak; tests pass 0 so the
        // option is omitted and the sanitiser stays clean while every
        // other code path is still exercised.
        ...(config.timeoutMinutes > 0
          ? { timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)) }
          : {}),
        costOfGrowth: 0,
        mutationRate: config.mutationRate,
        mutationAmount: config.mutationAmount,
        verbose: false,
        log: 0,
        threads: 1,
        onTrainingEvent: (event) => {
          if (event.kind !== "generation_complete") return;
          rows.push({
            generation: evolved + event.generation,
            bestFitness: event.bestFitness,
            meanFitness: event.averageFitness,
            accuracy: segmentAccuracy,
            neuronCount: segmentStart.neurons,
            synapseCount: segmentStart.synapses,
          });
        },
      };

      const result = await creature.evolveDir(dataDir, neatOptions);
      const completed = result.generation ?? chunkIterations;
      evolved += completed;
      lastError = result.error ?? lastError;

      // Post-chunk: emit one extra row capturing the **new** topology
      // counts and the freshly-measured accuracy so the CSV/SVG charts
      // pick up structural growth and accuracy gains that landed during
      // the chunk.
      const post = countTopology();
      const postAccuracy = measureAccuracy();
      const grew = post.neurons !== segmentStart.neurons ||
        post.synapses !== segmentStart.synapses;
      const accuracyChanged = Number.isFinite(postAccuracy) &&
        Number.isFinite(segmentAccuracy) && postAccuracy !== segmentAccuracy;
      if (grew || accuracyChanged) {
        rows.push({
          generation: evolved,
          bestFitness: Number.isFinite(result.score)
            ? result.score
            : Math.max(0, 1 - (result.error ?? 1)),
          // No explicit mean-fitness available outside event payloads
          // — flag with NaN so renderers can skip cleanly.
          meanFitness: Number.NaN,
          accuracy: postAccuracy,
          neuronCount: post.neurons,
          synapseCount: post.synapses,
        });
      }

      if (lastError <= config.targetError) {
        solved = true;
        break;
      }
      // evolveDir may stop early (e.g. timeoutMinutes). Stop chunking
      // when it returns fewer iterations than requested.
      if (completed < chunkIterations) break;
    }

    return {
      champion: creature,
      evolutionRows: rows,
      heldOutAccuracy: classifierAccuracy(creature, heldOutSet),
      heldOutScore: creatureHeldOutScore(creature, heldOutSet),
      wallClockMs: Date.now() - start,
      solved,
      generations: evolved,
    };
  } finally {
    if (ownDataDir) {
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch {
        // Ignore cleanup errors — the temp dir may already be gone.
      }
    }
  }
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
        formatCsvNumber(r.accuracy),
        r.neuronCount,
        r.synapseCount,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Adaptive Mutation Rate Demo (issue #86, audited #212, rewired #263)");
  console.log(`📚 Task: ${TASK_NAME}`);
  console.log("");

  const { dataDir, creaturesDir } = setupWorkingDirs(WORKING_ROOT);

  console.log(
    "🌱 Building minimal NEAT-AI seed: " +
      `new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  console.log("📊 Generating classification dataset and writing binary .bin training set...");

  const config = DEFAULT_ADAPTIVE_MUTATION_CONFIG;
  // Pre-generate the binary dataset so the demo + downstream artefacts
  // share one file location.
  const trainingSet = generateClassificationDataset(
    config.seed ^ 0x1234_5678,
    config.trainingSize,
  );
  writeBinaryClassificationDataset(trainingSet, dataDir);

  console.log(
    `🧪 Running evolution from minimal seed ` +
      `(targetError=${config.targetError}, timeoutMinutes=${config.timeoutMinutes})...`,
  );
  const result = await runAdaptiveMutationDemo(config, { dataDir });

  console.log("");
  console.log(
    `   generations    : ${result.generations}` +
      (result.solved ? "  (solved — targetError reached)" : "  (did not reach targetError)"),
  );
  console.log(`   neurons (final): ${result.champion.neurons.length}`);
  console.log(`   synapses (final): ${result.champion.synapses.length}`);
  console.log(`   training acc   : ${classifierAccuracy(result.champion, trainingSet).toFixed(4)}`);
  console.log(`   held-out acc   : ${result.heldOutAccuracy.toFixed(4)}`);
  console.log(`   held-out score : ${result.heldOutScore.toPrecision(6)}`);

  // Headline SVG: combined topology + analytic policy curve.
  if (result.evolutionRows.length > 0) {
    const svg = renderAdaptiveMutationSVG({
      rows: result.evolutionRows,
      heldOutScore: result.heldOutScore,
      wallClockMs: result.wallClockMs,
      generations: result.generations,
      solved: result.solved,
    });
    ensureDirSync("docs/screenshots");
    ensureDirSync(join(WORKING_ROOT, "output"));
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    await Deno.writeTextFile(WORKING_OUTPUT_PATH, svg);
    console.log(`\n🖼️  Wrote ${SCREENSHOT_PATH}`);
    console.log(`🖼️  Mirror at ${WORKING_OUTPUT_PATH}`);

    // Per-generation telemetry artefacts.
    ensureDirSync("docs/data/adaptive_mutation");
    ensureDirSync("docs/screenshots/adaptive_mutation");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(result.evolutionRows));
    console.log(
      `🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${result.evolutionRows.length} rows)`,
    );
    await Deno.writeTextFile(FITNESS_SVG_PATH, renderFitnessChartSvg(result.evolutionRows));
    console.log(`📈 Wrote best/mean fitness chart ${FITNESS_SVG_PATH}`);
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, renderTopologyChartSvg(result.evolutionRows));
    console.log(`📈 Wrote neuron/synapse chart ${TOPOLOGY_SVG_PATH}`);
  } else {
    console.log("\n⚠️  No per-generation telemetry captured (evolveDir produced zero events)");
  }

  // Save the champion creature for downstream inspection.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  const finalRow = result.evolutionRows[result.evolutionRows.length - 1];
  if (finalRow) {
    console.log(
      `\n🏁 Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `accuracy=${finalRow.accuracy.toFixed(4)}  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
