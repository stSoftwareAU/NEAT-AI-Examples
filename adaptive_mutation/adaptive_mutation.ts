/**
 * Adaptive Mutation Rate Demo (issue #86, audited under #212).
 *
 * Demonstrates NEAT-AI's hidden but important **adaptive mutation
 * policy**: tiny seed creatures need new structure (add-neuron,
 * add-synapse), but once a creature has grown enough hidden neurons to
 * represent the task, the remaining error is overwhelmingly down to
 * weight tuning, so the policy automatically shifts away from topology
 * mutations toward weight/bias mutations.
 *
 * The audit (#212) brings this example in line with the minimal-seed +
 * measured-telemetry policy in `AGENTS.md`:
 *
 * 1. The creature passed to NEAT-AI is built **only** from
 *    `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — no hidden-layer hint,
 *    no pre-built `network.json` seed, no hand-tuned shape. NEAT-AI
 *    random-initialises the rest.
 * 2. Evolution runs through `Creature.evolveDir(dataDir, neatOptions)`
 *    over a pre-generated binary `.bin` training set — the topology is
 *    learned by NEAT, not bolted on by the example.
 * 3. Stop conditions are a per-example `targetError` plus a
 *    `timeoutMinutes: 5` safety backstop.
 * 4. Per-generation telemetry (best/mean fitness, neuron count, synapse
 *    count) is captured during `evolveDir` and written out as CSV plus
 *    two summary SVG charts. The README quotes real measured numbers
 *    from the latest run only.
 *
 * The "adaptive mutation" narrative is preserved by the **measured
 * topology trajectory**: from a minimal direct-only seed, NEAT
 * aggressively adds hidden neurons and synapses in the early
 * generations (high topology-mutation share), then stabilises as the
 * adaptive policy reduces topology probability and weight tuning takes
 * over. The chart of neuron / synapse count vs generation is the
 * adaptive policy in action.
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

import { buildLargeCreature } from "../common/large_creature.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { renderAdaptiveMutationSVG, renderFitnessChartSvg, renderTopologyChartSvg } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".adaptive-mutation";

/** Headline SVG path embedded at the top of the README. */
export const SCREENSHOT_PATH = "docs/screenshots/adaptive_mutation.svg";

/** Mirror copy of the headline SVG under `WORKING_ROOT/output/`. */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "adaptive_mutation.svg");

/** Per-generation telemetry CSV path (audit #212 schema). */
export const EVOLUTION_CSV_PATH = "docs/data/adaptive_mutation/evolution.csv";

/** CSV header — matches the schema mandated by issue #212. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/adaptive_mutation/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/adaptive_mutation/topology.svg";

/**
 * Number of input neurons fed to the NEAT-AI seed.
 *
 * Four inputs and two outputs make the underlying truth function
 * non-linearly separable: direct input → output synapses cannot fit
 * it, so NEAT must invent hidden neurons (and therefore new
 * inter-layer edges) to drive `bestFitness` above the targetError.
 * That structural growth is the visible signal of the adaptive
 * mutation policy at work.
 */
export const INPUT_COUNT = 4;

/** Number of output neurons fed to the NEAT-AI seed. */
export const OUTPUT_COUNT = 2;

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
  /** Random seed for target network, dataset, and NEAT mutation. */
  seed: number;
  /** Number of training records written to the binary `.bin` file. */
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
  /** NEAT population size. Small for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /**
   * Probability that any given creature is mutated each generation.
   * NEAT-AI's default (0.3) is too conservative for a tiny direct-only
   * seed that needs to grow at least one hidden neuron before it can
   * fit the task — push the rate up so the early generations exhibit
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
 * the minimal seed.
 */
export const DEFAULT_ADAPTIVE_MUTATION_CONFIG: AdaptiveMutationConfig = {
  seed: 86086086,
  trainingSize: 96,
  targetError: 0.01,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterations: 250,
  mutationRate: 0.6,
  mutationAmount: 3,
};

/** A single (input, target) record. */
export interface DataPoint {
  inputs: Float32Array;
  targets: Float32Array;
}

/** One row of per-generation evolution telemetry (audit #212 schema). */
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

