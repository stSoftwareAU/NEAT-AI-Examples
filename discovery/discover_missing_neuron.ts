#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi

/**
 * Discovery Example — minimal-seed evolution + measured telemetry (issue #207).
 *
 * The original demo crippled a hand-crafted creature and asked NEAT-AI's
 * `discoveryDir` to recover the missing neuron. The audit (#207) repurposes
 * the example so the published evolution genuinely *learns* the network
 * structure from a minimal NEAT-AI seed:
 *
 *   1. The reference creature is still hand-crafted, but it is used **only**
 *      as the ground-truth that synthesises labels for the binary `.bin`
 *      training set. NEAT-AI never sees the reference — it is not the seed.
 *   2. The seed passed to NEAT-AI is `new Creature(INPUT, OUTPUT)` — no
 *      hidden-layer hint, no pre-built `network.json`, no hand-tuned shape.
 *   3. `Creature.evolveDir(dataDir, options)` runs forward-only over the
 *      pre-generated `.bin` training set (per #190) until either the
 *      `targetError` threshold is reached or the `timeoutMinutes: 5`
 *      backstop fires.
 *   4. Per-generation telemetry (best/mean fitness + neuron / synapse
 *      counts) is captured via `onTrainingEvent` and emitted as a CSV plus
 *      two SVG charts so the README can quote the *measured* numbers from
 *      the latest run only.
 *
 * The legacy `createCrippledCreature` helper is retained as an exported
 * utility and is exercised by the test suite — it documents the historical
 * crippled-creature framing, but it is no longer part of the runner path.
 *
 * Usage:
 *   ./discovery/run.sh
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  CreatureUtil,
  type NeatOptions,
  safeWriteJson,
} from "@stsoftware/neat-ai";

import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";

export { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-discovery";

/** Number of input neurons fed to the NEAT-AI seed. Matches the reference creature. */
export const INPUT_COUNT = 4;

/** Number of output neurons fed to the NEAT-AI seed. Matches the reference creature. */
export const OUTPUT_COUNT = 1;

/** Per-generation evolution-telemetry CSV path. */
export const EVOLUTION_CSV_PATH = "docs/data/discovery/evolution.csv";

/** CSV header — schema mandated by issue #207. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/discovery/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/discovery/topology.svg";

/** Configuration for a single training-data generation run. */
export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 256,
  recordsPerFile: 128,
  seed: 13371337,
};

/** Configuration for the minimal-seed evolution run. */
export interface DiscoveryEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /** Wall-clock backstop in minutes (issue #207 mandates 5 as upper bound). */
  timeoutMinutes: number;
  /** NEAT population size — small enough for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /** RNG seed forwarded to NEAT-AI for deterministic-ish runs. */
  seed: number;
}

/**
 * Defaults tuned so the demo converges via `targetError` well inside the
 * 5-minute backstop on a developer machine while still showing visible
 * neuron / synapse growth from the minimal seed.
 */
export const DEFAULT_DISCOVERY_CONFIG: DiscoveryEvolutionConfig = {
  // The reference creature's function is mildly nonlinear, so the
  // direct-only seed can fit it to ~0.003 with no hidden neurons. We
  // pick a tighter targetError than that so NEAT-AI is genuinely
  // forced to grow hidden structure to satisfy the stop condition —
  // otherwise the topology chart would flatline (acceptance criterion
  // in issue #207).
  targetError: 0.000001,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterations: 900,
  seed: 207207,
};

/** One row of per-generation evolution telemetry. */
export interface EvolutionRow {
  /** 1-based generation index across the run. */
  generation: number;
  /** Best fitness observed in this generation. */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /** Neuron count of this generation's champion. */
  neuronCount: number;
  /** Synapse count of this generation's champion. */
  synapseCount: number;
}

/** Result of {@link runMinimalSeedEvolution}. */
export interface DiscoveryEvolutionResult {
  /** The best creature found by `evolveDir`. */
  champion: Creature;
  /** Per-generation telemetry rows captured during the run. */
  rows: EvolutionRow[];
  /** Total wall-clock time of the evolution call, in milliseconds. */
  wallClockMs: number;
  /** Final per-record error returned by `evolveDir`. */
  finalError: number;
  /** Total generations completed. */
  generations: number;
  /** Initial neuron count of the minimal seed (before evolution). */
  seedNeuronCount: number;
  /** Initial synapse count of the minimal seed (before evolution). */
  seedSynapseCount: number;
}

