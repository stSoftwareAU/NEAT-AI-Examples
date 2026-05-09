/**
 * Crossover (Breeding) Example — minimal-seed evolution + measured telemetry (issue #213).
 *
 * The original demo bred two hand-crafted parents into an offspring and then
 * "evolved" the offspring for a handful of generations. The audit (#213)
 * keeps the parent-based crossover demo (parents are exempt hand-crafted
 * state under `AGENTS.md` — they are the demo's whole point), but replaces
 * the post-crossover evolution with a **minimal-seed** `evolveDir` run so
 * the published evolution genuinely *learns* the network structure.
 *
 *   1. Hand-crafted parent A and parent B remain — that is the breeding
 *      demo. Parent A also acts as the **label oracle** for the binary
 *      `.bin` training set (NEAT-AI never sees parent A's topology — only
 *      its inputs / outputs).
 *   2. `performCrossover(parentA, parentB)` is unchanged: it still produces
 *      an offspring you can score and inspect, illustrating the
 *      mother-keep + father-50% breeding operator.
 *   3. The headline **evolution** stage seeds NEAT-AI with
 *      `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — no hidden hint, no
 *      pre-built `network.json`, no warm start — and runs
 *      `Creature.evolveDir(dataDir, options)` over the binary `.bin`
 *      training set in forward-only mode until either the per-example
 *      `targetError` is reached or the `timeoutMinutes: 5` backstop fires.
 *   4. Per-generation telemetry (best/mean fitness + neuron / synapse
 *      counts) is captured via `onTrainingEvent` and emitted as a CSV plus
 *      two SVG charts so the README can quote the *measured* numbers from
 *      the latest run only.
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, CreatureUtil, type NeatOptions, safeWriteJson } from "@stsoftware/neat-ai";
import { addTag } from "@stsoftware/tags/mod";

import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import {
  generateSyntheticData,
  scoreCreature,
  type SyntheticConfig,
} from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  asCreatureExport,
  type LegacyCreatureJSON,
  type LegacyNeuron,
  type LegacySynapse,
} from "../common/legacy_types.ts";

export {
  generateSyntheticData,
  scoreCreature,
  type SyntheticConfig,
} from "../common/synthetic_data.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-crossover";

/** Number of input neurons fed to the NEAT-AI seed (matches both parents). */
export const INPUT_COUNT = 3;

/** Number of output neurons fed to the NEAT-AI seed (matches both parents). */
export const OUTPUT_COUNT = 1;

/** Per-generation evolution-telemetry CSV path. */
export const EVOLUTION_CSV_PATH = "docs/data/crossover/evolution.csv";

/** CSV header — schema mandated by issue #213. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/crossover/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/crossover/topology.svg";

/** Configuration for the synthetic training-data generation. */
export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 500,
  recordsPerFile: 500,
  seed: 77889900,
};

