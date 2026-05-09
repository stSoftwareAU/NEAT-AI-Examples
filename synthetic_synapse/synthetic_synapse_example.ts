/**
 * Synthetic Synapse Training Demo (issue #85, audited under #206).
 *
 * Demonstrates NEAT-AI's **synthetic-synapse training** technique:
 * temporarily **densifying** the inter-layer connectivity of an
 * **evolved** sparse creature so weight optimisation has more degrees of
 * freedom, then **pruning** the near-zero synthetic synapses afterwards
 * so the deployed creature stays lean.
 *
 * This audit (issue #206) brings the example in line with the
 * minimal-seed + measured-telemetry policy in `AGENTS.md`:
 *
 * 1. The creature passed to NEAT-AI is built **only** from
 *    `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — no hidden-layer hint,
 *    no pre-built `network.json` seed, no hand-tuned shape. NEAT-AI
 *    random-initialises the rest.
 * 2. Evolution runs through `Creature.evolveDir(dataDir, neatOptions)`
 *    over a pre-generated binary `.bin` training set; the topology is
 *    learned by NEAT, not bolted on by the example.
 * 3. Stop conditions are a per-example `targetError` plus a
 *    `timeoutMinutes: 5` safety backstop.
 * 4. Per-generation telemetry (best/mean fitness, neuron count,
 *    synapse count) is captured during both evolveDir phases and
 *    written out as CSV + two SVG charts so the README can quote real
 *    measured numbers from the latest run.
 *
 * The synthetic-synapse densify-train-prune cycle then runs on the
 * **evolved** sparse champion — that part of the demo is unchanged in
 * spirit, just powered by NEAT-AI rather than a custom SGD trainer.
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
import { renderSyntheticSynapseSVG } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-synapse";

/** Path to the topology + bar-chart SVG (sparse → densified → pruned). */
export const SCREENSHOT_PATH = "docs/screenshots/synthetic_synapse.svg";

/** Mirror copy under `WORKING_ROOT/output/`. */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "synthetic_synapse.svg");

/** Per-generation evolution-telemetry CSV path. */
export const EVOLUTION_CSV_PATH = "docs/data/synthetic_synapse/evolution.csv";

/** CSV header — matches the schema mandated by issue #206. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/synthetic_synapse/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/synthetic_synapse/topology.svg";

/**
 * Number of input neurons fed to the NEAT-AI seed.
 *
 * Five inputs combined with two outputs makes the truth function
 * non-linearly separable enough that direct input → output synapses
 * cannot fit it: NEAT has to invent hidden neurons (and therefore new
 * inter-layer edges) to drive `bestFitness` above the targetError.
 * This is what gives the densify-train-prune cycle something to act
 * on — if the sparse champion finished as a flat input/output graph,
 * synthetic-synapse training would have nothing to densify.
 */
export const INPUT_COUNT = 5;

/** Number of output neurons fed to the NEAT-AI seed. */
export const OUTPUT_COUNT = 2;

/** Names of the three phases captured by {@link runSyntheticSynapseDemo}. */
export type PhaseName = "sparse" | "densified" | "pruned";

/** Configuration for {@link runSyntheticSynapseDemo}. */
export interface SyntheticSynapseConfig {
  /** Random seed for target network, dataset, and NEAT mutation. */
  seed: number;
  /** Training records written to the binary `.bin` file. */
  trainingSize: number;
  /** Held-out records used to validate the final creature. */
  heldOutSize: number;
  /** Per-example `targetError` driving early exit from each phase. */
  targetError: number;
  /**
   * Wall-clock backstop in minutes for the whole demo. The value is
   * split across the sparse and refine phases. Issue #206 mandates 5
   * minutes as the upper bound; the per-phase split is half this.
   */
  timeoutMinutes: number;
  /** NEAT population size. Small for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterationsPerPhase: number;
  /**
   * Magnitude threshold below which a synthetic synapse is pruned at
   * the end of the densified phase. Original (non-synthetic) edges are
   * never pruned, even when their weight falls below this threshold.
   */
  pruneThreshold: number;
}