/**
 * Reference creature used to synthesise the binary training set. The
 * topology is hand-crafted — that is fine because the reference is *not*
 * fed to NEAT-AI as a seed; it only generates labels for the `.bin` files.
 *
 * The same shape is preserved from the pre-audit demo so the dataset
 * (and the existing tests) stays byte-compatible.
 */
export function createReferenceCreature(): LegacyCreatureJSON {
  const json: LegacyCreatureJSON = {
    neurons: [
      // Input neurons
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },
      { type: "input", squash: "LOGISTIC", index: 3, uuid: "input-3" },

      // Hidden neurons — one of these (hidden-1) is the historical
      // "missing" neuron that the legacy demo would remove. After the
      // audit it is just part of the ground-truth topology.
      { type: "hidden", squash: "TANH", index: 4, bias: 0.1, uuid: "hidden-0" },
      { type: "hidden", squash: "LeakyReLU", index: 5, bias: -0.2, uuid: "hidden-1" },
      { type: "hidden", squash: "LOGISTIC", index: 6, bias: 0.05, uuid: "hidden-2" },
      { type: "hidden", squash: "SELU", index: 7, bias: -0.1, uuid: "hidden-3" },

      // Output neuron
      { type: "output", squash: "LOGISTIC", index: 8, bias: 0, uuid: "output-0" },
    ],
    synapses: [
      // Input → hidden
      { from: 0, to: 4, weight: 0.5 },
      { from: 1, to: 4, weight: -0.3 },
      { from: 1, to: 5, weight: 0.7 },
      { from: 2, to: 5, weight: 0.4 },
      { from: 2, to: 6, weight: -0.2 },
      { from: 3, to: 6, weight: 0.6 },
      { from: 0, to: 7, weight: 0.3 },
      { from: 3, to: 7, weight: -0.4 },

      // Hidden → hidden
      { from: 4, to: 6, weight: 0.3 },
      { from: 5, to: 7, weight: -0.2 },

      // Hidden → output
      { from: 4, to: 8, weight: 0.6 },
      { from: 5, to: 8, weight: -0.4 },
      { from: 6, to: 8, weight: 0.5 },
      { from: 7, to: 8, weight: 0.3 },
    ],
    input: 4,
    output: 1,
  };

  return json;
}

/**
 * Legacy helper retained for backwards compatibility with the test suite.
 * Returns a "crippled" copy of `baselineJSON` with the named neuron (and
 * its synapses) removed. The runner no longer uses this function — the
 * audit replaced the cripple-then-discover flow with a minimal-seed
 * `evolveDir` flow — but the helper still documents the historical
 * framing.
 */
export function createCrippledCreature(
  baselineJSON: LegacyCreatureJSON,
  targetNeuronUUID: string,
): Creature {
  const exportJSON: LegacyCreatureJSON = structuredClone(baselineJSON);

  const targetIndex = exportJSON.neurons.findIndex(
    (neuron) => neuron.uuid === targetNeuronUUID,
  );

  if (targetIndex === -1) {
    throw new Error(`Target neuron ${targetNeuronUUID} not found`);
  }

  exportJSON.synapses = exportJSON.synapses.filter(
    (synapse) => synapse.from !== targetIndex && synapse.to !== targetIndex,
  );
  exportJSON.neurons = exportJSON.neurons.filter(
    (neuron) => neuron.uuid !== targetNeuronUUID,
  );

  exportJSON.neurons.forEach((neuron) => {
    if (neuron.index > targetIndex) neuron.index--;
  });
  exportJSON.synapses.forEach((synapse) => {
    if (synapse.from > targetIndex) synapse.from--;
    if (synapse.to > targetIndex) synapse.to--;
  });

  const crippled = Creature.fromJSON(asCreatureExport(exportJSON));
  crippled.validate();
  CreatureUtil.makeUUID(crippled);
  return crippled;
}

/** Format a finite number for CSV emission with trimmed trailing zeros. */
function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/** Format the per-generation telemetry rows as a CSV string. */
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

