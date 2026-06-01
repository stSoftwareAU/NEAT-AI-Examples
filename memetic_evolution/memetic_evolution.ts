/**
 * Memetic Evolution Demo (issue #90, audited #216, telemetry simplified
 * under #303).
 *
 * Demonstrates **memetic seeding**: recording the weights and biases of
 * the fittest creatures observed so far and using them to seed future
 * generations. The headline narrative is now expressed through two
 * `Creature.evolveDir(...)` runs over the same binary `.bin` training
 * set:
 *
 *   - The **memetic** run chains two `evolveDir` calls so the second
 *     call is seeded from the first's champion, mirroring the
 *     "re-seed from the fittest archive" mechanic the demo is built
 *     around.
 *   - The **control** run makes a single `evolveDir` call with the
 *     same total iteration budget.
 *
 * Both runs build their seed via the NEAT-AI factory
 * `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })`
 * ({@link buildSeedCreature}) instead of a bare
 * `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (issue #536). The factory
 * couples the LOGISTIC output to the cost — matching the oracle's `[0, 1]`
 * sigmoid targets — sizes a conservative hidden layer (Heaton's rule), and
 * scales the random weight init per activation (He / Xavier). Seed weights
 * and biases stay random; only topology and scaling are factory-derived,
 * and all structural growth beyond the seed still comes from `evolveDir`'s
 * unchanged mutation operators. Migrating **both** seeds keeps the
 * memetic / control comparison fair. The bare-constructor baseline is
 * retained as {@link buildRandomSeedCreature} for test / resume fixtures.
 * This is a milestone-sanctioned departure from the no-warm-start policy
 * (factory-adoption tracker #517).
 *
 * The headline SVG compares the two milestone outcomes side by side via
 * {@link renderMemeticSVG}, sourced from two {@link EvolveDirSummary}
 * records. The previous green-dashed "memetic seed applied" marker is
 * replaced by an annotation strip on each summary panel naming the
 * seeding event.
 *
 * No per-generation `onTrainingEvent` hook is used — telemetry comes
 * entirely from `evolveDir`'s return value.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  createSeededRng,
  Creature,
  type CreatureExport,
  type DatasetFactoryOptions,
  type NeatOptions,
  safeWriteJson,
  setRandomNumberGenerator,
} from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type EvolveDirSummary } from "../common/evolve_dir_summary.ts";
import { renderMemeticSVG } from "./svg.ts";

/** Number of weights / biases in the fixed network topology used as the label oracle. */
export const WEIGHT_VECTOR_LENGTH = 9;

/** Headline milestone-comparison SVG path. */
export const SCREENSHOT_PATH = "docs/screenshots/memetic_evolution.svg";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-memetic-evolution";

/**
 * Number of input neurons fed to the NEAT-AI seed. Matches the 2-input,
 * 1-output topology of the label-oracle weight vector.
 */
export const INPUT_COUNT = 2;

/** Number of output neurons fed to the NEAT-AI seed. */
export const OUTPUT_COUNT = 1;

/**
 * Cost handed to the NEAT-AI factory ({@link Creature.forDataset}) when
 * building the seed creature (issue #536). The label oracle emits a
 * LOGISTIC probability in `[0, 1]` (see {@link forward}), so
 * `BINARY_CROSS_ENTROPY` couples the seed's output activation to a
 * **LOGISTIC** sigmoid (NEAT-AI #2793) — the bounded `(0, 1)` range the
 * held-out −MSE scoring and `[0, 1]` regression targets both assume. Same
 * cost / activation pairing as the XOR (#520) and adaptive_mutation (#533)
 * adoptions.
 *
 * The cost shapes only the *seed*; `evolveDir` itself keeps its default
 * scoring, so evolution behaves exactly as it did before the factory was
 * adopted.
 */
export const SEED_COST = "BINARY_CROSS_ENTROPY";