/** Configuration for the minimal-seed evolution run. */
export interface CrossoverEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /** Wall-clock backstop in minutes (issue #213 mandates 5 as upper bound). */
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
 *
 * `targetError` is deliberately tighter than what a direct-input → output
 * seed can reach for parent A's nonlinear sigmoid-of-sigmoids function,
 * so NEAT-AI is forced to grow hidden structure to satisfy the stop
 * condition — otherwise the topology chart would flatline (acceptance
 * criterion in issue #213).
 */
export const DEFAULT_CROSSOVER_EVOLUTION_CONFIG: CrossoverEvolutionConfig = {
  targetError: 0.02,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterations: 1000,
  seed: 213213,
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
export interface CrossoverEvolutionResult {
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
 * Creates the first parent creature (Parent A).
 *
 * This parent uses TANH and LOGISTIC activation functions, representing
 * one "lineage" of neural network architecture. It is hand-crafted —
 * that is fine because the parent is part of the breeding demo's
 * deliberately hand-crafted state (per `AGENTS.md` exemption) and is
 * also used as the label oracle for the synthetic training set. The
 * NEAT-AI evolution stage uses a minimal `new Creature(...)` seed.
 */
export function createParentA(): Creature {
  const json: LegacyCreatureJSON = {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },

      // Hidden layer weights are deliberately large so the TANH and
      // LOGISTIC activations sit deep in their saturation regions —
      // this makes the resulting function non-approximable by a single
      // direct input → output sigmoid, which forces NEAT-AI's
      // minimal-seed evolution to add hidden structure to fit the
      // labels (audit #213 acceptance criterion).
      {
        type: "hidden",
        squash: "TANH",
        index: 3,
        bias: 0.6,
        uuid: "hidden-a0",
      },
      {
        type: "hidden",
        squash: "LOGISTIC",
        index: 4,
        bias: -0.4,
        uuid: "hidden-a1",
      },
      {
        type: "hidden",
        squash: "TANH",
        index: 5,
        bias: 0.2,
        uuid: "hidden-a2",
      },

      {
        type: "output",
        squash: "LOGISTIC",
        index: 6,
        bias: 0,
        uuid: "output-0",
      },
    ],
    synapses: [
      { from: 0, to: 3, weight: 3.0 },
      { from: 1, to: 3, weight: -2.4 },
      { from: 1, to: 4, weight: 3.5 },
      { from: 2, to: 4, weight: 1.8 },
      { from: 0, to: 5, weight: -2.5 },
      { from: 2, to: 5, weight: 2.2 },
      { from: 3, to: 6, weight: 3.2 },
      { from: 4, to: 6, weight: -2.7 },
      { from: 5, to: 6, weight: 2.8 },
    ],
    input: 3,
    output: 1,
  };

  return Creature.fromJSON(asCreatureExport(json));
}

/**
 * Creates the second parent creature (Parent B).
 *
 * This parent uses SELU and LeakyReLU activation functions, representing
 * a different "lineage" of neural network architecture. Same exemption
 * applies as for {@link createParentA}: the parent is hand-crafted demo
 * state, not the seed used by NEAT-AI's evolution stage.
 */
export function createParentB(): Creature {
  const json: LegacyCreatureJSON = {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },

      {
        type: "hidden",
        squash: "SELU",
        index: 3,
        bias: -0.2,
        uuid: "hidden-b0",
      },
      {
        type: "hidden",
        squash: "LeakyReLU",
        index: 4,
        bias: 0.1,
        uuid: "hidden-b1",
      },
      {
        type: "hidden",
        squash: "SELU",
        index: 5,
        bias: 0.08,
        uuid: "hidden-b2",
      },

      {
        type: "output",
        squash: "LOGISTIC",
        index: 6,
        bias: 0,
        uuid: "output-0",
      },
    ],
    synapses: [
      { from: 0, to: 3, weight: -0.3 },
      { from: 1, to: 3, weight: 0.5 },
      { from: 1, to: 4, weight: -0.6 },
      { from: 2, to: 4, weight: 0.4 },
      { from: 0, to: 5, weight: 0.7 },
      { from: 2, to: 5, weight: -0.2 },
      { from: 3, to: 6, weight: -0.5 },
      { from: 4, to: 6, weight: 0.6 },
      { from: 5, to: 6, weight: 0.4 },
    ],
    input: 3,
    output: 1,
  };

  return Creature.fromJSON(asCreatureExport(json));
}

/**
 * Performs crossover between two parent creatures to produce offspring.
 *
 * This implements the core NEAT crossover operation: neurons and synapses
 * from both parents are combined to create a child creature. The mother's
 * (parentA) neurons are always included, while the father's (parentB)
 * unique neurons have a 50% chance of inclusion. Weights and biases of
 * matching structures are blended (averaged) between parents.
 *
 * The construction uses the index-based input format that Creature.fromJSON
 * expects, building a complete neuron and synapse list from scratch.
 *
 * Returns a new creature or undefined if the parents are incompatible.
 */