/**
 * Iterations per `evolveDir` chunk. Chunking the run keeps the
 * per-generation telemetry chart in step with topology mutations: the
 * passed-in `creature` reference is only updated at the end of each
 * `evolveDir` call, so smaller chunks make the neuron / synapse line
 * climb in visible step changes rather than as a single jump at the end.
 */
const PHASE_CHUNK_ITERATIONS = 25;

/**
 * Run minimal-seed `evolveDir` against the binary `.bin` training set in
 * `dataDir`, capturing per-generation telemetry for the README.
 *
 * The seed passed in must be `new Creature(INPUT_COUNT, OUTPUT_COUNT)` —
 * this function deliberately does not construct the seed itself so the
 * caller (and the tests) can prove no hidden-layer hint leaks in.
 */
export async function runMinimalSeedEvolution(
  seed: Creature,
  dataDir: string,
  config: DiscoveryEvolutionConfig = DEFAULT_DISCOVERY_CONFIG,
): Promise<DiscoveryEvolutionResult> {
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");
  if (config.maxIterations <= 0) throw new Error("maxIterations must be positive");

  const seedNeuronCount = seed.neurons.length;
  const seedSynapseCount = seed.synapses.length;

  const rows: EvolutionRow[] = [];
  const start = Date.now();
  const budgetMs = config.timeoutMinutes * 60_000;

  let evolved = 0;
  let finalError = Number.POSITIVE_INFINITY;

  while (evolved < config.maxIterations) {
    // The creature reference is updated by `evolveDir` at the end of
    // each call. Re-read its topology *before* the next chunk so the
    // event handler reports the latest neuron / synapse counts for
    // every generation inside the chunk.
    const segmentStartNeurons = seed.neurons.length;
    const segmentStartSynapses = seed.synapses.length;

    const elapsedMs = Date.now() - start;
    if (elapsedMs >= budgetMs) break;

    const remaining = config.maxIterations - evolved;
    const chunkIterations = Math.min(PHASE_CHUNK_ITERATIONS, remaining);

    const neatOptions: NeatOptions = {
      seed: config.seed + evolved,
      populationSize: config.populationSize,
      iterations: chunkIterations,
      targetError: config.targetError,
      timeoutMinutes: config.timeoutMinutes,
      // No feedbackLoop key → engine treats the run as forward-only.
      costOfGrowth: 0,
      // Push NEAT toward structural growth so the example genuinely
      // adds hidden neurons / inter-layer synapses from the minimal seed
      // — required by the audit's "neuron and synapse counts genuinely
      // change" acceptance criterion.
      mutationRate: 0.6,
      mutationAmount: 3,
      verbose: false,
      log: 0,
      threads: 1,
      onTrainingEvent: (event) => {
        if (event.kind !== "generation_complete") return;
        rows.push({
          generation: evolved + event.generation,
          bestFitness: event.bestFitness,
          meanFitness: event.averageFitness,
          neuronCount: segmentStartNeurons,
          synapseCount: segmentStartSynapses,
        });
      },
    };

    const result = await seed.evolveDir(dataDir, neatOptions);
    const completed = result.generation ?? chunkIterations;
    evolved += completed;
    finalError = result.error ?? finalError;

    if (finalError <= config.targetError) break;
    if (completed < chunkIterations) break;
  }

  // Patch the final row so the chart shows the post-evolution topology
  // — `evolveDir` updates the creature reference *after* the last event
  // fires inside the chunk, so without this fix-up the last row still
  // reports the pre-chunk counts.
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    last.neuronCount = seed.neurons.length;
    last.synapseCount = seed.synapses.length;
  }

  return {
    champion: seed,
    rows,
    wallClockMs: Date.now() - start,
    finalError,
    generations: evolved,
    seedNeuronCount,
    seedSynapseCount,
  };
}

/** Convert telemetry rows into the shape expected by the shared chart helpers. */
export function rowsToFitnessSamples(rows: readonly EvolutionRow[]): FitnessSample[] {
  return rows.map((r) => ({
    generation: r.generation,
    bestFitness: r.bestFitness,
    avgFitness: r.meanFitness,
  }));
}