/** The record shape (`{ input, output }`) the NEAT-AI factory scans. */
export type FactoryRecords = Parameters<typeof Creature.forDataset>[0];

/**
 * Convert the synthetic dataset ({@link DataPoint}[]) into the
 * `{ input, output }` record shape the NEAT-AI factory scans. The factory
 * derives its seed from the same records `evolveDir` trains on.
 */
export function datasetToFactoryRecords(dataset: readonly DataPoint[]): FactoryRecords {
  return dataset.map(({ inputs, output }) => ({
    input: Float32Array.from(inputs),
    output: Float32Array.from([output]),
  }));
}

/**
 * Build the bare uniform-random NEAT seed — `new Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` with direct input → output synapses and zero hidden
 * neurons. **Retained as the historical baseline** for test / resume
 * fixtures after the fresh-run seed moved to the factory
 * ({@link buildSeedCreature}, issue #536). The library's global PRNG is
 * reseeded via {@link createSeededRng} so a given `seed` is deterministic;
 * every weight and bias is drawn from that PRNG — nothing is hand-crafted.
 */
export function buildRandomSeedCreature(seed: number): CreatureExport {
  setRandomNumberGenerator(createSeededRng(seed));
  return new Creature(INPUT_COUNT, OUTPUT_COUNT).exportJSON();
}

/**
 * Build the **factory seed creature** via the NEAT-AI factory
 * ({@link Creature.forDataset}) instead of a bare `new Creature(...)`
 * (issue #536). From problem-intrinsic facts only, the factory:
 *
 * - picks a **LOGISTIC output** activation from the cost
 *   ({@link SEED_COST}) — the bounded `(0, 1)` activation the oracle's
 *   `[0, 1]` targets and the held-out −MSE scoring both assume;
 * - sizes a **conservative hidden-capacity budget** from the problem
 *   shape (Heaton's rule → a small hidden layer);
 * - scales the random weights to the **per-activation init stddev**
 *   (He / Xavier), so the forward pass neither saturates nor vanishes.
 *
 * The global PRNG is reseeded via {@link createSeededRng} so a given
 * `seed` produces a deterministic seed creature. Every weight and bias is
 * still drawn from that PRNG — the factory chooses the topology and
 * scaling, never hand-crafted parameters. The cost shapes only the seed;
 * `evolveDir` keeps its default scoring so evolution is untouched.
 *
 * Milestone-sanctioned departure from the project-wide no-warm-start
 * policy, made under the factory-adoption tracker (issue #517).
 */
export function buildSeedCreature(records: FactoryRecords, seed: number): CreatureExport {
  if (records.length === 0) {
    throw new Error("buildSeedCreature: records must not be empty");
  }
  setRandomNumberGenerator(createSeededRng(seed));
  const options: DatasetFactoryOptions = { cost: SEED_COST };
  return Creature.forDataset(records, options).exportJSON();
}

/** Target weight vector — the label oracle whose outputs the training set is built from. */
export const TARGET_WEIGHTS: readonly number[] = Object.freeze([
  // Input → hidden (4): roughly XOR-style separating directions.
  1.6,
  -1.4,
  -1.5,
  1.7,
  // Hidden biases (2).
  0.3,
  -0.2,
  // Hidden → output (2).
  1.8,
  -1.6,
  // Output bias (1).
  0.1,
]);

/** A single (input, target-output) record. */
export interface DataPoint {
  inputs: readonly [number, number];
  output: number;
}

/** Logistic activation. */
function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Forward pass for the fixed 2 → 2 (TANH) → 1 (sigmoid) label oracle.
 * The weight vector layout is documented on {@link TARGET_WEIGHTS}.
 */