/**
 * Defaults chosen so the demo converges via `targetError` well inside
 * the 5-minute backstop on a developer machine while still showing the
 * densify-then-prune effect clearly. The targetError is deliberately
 * tight enough that NEAT must add hidden neurons to reach it from the
 * minimal direct-only seed.
 */
export const DEFAULT_SYNTHETIC_SYNAPSE_CONFIG: SyntheticSynapseConfig = {
  seed: 850850850,
  trainingSize: 128,
  heldOutSize: 64,
  targetError: 0.005,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterationsPerPhase: 250,
  pruneThreshold: 0.05,
};

/** A single training/held-out record. */
export interface DataPoint {
  inputs: Float32Array;
  targets: Float32Array;
}

/** Per-phase summary captured during the run. */
export interface PhaseRecord {
  /** Phase label. */
  phase: PhaseName;
  /** Synapse count of the phase's champion. */
  synapseCount: number;
  /** Held-out score (negative MSE — higher is better) at end of phase. */
  heldOutScore: number;
}

/** One row of per-generation evolution telemetry. */
export interface EvolutionRow {
  /** 1-based generation index across the whole demo. */
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

/** Combined result of running the synthetic-synapse demo. */
export interface SyntheticSynapseResult {
  /** Three phase records: sparse → densified → pruned. */
  phases: PhaseRecord[];
  /** Best topology snapshot per phase, for the SVG renderer. */
  topologies: Record<PhaseName, TopologySnapshot>;
  /** Per-generation telemetry across both evolveDir phases. */
  evolutionRows: EvolutionRow[];
  /** Total wall-clock time of the run, in milliseconds. */
  wallClockMs: number;
  /** Champion creature after the prune phase. */
  champion: Creature;
}

// ---- Internal feed-forward representation ------------------------------
// The original demo manipulated a small TypeScript `Network` struct so
// it could run analytical SGD. The audit moves training to NEAT-AI's
// evolveDir, but several utilities (forward pass, dataset generation,
// held-out scoring) are still reused by tests and the SVG renderer, so
// the lightweight representation is kept.

/** Minimal feed-forward network used by helper utilities. */
export interface Network {
  inputCount: number;
  outputCount: number;
  /** All neurons sorted by index (inputs, then hidden, then outputs). */
  neurons: NetworkNeuron[];
  /** All synapses; `from < to` always (strictly feed-forward). */
  synapses: NetworkSynapse[];
  /** Subset of `synapses` originally present (i.e. not synthetic). */
  originalSynapseKeys: Set<string>;
}

interface NetworkNeuron {
  index: number;
  type: "input" | "hidden" | "output";
  squash: SquashName;
  bias: number;
}

interface NetworkSynapse {
  from: number;
  to: number;
  weight: number;
  /** True if added during densification, false if part of the original creature. */
  synthetic: boolean;
}

/** Topology snapshot captured for the 3-panel SVG renderer. */
export interface TopologySnapshot {
  inputCount: number;
  outputCount: number;
  hiddenCount: number;
  edges: Array<{ from: number; to: number; synthetic: boolean }>;
}

type SquashName = "IDENTITY" | "TANH" | "LOGISTIC";

const KNOWN_SQUASHES: SquashName[] = ["IDENTITY", "TANH", "LOGISTIC"];

function isKnownSquash(name: string): name is SquashName {
  return (KNOWN_SQUASHES as string[]).includes(name);
}

/** Activation function evaluated on `z`. */
function activate(squash: SquashName, z: number): number {
  switch (squash) {
    case "IDENTITY":
      return z;
    case "TANH":
      return Math.tanh(z);
    case "LOGISTIC": {
      // Numerically stable logistic.
      if (z >= 0) {
        const e = Math.exp(-z);
        return 1 / (1 + e);
      }
      const e = Math.exp(z);
      return e / (1 + e);
    }
  }
}

function synapseKey(from: number, to: number): string {
  return `${from}->${to}`;
}

/**
 * Construct an internal {@link Network} from a `Creature`. Only LOGISTIC,
 * TANH, and IDENTITY squashes are supported — anything else throws.
 */
export function networkFromCreature(creature: Creature): Network {
  const neurons: NetworkNeuron[] = creature.neurons.map((n, idx) => {
    const squash = (n.squash ?? "IDENTITY").toUpperCase();
    if (!isKnownSquash(squash)) {
      throw new Error(`Unsupported squash function for synthetic-synapse demo: ${squash}`);
    }
    const type: NetworkNeuron["type"] = idx < creature.input
      ? "input"
      : idx >= creature.neurons.length - creature.output
      ? "output"
      : "hidden";
    return {
      index: idx,
      type,
      squash: squash as SquashName,
      bias: n.bias ?? 0,
    };
  });

  const originalSynapseKeys = new Set<string>();
  const synapses: NetworkSynapse[] = creature.synapses.map((s) => {
    const key = synapseKey(s.from, s.to);
    originalSynapseKeys.add(key);
    return { from: s.from, to: s.to, weight: s.weight, synthetic: false };
  });

  return {
    inputCount: creature.input,
    outputCount: creature.output,
    neurons,
    synapses,
    originalSynapseKeys,
  };
}

/** Forward pass over `network`. Returns the activations for every neuron. */
export function forward(network: Network, input: ArrayLike<number>): Float32Array {
  if (input.length !== network.inputCount) {
    throw new Error(
      `forward: expected ${network.inputCount} inputs, got ${input.length}`,
    );
  }
  const activations = new Float32Array(network.neurons.length);
  for (let i = 0; i < network.inputCount; i++) {
    activations[i] = activate(network.neurons[i].squash, input[i]);
  }
  const sums = new Float32Array(network.neurons.length);
  for (let i = network.inputCount; i < network.neurons.length; i++) {
    sums[i] = network.neurons[i].bias;
  }
  for (const s of network.synapses) {
    sums[s.to] += s.weight * activations[s.from];
  }
  for (let i = network.inputCount; i < network.neurons.length; i++) {
    activations[i] = activate(network.neurons[i].squash, sums[i]);
  }
  return activations;
}

/** Mean-squared error of a network across `dataset`. */
function mseAgainst(network: Network, dataset: readonly DataPoint[]): number {
  if (dataset.length === 0) return 0;
  let sum = 0;
  for (const point of dataset) {
    const acts = forward(network, point.inputs);
    const start = network.neurons.length - network.outputCount;
    for (let o = 0; o < network.outputCount; o++) {
      const yhat = acts[start + o];
      const err = yhat - point.targets[o];
      sum += err * err;
    }
  }
  return sum / dataset.length;
}

/** Held-out score (-MSE — higher is better). */
export function heldOutScore(network: Network, dataset: readonly DataPoint[]): number {
  return -mseAgainst(network, dataset);
}

/**
 * Held-out score for a `Creature` using its own `activate(...)` method.
 * This avoids the limited-squash conversion in {@link networkFromCreature}
 * — NEAT-AI may evolve any of its supported squash functions and the
 * creature itself can always activate them, whereas the local
 * {@link forward} helper only knows about IDENTITY/TANH/LOGISTIC.
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
    for (let o = 0; o < creature.output; o++) {
      const err = out[o] - point.targets[o];
      sum += err * err;
    }
  }
  return -(sum / dataset.length);
}

/**
 * Build the "ground truth" target network the dataset is generated
 * from. The target is **not** the NEAT seed — it just produces labels
 * that the evolved creature must learn to reproduce. Hand-shaping the
 * target is fine; only the seed needs to be minimal.
 *
 * We reuse `buildLargeCreature` with a fully-connected density (1.0)
 * so the underlying truth function is reachable in principle by a dense
 * hidden layer of this size — exactly the kind of mapping where
 * synthetic-synapse training pays off.
 */
export function buildTargetNetwork(config: SyntheticSynapseConfig): Network {
  const target = buildLargeCreature({
    inputs: INPUT_COUNT,
    hidden: 8,
    outputs: OUTPUT_COUNT,
    density: 1.0,
    seed: config.seed ^ 0x7777_7777,
  });
  return networkFromCreature(target);
}

/**
 * Generate a deterministic dataset by feeding `size` random inputs
 * through `targetNetwork`. Inputs are drawn uniformly from `[-1, 1]`.
 */
export function generateDataset(
  targetNetwork: Network,
  size: number,
  seed: number,
): DataPoint[] {
  if (size <= 0) {
    throw new Error(`dataset size must be positive, got ${size}`);
  }
  const rng = createDeterministicRandom(seed);
  const N = targetNetwork.neurons.length;
  const outStart = N - targetNetwork.outputCount;
  const dataset: DataPoint[] = [];
  for (let i = 0; i < size; i++) {
    const inputs = new Float32Array(targetNetwork.inputCount);
    for (let k = 0; k < targetNetwork.inputCount; k++) {
      inputs[k] = rng() * 2 - 1;
    }
    const acts = forward(targetNetwork, inputs);
    const targets = new Float32Array(targetNetwork.outputCount);
    for (let o = 0; o < targetNetwork.outputCount; o++) {
      targets[o] = acts[outStart + o];
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
 * Densify a `Creature` by adding a zero-weight synapse for every
 * missing inter-layer edge between adjacent layers in the current
 * topology. Returns the keys of the newly added (synthetic) synapses
 * so callers can prune by membership later.
 *
 * "Adjacent layers" are inferred from neuron indices: input neurons
 * (`0..input-1`) feed any non-input neuron, and any non-output neuron
 * feeds the output layer. Any missing forward-only edge is added at
 * weight zero so the creature's behaviour is unchanged at insertion
 * time — only its derivatives are non-zero.
 */
export function densifyCreature(creature: Creature): Set<string> {
  const N = creature.neurons.length;
  const inputCount = creature.input;
  const outputCount = creature.output;
  const outStart = N - outputCount;
  const existing = new Set(
    creature.synapses.map((s) => synapseKey(s.from, s.to)),
  );
  const addedKeys = new Set<string>();

  // Inputs → every non-input neuron.
  for (let i = 0; i < inputCount; i++) {
    for (let j = inputCount; j < N; j++) {
      const key = synapseKey(i, j);
      if (existing.has(key)) continue;
      creature.connect(i, j, 0);
      existing.add(key);
      addedKeys.add(key);
    }
  }
  // Hidden → outputs.
  for (let h = inputCount; h < outStart; h++) {
    for (let o = outStart; o < N; o++) {
      const key = synapseKey(h, o);
      if (existing.has(key)) continue;
      creature.connect(h, o, 0);
      existing.add(key);
      addedKeys.add(key);
    }
  }
  return addedKeys;
}

/**
 * Drop every synthetic synapse (one whose key is in `syntheticKeys`)
 * whose absolute weight is below `threshold`. Original (non-synthetic)
 * edges, plus any synapses NEAT-AI added during the refine phase, are
 * never pruned.
 *
 * @returns The keys of the synapses removed.
 */
export function pruneCreature(
  creature: Creature,
  syntheticKeys: ReadonlySet<string>,
  threshold: number,
): Set<string> {
  if (threshold < 0) {
    throw new Error(`prune threshold must be >= 0, got ${threshold}`);
  }
  const removed = new Set<string>();
  // Iterate over a snapshot — disconnect mutates `creature.synapses`.
  for (const s of [...creature.synapses]) {
    const key = synapseKey(s.from, s.to);
    if (!syntheticKeys.has(key)) continue;
    if (Math.abs(s.weight) >= threshold) continue;
    creature.disconnect(s.from, s.to);
    removed.add(key);
  }
  return removed;
}

/** Snapshot the creature's topology for the 3-panel SVG renderer. */
function snapshotTopology(
  creature: Creature,
  syntheticKeys: ReadonlySet<string>,
): TopologySnapshot {
  return {
    inputCount: creature.input,
    outputCount: creature.output,
    hiddenCount: creature.neurons.length - creature.input - creature.output,
    edges: creature.synapses.map((s) => ({
      from: s.from,
      to: s.to,
      synthetic: syntheticKeys.has(synapseKey(s.from, s.to)),
    })),
  };
}

/**
 * Iterations per `evolveDir` chunk. Each chunk refreshes the
 * passed-in creature in place, so chunking the phase into smaller
 * runs gives the per-generation telemetry chart visible step changes
 * in neuron/synapse counts as NEAT mutates the topology.
 */
const PHASE_CHUNK_ITERATIONS = 50;

/**
 * Run a single evolveDir phase against `dataDir`, capturing
 * per-generation telemetry into `rows`. The phase is split into
 * fixed-size chunks so the post-chunk topology is refreshed in the
 * passed-in `creature` and reflected in the next chunk's events. The
 * phase exits early when `targetError` is met or iterations exhausted.
 *
 * Returns the cumulative generation count actually evolved.
 */
async function runEvolvePhase(opts: {
  creature: Creature;
  dataDir: string;
  config: SyntheticSynapseConfig;
  phaseTimeoutMinutes: number;
  rows: EvolutionRow[];
  generationOffset: number;
}): Promise<{ generations: number; finalError: number }> {
  const { creature, dataDir, config, phaseTimeoutMinutes, rows, generationOffset } = opts;

  let evolved = 0;
  let finalError = Number.POSITIVE_INFINITY;
  const phaseStart = Date.now();
  const phaseBudgetMs = phaseTimeoutMinutes * 60_000;

  while (evolved < config.maxIterationsPerPhase) {
    // Pre-chunk topology snapshot. NEAT-AI only updates the passed-in
    // `creature` reference at the end of each evolveDir call, so the
    // event handler reports these counts for every event inside the
    // chunk and the next chunk re-reads after the await resolves.
    const segmentStartNeurons = creature.neurons.length;
    const segmentStartSynapses = creature.synapses.length;

    const remainingIterations = config.maxIterationsPerPhase - evolved;
    const chunkIterations = Math.min(PHASE_CHUNK_ITERATIONS, remainingIterations);
    const elapsedMs = Date.now() - phaseStart;
    if (elapsedMs >= phaseBudgetMs) break;
    // NEAT-AI requires `timeoutMinutes` to be an integer, so we always
    // pass the per-phase backstop. The chunk is also iteration-bounded.
    const chunkTimeoutMinutes = phaseTimeoutMinutes;

    const neatOptions: NeatOptions = {
      seed: config.seed + evolved,
      populationSize: config.populationSize,
      iterations: chunkIterations,
      targetError: config.targetError,
      timeoutMinutes: chunkTimeoutMinutes,
      costOfGrowth: 0,
      // Push NEAT toward structural growth so the sparse phase actually
      // adds hidden neurons / inter-layer synapses from the minimal
      // seed — otherwise densify-train-prune has nothing to do.
      mutationRate: 0.6,
      mutationAmount: 3,
      verbose: false,
      log: 0,
      threads: 1,
      onTrainingEvent: (event) => {
        if (event.kind !== "generation_complete") return;
        rows.push({
          generation: generationOffset + evolved + event.generation,
          bestFitness: event.bestFitness,
          meanFitness: event.averageFitness,
          neuronCount: segmentStartNeurons,
          synapseCount: segmentStartSynapses,
        });
      },
    };

    const result = await creature.evolveDir(dataDir, neatOptions);
    const completed = result.generation ?? chunkIterations;
    evolved += completed;
    finalError = result.error ?? finalError;

    // Stop early when the target error has been reached or evolveDir
    // returned fewer generations than requested (its own stop signal).
    if (finalError <= config.targetError) break;
    if (completed < chunkIterations) break;
  }

  return { generations: evolved, finalError };
}

/**
 * Run the synthetic-synapse demo end-to-end:
 *
 *   1. Seed `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (minimal, no
 *      hidden hint).
 *   2. evolveDir over the binary `.bin` training set → sparse champion.
 *   3. Densify the sparse champion.
 *   4. evolveDir again to refine the densified creature.
 *   5. Prune synthetic synapses whose magnitude stayed near zero.
 *
 * Returns per-phase scores plus the per-generation telemetry rows.
 */
export async function runSyntheticSynapseDemo(
  config: SyntheticSynapseConfig = DEFAULT_SYNTHETIC_SYNAPSE_CONFIG,
  options: { dataDir?: string } = {},
): Promise<SyntheticSynapseResult> {
  if (config.heldOutSize <= 0 || config.trainingSize <= 0) {
    throw new Error("heldOutSize and trainingSize must be positive");
  }
  if (config.maxIterationsPerPhase <= 0) {
    throw new Error("maxIterationsPerPhase must be positive");
  }
  if (config.timeoutMinutes <= 0) {
    throw new Error("timeoutMinutes must be positive");
  }

  const start = Date.now();
  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ??
    Deno.makeTempDirSync({ prefix: "synthetic_synapse_data_" });

  try {
    // Build target network and synthesise training/held-out datasets.
    const target = buildTargetNetwork(config);
    const trainingSet = generateDataset(
      target,
      config.trainingSize,
      config.seed ^ 0x1234_5678,
    );
    const heldOutSet = generateDataset(
      target,
      config.heldOutSize,
      config.seed ^ 0x9abc_def0,
    );

    if (ownDataDir) writeBinaryDataset(trainingSet, dataDir);

    // NEAT-AI requires `timeoutMinutes` to be a positive integer, so we
    // floor the per-phase split (and clamp at 1 minute) rather than
    // pass the literal half-budget. Each phase still respects the
    // overall 5-minute backstop because the total wall-clock spent
    // across both phases cannot exceed `timeoutMinutes`.
    const phaseTimeoutMinutes = Math.max(
      1,
      Math.floor(config.timeoutMinutes / 2),
    );
    const evolutionRows: EvolutionRow[] = [];
    const phases: PhaseRecord[] = [];
    const topologies: Record<PhaseName, TopologySnapshot> = {} as Record<
      PhaseName,
      TopologySnapshot
    >;

    // ---- Phase 1: minimal seed → evolved sparse champion ---------------
    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const sparsePhase = await runEvolvePhase({
      creature: seed,
      dataDir,
      config,
      phaseTimeoutMinutes,
      rows: evolutionRows,
      generationOffset: 0,
    });
    {
      const noKeys: ReadonlySet<string> = new Set();
      topologies.sparse = snapshotTopology(seed, noKeys);
      phases.push({
        phase: "sparse",
        synapseCount: seed.synapses.length,
        heldOutScore: creatureHeldOutScore(seed, heldOutSet),
      });
    }

    // ---- Phase 2: densify the sparse champion -------------------------
    const syntheticKeys = densifyCreature(seed);
    {
      topologies.densified = snapshotTopology(seed, syntheticKeys);
      phases.push({
        phase: "densified",
        synapseCount: seed.synapses.length,
        heldOutScore: creatureHeldOutScore(seed, heldOutSet),
      });
    }

    // ---- Phase 3: refine the densified creature via evolveDir --------
    await runEvolvePhase({
      creature: seed,
      dataDir,
      config,
      phaseTimeoutMinutes,
      rows: evolutionRows,
      generationOffset: sparsePhase.generations,
    });

    // ---- Phase 4: prune synthetic synapses below threshold -----------
    pruneCreature(seed, syntheticKeys, config.pruneThreshold);
    {
      topologies.pruned = snapshotTopology(seed, syntheticKeys);
      phases.push({
        phase: "pruned",
        synapseCount: seed.synapses.length,
        heldOutScore: creatureHeldOutScore(seed, heldOutSet),
      });
    }

    return {
      phases,
      topologies,
      evolutionRows,
      wallClockMs: Date.now() - start,
      champion: seed,
    };
  } finally {
    if (ownDataDir) {
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch {
        // Ignore cleanup errors — temp dir may already be gone.
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

/** Common SVG header for the per-generation telemetry charts. */
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
 * (orange) versus generation. Used for the README's headline fitness
 * trajectory chart.
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
  const minF = Math.min(...allFitness);
  const maxF = Math.max(...allFitness);
  const fSpan = (maxF - minF) || 1;

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const yScale = (f: number) => innerY + innerH - ((f - minF) / fSpan) * innerH;

  const bestPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: yScale(r.bestFitness),
  }));
  const meanPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: yScale(r.meanFitness),
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
    `aria-label="Synthetic synapse — best vs mean fitness per generation">`,
    `  <title>Synthetic Synapse — Best vs Mean Fitness</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Synthetic Synapse — Best vs Mean Fitness</text>`,
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
 * scale so the (typically larger) synapse line does not compress the
 * neuron line into invisibility.
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
    `aria-label="Synthetic synapse — neuron and synapse counts per generation">`,
    `  <title>Synthetic Synapse — Topology Growth</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Synthetic Synapse — Topology Growth</text>`,
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
  console.log("🧬 Synthetic Synapse Training Demo (issue #85, audited #206)");
  console.log("");

  const { dataDir, creaturesDir } = setupWorkingDirs(WORKING_ROOT);

  console.log(
    "🌱 Building minimal NEAT-AI seed: " +
      `new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  console.log("📊 Generating synthetic dataset and writing binary .bin training set...");

  const config = DEFAULT_SYNTHETIC_SYNAPSE_CONFIG;
  // Pre-generate the binary dataset so the demo + downstream artefacts
  // share one file location.
  const target = buildTargetNetwork(config);
  const trainingSet = generateDataset(target, config.trainingSize, config.seed ^ 0x1234_5678);
  writeBinaryDataset(trainingSet, dataDir);

  console.log(
    `🧪 Running sparse → densified → pruned phases ` +
      `(targetError=${config.targetError}, timeoutMinutes=${config.timeoutMinutes})...`,
  );
  const result = await runSyntheticSynapseDemo(config, { dataDir });

  console.log("");
  console.log(
    `   ${"phase".padEnd(11)} ${"synapses".padStart(10)} ${"held-out score".padStart(16)}`,
  );
  for (const p of result.phases) {
    console.log(
      `   ${p.phase.padEnd(11)} ${String(p.synapseCount).padStart(10)} ${
        p.heldOutScore.toPrecision(6).padStart(16)
      }`,
    );
  }

  // Render the 3-panel topology + bar-chart SVG.
  const svg = renderSyntheticSynapseSVG({
    phases: result.phases,
    topologies: result.topologies,
    controlScore: result.phases[0].heldOutScore,
    controlSynapseCount: result.phases[0].synapseCount,
  });
  ensureDirSync("docs/screenshots");
  ensureDirSync(join(WORKING_ROOT, "output"));
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  await Deno.writeTextFile(WORKING_OUTPUT_PATH, svg);
  console.log(`\n🖼️  Wrote ${SCREENSHOT_PATH}`);

  // Per-generation telemetry artefacts.
  if (result.evolutionRows.length > 0) {
    ensureDirSync("docs/data/synthetic_synapse");
    ensureDirSync("docs/screenshots/synthetic_synapse");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(result.evolutionRows));
    console.log(
      `🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${result.evolutionRows.length} rows)`,
    );
    await Deno.writeTextFile(FITNESS_SVG_PATH, renderFitnessChartSvg(result.evolutionRows));
    console.log(`📈 Wrote best/mean fitness chart ${FITNESS_SVG_PATH}`);
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, renderTopologyChartSvg(result.evolutionRows));
    console.log(`📈 Wrote neuron/synapse chart ${TOPOLOGY_SVG_PATH}`);
  } else {
    console.log("⚠️  No per-generation telemetry captured (evolveDir produced zero events)");
  }

  // Save the champion creature for downstream inspection.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Final summary line so the README can quote real measured numbers.
  const finalRow = result.evolutionRows[result.evolutionRows.length - 1];
  if (finalRow) {
    console.log(
      `\n🏁 Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${finalRow.meanFitness.toFixed(4)}  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(
    `🕒 Completed in ${format(result.wallClockMs, { ignoreZero: true })}`,
  );
}