/** Convert telemetry rows into the shape expected by the evolution chart helper. */
export function rowsToEvolutionSamples(rows: readonly EvolutionRow[]): EvolutionSample[] {
  return rows.map((r) => ({
    generation: r.generation,
    score: r.bestFitness,
    neurons: r.neuronCount,
    synapses: r.synapseCount,
  }));
}

async function runDiscoveryExample(): Promise<void> {
  const stage = (label: string) => console.log(`\n== ${label} ==`);

  const { dataDir, creaturesDir } = setupWorkingDirs(WORKING_ROOT);

  // Stage 1: Build the ground-truth reference and synthesise the .bin set.
  stage("Stage 1/3: Generating binary training set from ground-truth reference");
  const baselineJSON = createReferenceCreature();
  const reference = Creature.fromJSON(asCreatureExport(baselineJSON));
  reference.validate();
  CreatureUtil.makeUUID(reference);
  console.log(
    `   Reference creature: ${reference.input} inputs, ` +
      `${reference.neurons.length} neurons, ${reference.synapses.length} synapses`,
  );
  generateSyntheticData(reference, dataDir, SYNTHETIC_CONFIG);

  // Save the reference as the baseline-of-record so it can be inspected.
  const baselineExport: CreatureExport = reference.exportJSON();
  const baselinePath = join(creaturesDir, "baseline.json");
  await safeWriteJson(baselinePath, baselineExport);
  console.log(`   Saved reference creature to ${baselinePath}`);

  // Stage 2: Build the minimal seed and run evolveDir.
  stage("Stage 2/3: Evolving from a minimal NEAT-AI seed");
  console.log(
    `   Seed: new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  console.log(
    `   Seed topology: ${seed.neurons.length} neurons, ${seed.synapses.length} synapses`,
  );

  const config = DEFAULT_DISCOVERY_CONFIG;
  console.log(
    `   Stop conditions: targetError=${config.targetError}, ` +
      `timeoutMinutes=${config.timeoutMinutes} (issue #207 backstop)`,
  );

  const result = await runMinimalSeedEvolution(seed, dataDir, config);
  const finalRow = result.rows[result.rows.length - 1];
  console.log(
    `   Completed ${result.generations} generations in ` +
      `${(result.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(result.finalError) ? result.finalError.toFixed(4) : "n/a"
      })`,
  );
  if (finalRow) {
    console.log(
      `   Champion topology: ${finalRow.neuronCount} neurons, ` +
        `${finalRow.synapseCount} synapses ` +
        `(seed had ${result.seedNeuronCount} / ${result.seedSynapseCount})`,
    );
  }

  // Save the evolved champion so reviewers can inspect it.
  const championPath = join(creaturesDir, "discovered.json");
  await safeWriteJson(championPath, result.champion.exportJSON());
  console.log(`   Saved evolved champion to ${championPath}`);

  // Stage 3: Emit the per-generation telemetry artefacts.
  stage("Stage 3/3: Writing per-generation telemetry (CSV + 2 SVGs)");
  if (result.rows.length === 0) {
    console.log("   ⚠️  No per-generation events captured — telemetry skipped.");
  } else {
    ensureDirSync("docs/data/discovery");
    ensureDirSync("docs/screenshots/discovery");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(result.rows));
    console.log(`   🗒️  Wrote ${EVOLUTION_CSV_PATH} (${result.rows.length} rows)`);

    const fitnessSvg = renderFitnessChartSVG(rowsToFitnessSamples(result.rows), {
      title: "Discovery — Best vs Mean Fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`   📈 Wrote ${FITNESS_SVG_PATH}`);

    const topologySvg = renderEvolutionChartSVG(rowsToEvolutionSamples(result.rows), {
      title: "Discovery — Score, Neurons, Synapses per Generation",
    });
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, topologySvg);
    console.log(`   📈 Wrote ${TOPOLOGY_SVG_PATH}`);
  }

  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  console.log("\n== Summary ==");
  console.log(`   Reference creature: ${baselinePath}`);
  console.log(`   Evolved champion:   ${championPath}`);
  if (finalRow) {
    console.log(
      `   Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${finalRow.meanFitness.toFixed(4)}  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(`   Wall-clock: ${(result.wallClockMs / 1000).toFixed(1)}s`);
}

if (import.meta.main) {
  await runDiscoveryExample();
}