/** Combined result of running the adaptive-mutation demo. */
export interface AdaptiveMutationResult {
  /** Final champion creature after evolution. */
  champion: Creature;
  /** Per-generation telemetry rows. */
  evolutionRows: EvolutionRow[];
  /** Held-out score (-MSE — higher is better) of the champion. */
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
 * Build the "ground truth" target network the dataset is generated
 * from. The target is **not** the NEAT seed — it just produces labels
 * the evolved creature must learn to reproduce. Hand-shaping the
 * target is fine; only the seed needs to be minimal.
 */
export function buildTargetNetwork(seed: number): Creature {
  return buildLargeCreature({
    inputs: INPUT_COUNT,
    hidden: 6,
    outputs: OUTPUT_COUNT,
    density: 1.0,
    seed: seed ^ 0x7777_7777,
  });
}

/**
 * Generate a deterministic dataset by feeding `size` random inputs
 * through `target`. Inputs are drawn uniformly from `[-1, 1]`.
 */
export function generateDataset(
  target: Creature,
  size: number,
  seed: number,
): DataPoint[] {
  if (size <= 0) {
    throw new Error(`dataset size must be positive, got ${size}`);
  }
  const rng = createDeterministicRandom(seed);
  const dataset: DataPoint[] = [];
  for (let i = 0; i < size; i++) {
    const inputs = new Float32Array(INPUT_COUNT);
    for (let k = 0; k < INPUT_COUNT; k++) {
      inputs[k] = rng() * 2 - 1;
    }
    target.clearState();
    const out = target.activate(inputs);
    const targets = new Float32Array(OUTPUT_COUNT);
    for (let o = 0; o < OUTPUT_COUNT; o++) {
      targets[o] = out[o];
    }
    dataset.push({ inputs, targets });
  }
  return dataset;
}

/**
 * Write `dataset` as a Float32 binary file the NEAT-AI library can
 * consume via `Creature.evolveDir(dir, ...)`. Each record is laid out
 * as `INPUT_COUNT + OUTPUT_COUNT` little-endian floats.
 */
export function writeBinaryDataset(dataset: readonly DataPoint[], dataDir: string): string {
  ensureDirSync(dataDir);
  const stride = INPUT_COUNT + OUTPUT_COUNT;
  const buffer = new Float32Array(dataset.length * stride);
  for (let i = 0; i < dataset.length; i++) {
    for (let k = 0; k < INPUT_COUNT; k++) {
      buffer[i * stride + k] = dataset[i].inputs[k];
    }
    for (let o = 0; o < OUTPUT_COUNT; o++) {
      buffer[i * stride + INPUT_COUNT + o] = dataset[i].targets[o];
    }
  }
  const path = join(dataDir, "training.bin");
  Deno.writeFileSync(path, new Uint8Array(buffer.buffer));
  return path;
}

/**
 * Held-out score (-MSE — higher is better) of `creature` against
 * `dataset`. The creature's own `activate(...)` is used so any squash
 * NEAT-AI evolved is evaluated correctly.
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
 *   1. Pre-generate a binary `.bin` training set from a hand-shaped
 *      target network.
 *   2. Seed `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (minimal, no
 *      hidden hint).
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
    // Build the target network and synthesise the training and
    // held-out datasets. The target is purely the source of labels; it
    // is not the NEAT seed.
    const target = buildTargetNetwork(config.seed);
    const trainingSet = generateDataset(
      target,
      config.trainingSize,
      config.seed ^ 0x1234_5678,
    );
    const heldOutSet = generateDataset(
      target,
      Math.max(32, Math.floor(config.trainingSize / 2)),
      config.seed ^ 0x9abc_def0,
    );

    if (ownDataDir) writeBinaryDataset(trainingSet, dataDir);

    // Seed = minimal direct-only creature. NEAT-AI random-initialises
    // weights and bias for direct input → output edges; no hidden
    // neurons exist yet.
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);

    const rows: EvolutionRow[] = [];
    let evolved = 0;
    let lastError = Number.POSITIVE_INFINITY;
    let solved = false;

    // Read live `creature.neurons` / `creature.synapses` arrays to
    // capture mid-run topology growth (matches the pattern used by
    // synthetic_synapse_example.ts and xor_classification.ts).
    const countTopology = () => ({
      neurons: creature.neurons.length,
      synapses: creature.synapses.length,
    });

    while (evolved < config.maxIterations) {
      // Pre-chunk topology snapshot. NEAT-AI only updates the
      // passed-in `creature` at the end of each evolveDir call, so the
      // event handler reports these counts for every event inside the
      // chunk; the next chunk re-reads after the await resolves.
      const segmentStart = countTopology();
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
      // counts so the CSV/SVG charts pick up structural growth that
      // landed during the chunk. Without this row a chunk-internal
      // ADD_NODE / ADD_CONN would not appear until the next chunk's
      // events.
      const post = countTopology();
      if (post.neurons !== segmentStart.neurons || post.synapses !== segmentStart.synapses) {
        rows.push({
          generation: evolved,
          bestFitness: Number.isFinite(result.score)
            ? result.score
            : Math.max(0, 1 - (result.error ?? 1)),
          // No explicit mean-fitness available outside event payloads
          // — flag with NaN so renderers can skip cleanly.
          meanFitness: Number.NaN,
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
        r.neuronCount,
        r.synapseCount,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Adaptive Mutation Rate Demo (issue #86, audited #212)");
  console.log("");

  const { dataDir, creaturesDir } = setupWorkingDirs(WORKING_ROOT);

  console.log(
    "🌱 Building minimal NEAT-AI seed: " +
      `new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  console.log("📊 Generating synthetic dataset and writing binary .bin training set...");

  const config = DEFAULT_ADAPTIVE_MUTATION_CONFIG;
  // Pre-generate the binary dataset so the demo + downstream artefacts
  // share one file location.
  const target = buildTargetNetwork(config.seed);
  const trainingSet = generateDataset(target, config.trainingSize, config.seed ^ 0x1234_5678);
  writeBinaryDataset(trainingSet, dataDir);

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
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