export function forward(weights: readonly number[], inputs: readonly [number, number]): number {
  if (weights.length !== WEIGHT_VECTOR_LENGTH) {
    throw new Error(
      `weights must have length ${WEIGHT_VECTOR_LENGTH}, got ${weights.length}`,
    );
  }
  const [w00, w01, w10, w11, b0, b1, vh0, vh1, bo] = weights;
  const [x0, x1] = inputs;
  const h0 = Math.tanh(w00 * x0 + w10 * x1 + b0);
  const h1 = Math.tanh(w01 * x0 + w11 * x1 + b1);
  return sigmoid(vh0 * h0 + vh1 * h1 + bo);
}

/**
 * Generate a deterministic synthetic dataset of (input, target-output)
 * pairs by sampling 2D inputs uniformly on `[-1, 1]` and computing the
 * target network's output on each.
 */
export function generateDataset(seed: number, size: number): DataPoint[] {
  if (size <= 0) {
    throw new Error(`dataset size must be positive, got ${size}`);
  }
  const random = createDeterministicRandom(seed);
  const dataset: DataPoint[] = [];
  for (let i = 0; i < size; i++) {
    const x0 = random() * 2 - 1;
    const x1 = random() * 2 - 1;
    const y = forward(TARGET_WEIGHTS, [x0, x1]);
    dataset.push({ inputs: [x0, x1], output: y });
  }
  return dataset;
}

/** Negative MSE on `records` — higher is better. */
export function fitnessOn(weights: readonly number[], records: readonly DataPoint[]): number {
  if (records.length === 0) return 0;
  let sumSquaredError = 0;
  for (const r of records) {
    const yHat = forward(weights, r.inputs);
    const e = yHat - r.output;
    sumSquaredError += e * e;
  }
  return -sumSquaredError / records.length;
}

/**
 * Write the synthetic dataset as a Float32 binary file the NEAT-AI
 * library can consume via `Creature.evolveDir(dir, ...)`. Each record
 * is laid out as `INPUT_COUNT + OUTPUT_COUNT` little-endian floats.
 */
export function writeBinaryDataset(dataset: readonly DataPoint[], dataDir: string): string {
  ensureDirSync(dataDir);
  const stride = INPUT_COUNT + OUTPUT_COUNT;
  const buffer = new Float32Array(dataset.length * stride);
  for (let i = 0; i < dataset.length; i++) {
    buffer[i * stride] = dataset[i].inputs[0];
    buffer[i * stride + 1] = dataset[i].inputs[1];
    buffer[i * stride + INPUT_COUNT] = dataset[i].output;
  }
  const path = join(dataDir, "training.bin");
  Deno.writeFileSync(path, new Uint8Array(buffer.buffer));
  return path;
}

/**
 * Held-out score (-MSE — higher is better) of `creature` against the
 * synthetic dataset.
 */
export function creatureHeldOutScore(
  creature: Creature,
  dataset: readonly DataPoint[],
): number {
  if (dataset.length === 0) return 0;
  let sum = 0;
  for (const point of dataset) {
    creature.clearState();
    const inputs = new Float32Array([point.inputs[0], point.inputs[1]]);
    const out = creature.activate(inputs);
    const err = out[0] - point.output;
    sum += err * err;
  }
  return -(sum / dataset.length);
}

/** Configuration for the milestone memetic-vs-control `evolveDir` runs. */
export interface MemeticEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /**
   * Wall-clock backstop in minutes. Issue #216 set 5 minutes as the original
   * upper bound; issue #382 raised this to 20 minutes to grant the +15 minute
   * refresh budget on top of the existing baseline (parent #369 /
   * `Refresh-2026-05`). Tests therefore assert `>= 5`, not `=== 5`.
   */
  timeoutMinutes: number;
  /** NEAT population size — small enough for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap for the **control** run. */
  controlIterations: number;
  /**
   * Hard iteration cap for the **memetic** run's first phase. The
   * memetic run splits its iteration budget across two chained
   * `evolveDir` calls, the second seeded from the first's champion —
   * the analogue of re-seeding from the fittest archive.
   */
  memeticPhaseIterations: number;
  /** RNG seed forwarded to NEAT-AI for the memetic run. */
  memeticSeed: number;
  /** RNG seed forwarded to NEAT-AI for the control run. */
  controlSeed: number;
  /** Probability that any given creature is mutated each generation. */
  mutationRate: number;
  /** Number of mutation operators applied per mutated creature. */
  mutationAmount: number;
}