export function performCrossover(
  parentA: Creature,
  parentB: Creature,
): Creature | undefined {
  if (parentA.input !== parentB.input || parentA.output !== parentB.output) {
    return undefined;
  }

  const random = createDeterministicRandom(SYNTHETIC_CONFIG.seed);
  const inputCount = parentA.input;

  // Build index-based representations from internal creature state.
  // We access neurons and synapses directly from the Creature instances
  // to get index-based from/to values that Creature.fromJSON expects.
  const neuronsA = parentA.neurons;
  const neuronsB = parentB.neurons;

  // Collect hidden neurons from both parents by UUID. Neurons without a
  // UUID cannot participate in the UUID-keyed crossover and are skipped.
  const motherHidden: LegacyNeuron[] = [];
  for (let i = inputCount; i < neuronsA.length; i++) {
    const n = neuronsA[i];
    if (n.uuid === undefined) continue;
    motherHidden.push({
      type: n.type === "output" ? "output" : "hidden",
      squash: n.squash,
      bias: n.bias,
      uuid: n.uuid,
      index: i,
    });
  }

  const fatherHiddenMap = new Map<string, { bias: number; squash: string | undefined }>();
  const fatherOnlyNeurons: LegacyNeuron[] = [];
  const motherUUIDs = new Set(motherHidden.map((n) => n.uuid));

  for (let i = inputCount; i < neuronsB.length; i++) {
    const n = neuronsB[i];
    if (n.type === "output") continue;
    if (n.uuid === undefined) continue;
    if (motherUUIDs.has(n.uuid)) {
      fatherHiddenMap.set(n.uuid, { bias: n.bias, squash: n.squash });
    } else {
      fatherOnlyNeurons.push({
        type: "hidden",
        squash: n.squash,
        bias: n.bias,
        uuid: n.uuid,
        index: 0, // Will be re-indexed later
      });
    }
  }

  // Build offspring neuron list: inputs + mother's hidden + selected father hidden + outputs
  const offspringNeurons: LegacyNeuron[] = [];

  // Input neurons
  for (let i = 0; i < inputCount; i++) {
    offspringNeurons.push({
      type: "input",
      squash: "LOGISTIC",
      index: i,
      uuid: `input-${i}`,
    });
  }

  // Mother's hidden neurons (with blended biases where father matches)
  for (const neuron of motherHidden) {
    if (neuron.type === "output") continue;
    const fatherMatch = fatherHiddenMap.get(neuron.uuid);
    const blendedBias = fatherMatch !== undefined
      ? ((neuron.bias ?? 0) + fatherMatch.bias) / 2
      : neuron.bias;
    offspringNeurons.push({
      type: "hidden",
      squash: neuron.squash,
      bias: blendedBias,
      uuid: neuron.uuid,
      index: offspringNeurons.length,
    });
  }

  // Father's unique hidden neurons (50% inclusion)
  for (const neuron of fatherOnlyNeurons) {
    if (random() < 0.5) {
      offspringNeurons.push({
        type: "hidden",
        squash: neuron.squash,
        bias: neuron.bias,
        uuid: neuron.uuid,
        index: offspringNeurons.length,
      });
    }
  }

  // Output neuron(s)
  const outputNeuron = motherHidden.find((n) => n.type === "output");
  if (!outputNeuron) return undefined;
  offspringNeurons.push({
    type: "output",
    squash: outputNeuron.squash,
    bias: outputNeuron.bias,
    uuid: outputNeuron.uuid,
    index: offspringNeurons.length,
  });

  // Build UUID-to-index map for synapse construction
  const uuidToIndex = new Map<string, number>();
  for (const neuron of offspringNeurons) {
    if (neuron.uuid) {
      uuidToIndex.set(neuron.uuid, neuron.index);
    }
  }

  // Collect synapses from mother, keyed by fromUUID-toUUID
  const synapsesA = parentA.synapses;
  const synapseMap = new Map<string, { weight: number; from: number; to: number }>();

  for (const s of synapsesA) {
    const fromUUID = parentA.neurons[s.from].uuid;
    const toUUID = parentA.neurons[s.to].uuid;
    if (fromUUID === undefined || toUUID === undefined) continue;
    const fromIdx = uuidToIndex.get(fromUUID);
    const toIdx = uuidToIndex.get(toUUID);
    if (fromIdx !== undefined && toIdx !== undefined) {
      synapseMap.set(`${fromUUID}->${toUUID}`, {
        weight: s.weight,
        from: fromIdx,
        to: toIdx,
      });
    }
  }

  // Blend or add father's synapses
  const synapsesB = parentB.synapses;
  for (const s of synapsesB) {
    const fromUUID = parentB.neurons[s.from].uuid;
    const toUUID = parentB.neurons[s.to].uuid;
    if (fromUUID === undefined || toUUID === undefined) continue;
    const key = `${fromUUID}->${toUUID}`;

    const existing = synapseMap.get(key);
    if (existing) {
      // Blend weights
      existing.weight = (existing.weight + s.weight) / 2;
    } else {
      // Add father synapse if both endpoints exist in offspring
      const fromIdx = uuidToIndex.get(fromUUID);
      const toIdx = uuidToIndex.get(toUUID);
      if (fromIdx !== undefined && toIdx !== undefined) {
        synapseMap.set(key, { weight: s.weight, from: fromIdx, to: toIdx });
      }
    }
  }

  // Build synapse array
  const offspringSynapses: LegacySynapse[] = [];
  for (const entry of synapseMap.values()) {
    offspringSynapses.push({
      from: entry.from,
      to: entry.to,
      weight: entry.weight,
    });
  }

  const offspringJSON: LegacyCreatureJSON = {
    neurons: offspringNeurons,
    synapses: offspringSynapses,
    input: inputCount,
    output: parentA.output,
  };

  try {
    const offspring = Creature.fromJSON(asCreatureExport(offspringJSON));
    offspring.validate();
    CreatureUtil.makeUUID(offspring);
    return offspring;
  } catch {
    return undefined;
  }
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
  config: CrossoverEvolutionConfig = DEFAULT_CROSSOVER_EVOLUTION_CONFIG,
): Promise<CrossoverEvolutionResult> {
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

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Crossover (Breeding) Example — minimal-seed audit (#213)");
  console.log("");

  // Set up directories (all under a hidden, gitignored folder)
  const { dataDir, creaturesDir, outputDir } = setupWorkingDirs(WORKING_ROOT);

  // Step 1: Create two parent creatures (hand-crafted demo state).
  console.log("📦 Step 1: Creating parent creatures (hand-crafted demo state)...");
  const parentA = createParentA();
  const parentB = createParentB();

  const parentAExport = parentA.exportJSON();
  const parentBExport = parentB.exportJSON();

  const parentAPath = join(creaturesDir, "parent_a.json");
  const parentBPath = join(creaturesDir, "parent_b.json");
  await safeWriteJson(parentAPath, parentAExport);
  await safeWriteJson(parentBPath, parentBExport);

  const hiddenA = parentAExport.neurons.filter((n) => n.type === "hidden");
  const hiddenB = parentBExport.neurons.filter((n) => n.type === "hidden");
  console.log(
    `   Parent A: ${hiddenA.length} hidden neurons, ` +
      `squashes: ${hiddenA.map((n) => n.squash).join(", ")}`,
  );
  console.log(
    `   Parent B: ${hiddenB.length} hidden neurons, ` +
      `squashes: ${hiddenB.map((n) => n.squash).join(", ")}`,
  );

  // Step 2: Generate synthetic training data from parent A (label oracle).
  console.log("\n📊 Step 2: Generating binary .bin training set (Parent A as label oracle)...");
  generateSyntheticData(parentA, dataDir, SYNTHETIC_CONFIG);

  // Step 3: Score both parents.
  console.log("\n📈 Step 3: Scoring parents against the .bin set...");
  const scoreA = await scoreCreature(parentA, dataDir);
  const scoreB = await scoreCreature(parentB, dataDir);
  addTag(parentAExport, "score", `${scoreA}`);
  addTag(parentBExport, "score", `${scoreB}`);
  console.log(`   Parent A score: ${scoreA.toPrecision(6)}`);
  console.log(`   Parent B score: ${scoreB.toPrecision(6)}`);

  // Step 4: Perform crossover (the breeding demo).
  console.log("\n🔬 Step 4: Performing crossover (mother-keep + father-50% blend)...");
  const offspring = performCrossover(parentA, parentB);
  let offspringScore: number | undefined;

  if (offspring) {
    const offspringExport = offspring.exportJSON();
    const offspringHidden = offspringExport.neurons.filter((n) => n.type === "hidden");
    console.log(
      `   Offspring: ${offspringHidden.length} hidden neurons, ` +
        `squashes: ${offspringHidden.map((n) => n.squash).join(", ")}`,
    );

    const offspringPath = join(creaturesDir, "offspring.json");
    await safeWriteJson(offspringPath, offspringExport);

    offspringScore = await scoreCreature(offspring, dataDir);
    addTag(offspringExport, "score", `${offspringScore}`);
    console.log(`   Offspring score: ${offspringScore.toPrecision(6)}`);

    // Save a few additional offspring to the output dir for inspection.
    for (let i = 0; i < 3; i++) {
      const child = performCrossover(parentA, parentB);
      if (child) {
        const childPath = join(outputDir, `offspring_${i}.json`);
        await safeWriteJson(childPath, child.exportJSON());
      }
    }
  } else {
    console.log("   Crossover did not produce viable offspring (parents incompatible).");
  }

  // Step 5: Minimal-seed evolution — the headline audit-mandated stage.
  console.log("\n🌱 Step 5: Minimal-seed evolution (audit #213)");
  console.log(
    `   Seed: new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  console.log(
    `   Seed topology: ${seed.neurons.length} neurons, ${seed.synapses.length} synapses`,
  );

  const evolutionConfig = DEFAULT_CROSSOVER_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${evolutionConfig.targetError}, ` +
      `timeoutMinutes=${evolutionConfig.timeoutMinutes} (issue #213 backstop)`,
  );

  const evolutionResult = await runMinimalSeedEvolution(seed, dataDir, evolutionConfig);
  const finalRow = evolutionResult.rows[evolutionResult.rows.length - 1];
  console.log(
    `   Completed ${evolutionResult.generations} generations in ` +
      `${(evolutionResult.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(evolutionResult.finalError) ? evolutionResult.finalError.toFixed(4) : "n/a"
      })`,
  );
  if (finalRow) {
    console.log(
      `   Champion topology: ${finalRow.neuronCount} neurons, ` +
        `${finalRow.synapseCount} synapses ` +
        `(seed had ${evolutionResult.seedNeuronCount} / ${evolutionResult.seedSynapseCount})`,
    );
  }

  const championPath = join(creaturesDir, "evolved.json");
  await safeWriteJson(championPath, evolutionResult.champion.exportJSON());
  console.log(`   Saved evolved champion to ${championPath}`);

  // Score the evolved champion against the same data so the README can
  // compare crossover offspring vs minimal-seed champion side by side.
  const evolvedScore = await scoreCreature(evolutionResult.champion, dataDir);
  console.log(`   Evolved champion score: ${evolvedScore.toPrecision(6)}`);

  // Step 6: Emit per-generation telemetry artefacts.
  console.log("\n📈 Step 6: Writing per-generation telemetry (CSV + 2 SVGs)");
  if (evolutionResult.rows.length === 0) {
    console.log("   ⚠️  No per-generation events captured — telemetry skipped.");
  } else {
    ensureDirSync("docs/data/crossover");
    ensureDirSync("docs/screenshots/crossover");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(evolutionResult.rows));
    console.log(
      `   🗒️  Wrote ${EVOLUTION_CSV_PATH} (${evolutionResult.rows.length} rows)`,
    );

    const fitnessSvg = renderFitnessChartSVG(rowsToFitnessSamples(evolutionResult.rows), {
      title: "Crossover — Best vs Mean Fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`   📈 Wrote ${FITNESS_SVG_PATH}`);

    const topologySvg = renderEvolutionChartSVG(rowsToEvolutionSamples(evolutionResult.rows), {
      title: "Crossover — Score, Neurons, Synapses per Generation",
    });
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, topologySvg);
    console.log(`   📈 Wrote ${TOPOLOGY_SVG_PATH}`);
  }

  // Final summary so the README can quote real measured numbers.
  console.log("\n📋 Comparison:");
  console.log(`   Parent A score:        ${scoreA.toPrecision(6)}`);
  console.log(`   Parent B score:        ${scoreB.toPrecision(6)}`);
  if (offspringScore !== undefined) {
    console.log(`   Offspring score:       ${offspringScore.toPrecision(6)}`);
  }
  console.log(`   Evolved champion:      ${evolvedScore.toPrecision(6)}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