/**
 * Defaults tuned so each run converges via `targetError` well inside the
 * wall-clock backstop on a developer machine while still showing visible
 * neuron / synapse growth from the factory seed. Under issue #382 the
 * backstop was raised from 5 → 20 minutes and the iteration caps were
 * lifted in lock-step (control 250 → 1000, memetic phase 125 → 500) so
 * wall-clock remains the genuine limiter for the `Refresh-2026-05` run.
 */
export const DEFAULT_MEMETIC_EVOLUTION_CONFIG: MemeticEvolutionConfig = {
  targetError: 0.005,
  timeoutMinutes: 20,
  populationSize: 24,
  controlIterations: 1000,
  memeticPhaseIterations: 500,
  memeticSeed: 216216,
  controlSeed: 216217,
  // Push NEAT toward structural growth so the example genuinely adds
  // hidden neurons / inter-layer synapses beyond the factory seed.
  mutationRate: 0.6,
  mutationAmount: 3,
};

/** Single-phase milestone result captured from one `evolveDir` call. */
export interface MemeticPhaseResult {
  /** The creature mutated in place by `evolveDir`. */
  champion: Creature;
  /** Milestone summary captured from the `evolveDir` call. */
  summary: EvolveDirSummary;
  /** Total wall-clock time of this phase, in milliseconds. */
  wallClockMs: number;
  /** Final per-record error returned by `evolveDir`. */
  finalError: number;
  /** Generations completed in this phase. */
  generations: number;
  /** True when the run reached `targetError`. */
  solved: boolean;
}

/** Combined result of the memetic-vs-control milestone comparison. */
export interface MemeticVsControlResult {
  /** Memetic phase (two chained `evolveDir` calls — the second seeded from the first). */
  memetic: MemeticPhaseResult;
  /** Control phase (single `evolveDir` call with the same total iteration budget). */
  control: MemeticPhaseResult;
}

/**
 * Run a single `evolveDir` phase from `seed`, returning a milestone
 * summary captured from the call's return value plus the seed and
 * final creature's topology. The seed is mutated in place.
 */
async function runEvolveDirPhase(
  seed: Creature,
  dataDir: string,
  iterations: number,
  config: MemeticEvolutionConfig,
  rngSeed: number,
  seedNeuronCount: number,
  seedSynapseCount: number,
): Promise<MemeticPhaseResult> {
  if (iterations <= 0) throw new Error("iterations must be positive");
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");

  const start = Date.now();

  const neatOptions: NeatOptions = {
    seed: rngSeed,
    populationSize: config.populationSize,
    iterations,
    targetError: config.targetError,
    timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
    // No feedbackLoop key → engine treats the run as forward-only.
    costOfGrowth: 0,
    mutationRate: config.mutationRate,
    mutationAmount: config.mutationAmount,
    verbose: false,
    log: 0,
    threads: 1,
  };

  const result = await seed.evolveDir(dataDir, neatOptions);
  const wallClockMs = Date.now() - start;

  const finalError = Number.isFinite(result.error) ? result.error : 0;
  const finalScore = Number.isFinite(result.score) ? result.score : 0;
  const generations = Math.max(1, result.generation ?? 1);
  const solved = finalError <= config.targetError;

  const summary: EvolveDirSummary = {
    finalError,
    finalScore,
    wallClockMs,
    generations,
    seedNeurons: seedNeuronCount,
    seedSynapses: seedSynapseCount,
    finalNeurons: seed.neurons.length,
    finalSynapses: seed.synapses.length,
    targetError: config.targetError,
    timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
  };

  return {
    champion: seed,
    summary,
    wallClockMs,
    finalError,
    generations,
    solved,
  };
}

/**
 * Run the memetic-vs-control milestone comparison end-to-end:
 *
 *   1. Memetic phase 1 — evolve a factory seed
 *      ({@link buildSeedCreature} from `records`, keyed by
 *      `config.memeticSeed`) for
 *      {@link MemeticEvolutionConfig.memeticPhaseIterations} iterations.
 *   2. Memetic phase 2 — continue evolving the same in-place creature
 *      (the analogue of re-seeding from the fittest archive entry) for
 *      another {@link MemeticEvolutionConfig.memeticPhaseIterations}
 *      iterations. The combined memetic summary aggregates both phases.
 *   3. Control — evolve a fresh factory seed (keyed by `config.controlSeed`)
 *      in a **single** `evolveDir` call for
 *      {@link MemeticEvolutionConfig.controlIterations} iterations.
 *
 * Both seeds come from the data-derived factory ({@link buildSeedCreature})
 * so the memetic / control comparison stays fair; `evolveDir` keeps its
 * default scoring, so evolution is untouched. Returns both summaries so the
 * headline SVG can compare the two milestone outcomes side by side.
 */
export async function runMemeticAndControlEvolution(
  dataDir: string,
  records: FactoryRecords,
  config: MemeticEvolutionConfig = DEFAULT_MEMETIC_EVOLUTION_CONFIG,
): Promise<MemeticVsControlResult> {
  // ---- Memetic run: two chained evolveDir phases ----------------------
  const memeticSeed = Creature.fromJSON(buildSeedCreature(records, config.memeticSeed));
  const memeticSeedNeurons = memeticSeed.neurons.length;
  const memeticSeedSynapses = memeticSeed.synapses.length;

  const phase1 = await runEvolveDirPhase(
    memeticSeed,
    dataDir,
    config.memeticPhaseIterations,
    config,
    config.memeticSeed,
    memeticSeedNeurons,
    memeticSeedSynapses,
  );

  // If phase 1 already met the target, skip phase 2 — there is nothing
  // more to re-seed from. The memetic summary reflects only phase 1 in
  // that case.
  let memeticResult: MemeticPhaseResult = phase1;
  if (!phase1.solved) {
    const phase2 = await runEvolveDirPhase(
      memeticSeed, // re-seed from phase 1 champion (in-place creature)
      dataDir,
      config.memeticPhaseIterations,
      config,
      config.memeticSeed + 1,
      memeticSeedNeurons,
      memeticSeedSynapses,
    );

    // Aggregate the two phases into one combined memetic summary.
    const combinedWall = phase1.wallClockMs + phase2.wallClockMs;
    const combinedGens = phase1.generations + phase2.generations;
    memeticResult = {
      champion: memeticSeed,
      summary: {
        finalError: phase2.summary.finalError,
        finalScore: phase2.summary.finalScore,
        wallClockMs: combinedWall,
        generations: combinedGens,
        seedNeurons: memeticSeedNeurons,
        seedSynapses: memeticSeedSynapses,
        finalNeurons: memeticSeed.neurons.length,
        finalSynapses: memeticSeed.synapses.length,
        targetError: config.targetError,
        timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
      },
      wallClockMs: combinedWall,
      finalError: phase2.finalError,
      generations: combinedGens,
      solved: phase2.solved,
    };
  }

  // ---- Control run: single evolveDir call -----------------------------
  const controlSeed = Creature.fromJSON(buildSeedCreature(records, config.controlSeed));
  const controlResult = await runEvolveDirPhase(
    controlSeed,
    dataDir,
    config.controlIterations,
    config,
    config.controlSeed,
    controlSeed.neurons.length,
    controlSeed.synapses.length,
  );

  return { memetic: memeticResult, control: controlResult };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧠 Memetic Evolution Demo (telemetry rewire #303)");
  console.log("");

  const { dataDir, creaturesDir } = setupWorkingDirs(WORKING_ROOT);

  // Generate the binary training set from the label oracle.
  console.log("📊 Generating binary training set from the label-oracle weight vector...");
  const trainingSet = generateDataset(
    DEFAULT_MEMETIC_EVOLUTION_CONFIG.memeticSeed,
    256,
  );
  writeBinaryDataset(trainingSet, dataDir);
  console.log(
    `   Wrote ${trainingSet.length} records to ${dataDir}/training.bin`,
  );

  console.log("");
  console.log("🌱 Running memetic-vs-control milestone comparison");
  console.log(
    `   Seed: Creature.forDataset(records, { cost: "${SEED_COST}" }) ` +
      `— LOGISTIC output, factory hidden layer, He/Xavier-scaled random weights (issue #536).`,
  );
  const config = DEFAULT_MEMETIC_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${config.targetError}, ` +
      `timeoutMinutes=${config.timeoutMinutes} (issue #216 backstop)`,
  );

  const records = datasetToFactoryRecords(trainingSet);
  const result = await runMemeticAndControlEvolution(dataDir, records, config);

  console.log("");
  console.log(
    `   Memetic : generations=${result.memetic.generations}  ` +
      `wallClock=${(result.memetic.wallClockMs / 1000).toFixed(1)}s  ` +
      `score=${result.memetic.summary.finalScore.toFixed(4)}  ` +
      `error=${result.memetic.summary.finalError.toFixed(4)}  ` +
      `neurons=${result.memetic.summary.finalNeurons}  ` +
      `synapses=${result.memetic.summary.finalSynapses}`,
  );
  console.log(
    `   Control : generations=${result.control.generations}  ` +
      `wallClock=${(result.control.wallClockMs / 1000).toFixed(1)}s  ` +
      `score=${result.control.summary.finalScore.toFixed(4)}  ` +
      `error=${result.control.summary.finalError.toFixed(4)}  ` +
      `neurons=${result.control.summary.finalNeurons}  ` +
      `synapses=${result.control.summary.finalSynapses}`,
  );
  const lift = result.memetic.summary.finalScore - result.control.summary.finalScore;
  console.log(`   Fitness lift (memetic - control): ${lift >= 0 ? "+" : ""}${lift.toFixed(4)}`);

  // Render the headline milestone-comparison SVG.
  ensureDirSync("docs/screenshots");
  const memeticSeedingEvent = `archive seed @ gen ${
    result.memetic.solved ? result.memetic.generations : config.memeticPhaseIterations
  }`;
  const svg = renderMemeticSVG({
    memetic: result.memetic.summary,
    control: result.control.summary,
    memeticSeedingEvent,
  });
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote ${SCREENSHOT_PATH}`);

  // Save the evolved champions for downstream inspection.
  const memeticChampionPath = join(creaturesDir, "memetic_champion.json");
  const controlChampionPath = join(creaturesDir, "control_champion.json");
  const memeticExport: CreatureExport = result.memetic.champion.exportJSON();
  const controlExport: CreatureExport = result.control.champion.exportJSON();
  await safeWriteJson(memeticChampionPath, memeticExport);
  await safeWriteJson(controlChampionPath, controlExport);
  console.log(`💾 Saved memetic champion to ${memeticChampionPath}`);
  console.log(`💾 Saved control champion to ${controlChampionPath}`);

  // Held-out scores on the same dataset for a "reasonable solution" line.
  const memeticHeldOut = creatureHeldOutScore(result.memetic.champion, trainingSet);
  const controlHeldOut = creatureHeldOutScore(result.control.champion, trainingSet);
  console.log(`   Memetic held-out -MSE: ${memeticHeldOut.toFixed(6)}`);
  console.log(`   Control held-out -MSE: ${controlHeldOut.toFixed(6)}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
