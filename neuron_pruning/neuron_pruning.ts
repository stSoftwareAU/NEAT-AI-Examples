/**
 * Neuron Pruning Demo (issue #87, audited under #217, telemetry simplified
 * under #303).
 *
 * Demonstrates how NEAT-AI keeps creatures lean by removing hidden
 * neurons whose activations don't vary across the held-out dataset, and
 * folding their constant contribution into the downstream neurons'
 * biases. The folded creature is mathematically equivalent to the
 * original on the sampled dataset — every removed neuron only ever
 * output one value, so its contribution to a downstream neuron is the
 * same constant on every record.
 *
 * Under #303 the per-generation `onTrainingEvent` hook and the chunked
 * `evolveDir` loop were removed in favour of NEAT-AI's supported
 * milestone-only telemetry surface. The example now makes a single
 * `Creature.evolveDir(...)` call and captures an {@link EvolveDirSummary}
 * from its return value. The bespoke topology before/after panel
 * remains the headline narrative — its held-out score callouts are
 * sourced from the new milestone summary path.
 *
 * The audit (issue #217) brings the example in line with the
 * minimal-seed policy in `AGENTS.md`:
 *
 * 1. The creature passed to NEAT-AI is built **only** from
 *    `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — no hidden-layer hint,
 *    no pre-built `network.json` seed, no hand-tuned shape. NEAT-AI
 *    random-initialises the rest.
 * 2. Evolution runs through `Creature.evolveDir(dataDir, neatOptions)`
 *    over a pre-generated binary `.bin` training set; the topology is
 *    learned by NEAT, not bolted on by the example.
 * 3. Stop conditions are a per-example `targetError` plus a
 *    `timeoutMinutes: 20` safety backstop (raised from 5 by issue #385
 *    for the `Refresh-2026-05` milestone — +15 minutes of additional
 *    wall-clock evolution budget on top of the original audit limit).
 *
 * The pruning operation then runs on the **evolved** champion: hidden
 * neurons are deliberately converted to constant-output (zero incoming
 * weights, non-zero bias) so pruning has something to remove, then
 * detected by activation variance and folded into downstream biases.
 * Per `AGENTS.md`, this hand-crafted constant-neuron injection is
 * exempt from the no-warm-start policy because the demo's whole point
 * is to demonstrate the prune operation — the seed itself remains the
 * minimal `new Creature(INPUT_COUNT, OUTPUT_COUNT)`.
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
import {
  activate,
  type FeedForwardNetwork,
  forward,
  heldOutScore,
  networkFromCreature as buildFeedForwardNetwork,
  type NetworkNeuron,
  type NetworkSynapse,
} from "../common/feed_forward_network.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { renderNeuronPruningSVG } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".neuron-pruning";

/**
 * Path to the SVG snapshot the runner emits. Lives under `docs/screenshots/`
 * so the rendered topology + bias-fold arrows are committed to the repo
 * and show up inline on GitHub the same way every other example screenshot
 * does.
 */
export const SCREENSHOT_PATH = "docs/screenshots/neuron_pruning.svg";

/**
 * Mirror copy of the SVG written under `WORKING_ROOT/output/` so the
 * canonical "output/" location requested in issue #87 is also populated.
 */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "neuron_pruning.svg");

/** Milestone summary SVG path — sourced from the `evolveDir` return value. */
export const EVOLUTION_SUMMARY_SVG_PATH = "docs/screenshots/neuron_pruning/evolution_summary.svg";

/**
 * Number of input neurons fed to the NEAT-AI seed.
 *
 * Four inputs combined with two outputs gives NEAT enough degrees of
 * freedom that pure direct input → output synapses cannot fit the
 * synthesised target, so evolution has to invent hidden neurons (and
 * therefore synapses) for the example to converge — that's what gives
 * the prune step something to act on.
 */
export const INPUT_COUNT = 4;

/** Number of output neurons fed to the NEAT-AI seed. */
export const OUTPUT_COUNT = 2;

/** Configuration for {@link runNeuronPruningDemo}. */
export interface NeuronPruningConfig {
  /** Number of input neurons in the creature under demo. */
  inputs: number;
  /** Hidden-neuron count of the *target* network (not the NEAT seed). */
  hidden: number;
  /** Number of output neurons in the creature under demo. */
  outputs: number;
  /** Connection density of the underlying sparse target, in [0, 1]. */
  density: number;
  /**
   * Number of hidden neurons to deliberately convert into constant-output
   * neurons after evolution. Capped to the evolved champion's actual
   * hidden count — fewer if evolution did not grow that many.
   */
  constantNeurons: number;
  /** Random seed for the dataset, NEAT-AI, and constant-neuron selection. */
  seed: number;
  /** Records written to the binary `.bin` training set. */
  trainingSize: number;
  /** Held-out records used to score pre/post-prune. */
  heldOutSize: number;
  /**
   * Variance threshold below which a neuron's activation is considered
   * constant. Defaults to `1e-12` — anything smaller than this is
   * floating-point noise.
   */
  varianceThreshold: number;
  /** Per-example `targetError` driving early exit from evolveDir. */
  targetError: number;
  /**
   * Wall-clock backstop in minutes for the whole evolveDir phase.
   * Issue #217 originally mandated 5 minutes; issue #385 raises this to
   * 20 minutes (+15 wall-clock minutes) for the `Refresh-2026-05`
   * milestone refresh.
   */
  timeoutMinutes: number;
  /** NEAT population size. Small for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
}

/**
 * Defaults chosen so the demo converges via `targetError` well inside
 * the wall-clock backstop on a developer machine while still illustrating
 * constant-neuron removal clearly. Issue #385 lifts `timeoutMinutes`
 * from 5 → 20 and `maxIterations` from 400 → 1 600 for the
 * `Refresh-2026-05` milestone — +15 minutes of additional wall-clock
 * evolution budget so the iteration cap is not the limiter on newer
 * NEAT-AI builds.
 */
export const DEFAULT_NEURON_PRUNING_CONFIG: NeuronPruningConfig = {
  inputs: INPUT_COUNT,
  hidden: 8,
  outputs: OUTPUT_COUNT,
  density: 1.0,
  constantNeurons: 3,
  seed: 870870870,
  trainingSize: 128,
  heldOutSize: 64,
  varianceThreshold: 1e-12,
  targetError: 0.005,
  timeoutMinutes: 20,
  populationSize: 32,
  maxIterations: 1600,
};

/** A single held-out record. */
export interface DataPoint {
  inputs: Float32Array;
  targets: Float32Array;
}

/** Per-pruned-neuron audit entry. */
export interface PrunedNeuronRecord {
  /** Original index (pre-prune) of the constant neuron. */
  neuronIndex: number;
  /** Constant value the neuron produced for every record. */
  constantOutput: number;
  /**
   * Original indices of the downstream neurons whose biases absorbed the
   * fold contribution. Sorted ascending.
   */
  biasFoldTargets: number[];
}

/** Combined result of running the neuron-pruning demo. */
export interface NeuronPruningResult {
  /** Neuron count of the creature before pruning (post-evolution + injection). */
  preNeuronCount: number;
  /** Neuron count of the creature after pruning. */
  postNeuronCount: number;
  /** Synapse count of the creature before pruning. */
  preSynapseCount: number;
  /** Synapse count of the creature after pruning. */
  postSynapseCount: number;
  /** Held-out score (negative MSE — higher is better) before pruning. */
  preScore: number;
  /** Held-out score (negative MSE — higher is better) after pruning. */
  postScore: number;
  /** Per-pruned-neuron audit entries. */
  pruned: PrunedNeuronRecord[];
  /** Topology snapshot used by the SVG renderer. */
  topology: TopologySnapshot;
  /**
   * Milestone summary captured from the single `evolveDir` call. Provides
   * the held-out score / generations / wall-clock callouts the headline
   * topology panel sources for its summary lines.
   */
  evolutionSummary: EvolveDirSummary;
  /** Total wall-clock time of the run, in milliseconds. */
  wallClockMs: number;
  /** Final pruned champion creature. */
  champion: Creature;
}

/**
 * Minimal feed-forward network the pruner manipulates. The evaluation
 * core — creature → network conversion, the forward pass, and the
 * scorers — is shared with the synthetic-synapse demo via
 * `common/feed_forward_network.ts` (issue #775).
 */
export interface Network extends FeedForwardNetwork {
  /** All neurons sorted by index (inputs, then hidden, then outputs). */
  neurons: NetworkNeuron[];
  /** All synapses; `from < to` always (strictly feed-forward). */
  synapses: NetworkSynapse[];
}

export type { NetworkNeuron, NetworkSynapse };

/** Topology snapshot captured for rendering. */
export interface TopologySnapshot {
  inputCount: number;
  outputCount: number;
  hiddenCount: number;
  /**
   * Indices (within the pre-prune neurons array) marked as pruned. The
   * SVG renderer uses these to grey-out the corresponding circles.
   */
  prunedIndices: number[];
  /**
   * Edges representing the original connectivity. Each edge carries an
   * `original` flag so the renderer can dim the arms of pruned neurons.
   */
  edges: Array<{ from: number; to: number; pruned: boolean }>;
  /**
   * Bias-fold arrows: every constant neuron emits one fold edge per
   * downstream target it influenced.
   */
  biasFolds: Array<{ from: number; to: number }>;
}

/**
 * Construct an internal {@link Network} from a `Creature`. Only LOGISTIC,
 * TANH, and IDENTITY squashes are supported — anything else throws.
 */
export function networkFromCreature(creature: Creature): Network {
  const base = buildFeedForwardNetwork(creature, { label: "neuron-pruning demo" });
  return {
    inputCount: base.inputCount,
    outputCount: base.outputCount,
    neurons: [...base.neurons],
    synapses: [...base.synapses],
  };
}

// The activation function, the forward pass, and the held-out scorer are
// re-exported unchanged from the shared module so the example's public
// surface is unaffected by the extraction.
export { activate, forward, heldOutScore };

/**
 * Generate a deterministic dataset by feeding `size` random inputs through
 * `targetNetwork`. Inputs are drawn uniformly from `[-1, 1]`.
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
 * Build the "ground truth" target network the dataset is generated
 * from. The target is **not** the NEAT seed — it just produces labels
 * that the evolved creature must learn to reproduce. Hand-shaping the
 * target is fine; only the seed needs to be minimal.
 */
export function buildTargetNetwork(config: NeuronPruningConfig): Network {
  const target = buildLargeCreature({
    inputs: config.inputs,
    hidden: config.hidden,
    outputs: config.outputs,
    density: config.density,
    seed: config.seed ^ 0x7777_7777,
  });
  return networkFromCreature(target);
}

/**
 * Convert `count` hidden neurons into deliberately constant-output neurons.
 * For each chosen neuron we drop every incoming synapse and assign a
 * non-zero bias drawn from the same deterministic PRNG. After this
 * mutation the neuron's output is `activate(squash, bias)` regardless of
 * the input record — exactly the kind of dead weight neuron pruning is
 * designed to remove.
 *
 * Returns the indices of the converted neurons in ascending order.
 */
export function injectConstantNeurons(
  network: Network,
  count: number,
  seed: number,
): number[] {
  if (count < 0) {
    throw new Error(`count must be >= 0, got ${count}`);
  }
  const N = network.neurons.length;
  const outStart = N - network.outputCount;
  const hiddenCount = outStart - network.inputCount;
  if (count > hiddenCount) {
    throw new Error(`count (${count}) exceeds hidden neuron count (${hiddenCount})`);
  }

  const rng = createDeterministicRandom(seed);
  // Fisher-Yates shuffle of the hidden indices, take the first `count`.
  const hiddenIndices: number[] = [];
  for (let i = 0; i < hiddenCount; i++) hiddenIndices.push(network.inputCount + i);
  for (let i = hiddenIndices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = hiddenIndices[i];
    hiddenIndices[i] = hiddenIndices[j];
    hiddenIndices[j] = tmp;
  }
  const chosen = hiddenIndices.slice(0, count).sort((a, b) => a - b);
  const chosenSet = new Set(chosen);

  // Drop incoming synapses of every chosen neuron.
  network.synapses = network.synapses.filter((s) => !chosenSet.has(s.to));

  // Assign a non-zero bias so `activate(squash, bias)` is non-trivial.
  for (const idx of chosen) {
    network.neurons[idx].bias = rng() * 1.6 - 0.8;
  }

  return chosen;
}

/**
 * Detect neurons whose activation does not vary across `dataset`. Returns
 * a record per detected neuron with the constant output value. Inputs and
 * outputs are never reported — pruning them would change the network's
 * external interface.
 */
export function detectConstantNeurons(
  network: Network,
  dataset: readonly DataPoint[],
  varianceThreshold: number,
): Array<{ index: number; constantOutput: number }> {
  if (varianceThreshold < 0) {
    throw new Error(`varianceThreshold must be >= 0, got ${varianceThreshold}`);
  }
  if (dataset.length === 0) return [];
  const N = network.neurons.length;
  const outStart = N - network.outputCount;

  // Online mean + sum-of-squared-deviations (Welford) per neuron.
  const mean = new Float64Array(N);
  const m2 = new Float64Array(N);
  let n = 0;

  for (const point of dataset) {
    const acts = forward(network, point.inputs);
    n++;
    for (let i = 0; i < N; i++) {
      const x = acts[i];
      const delta = x - mean[i];
      mean[i] += delta / n;
      m2[i] += delta * (x - mean[i]);
    }
  }

  const constants: Array<{ index: number; constantOutput: number }> = [];
  for (let i = network.inputCount; i < outStart; i++) {
    const variance = m2[i] / dataset.length;
    if (variance <= varianceThreshold) {
      constants.push({ index: i, constantOutput: mean[i] });
    }
  }
  return constants;
}

/**
 * Prune `constants` from `network`, folding each constant neuron's
 * contribution into the bias of every downstream neuron it influenced.
 * The neurons array is rebuilt in original order with the pruned ones
 * removed; remaining synapses are re-indexed against the new neuron
 * positions.
 *
 * Returns one {@link PrunedNeuronRecord} per pruned neuron, ordered by
 * the original neuron index.
 */
export function pruneConstantNeurons(
  network: Network,
  constants: ReadonlyArray<{ index: number; constantOutput: number }>,
): PrunedNeuronRecord[] {
  if (constants.length === 0) return [];
  const constantByIndex = new Map<number, number>();
  for (const c of constants) constantByIndex.set(c.index, c.constantOutput);

  const records = new Map<number, PrunedNeuronRecord>();
  for (const c of constants) {
    records.set(c.index, {
      neuronIndex: c.index,
      constantOutput: c.constantOutput,
      biasFoldTargets: [],
    });
  }

  // Fold every outgoing synapse from a constant neuron into the target's
  // bias, then drop those synapses. We also drop synapses that lead INTO
  // a constant neuron (they carry no information for the surviving
  // network).
  const survivingSynapses: NetworkSynapse[] = [];
  for (const s of network.synapses) {
    if (constantByIndex.has(s.from)) {
      const v = constantByIndex.get(s.from) as number;
      network.neurons[s.to].bias += s.weight * v;
      const rec = records.get(s.from) as PrunedNeuronRecord;
      if (!rec.biasFoldTargets.includes(s.to)) {
        rec.biasFoldTargets.push(s.to);
      }
      continue;
    }
    if (constantByIndex.has(s.to)) {
      // Drop synapses targeting a pruned neuron — the neuron is gone.
      continue;
    }
    survivingSynapses.push(s);
  }

  // Sort each record's targets ascending for stable reporting.
  for (const rec of records.values()) {
    rec.biasFoldTargets.sort((a, b) => a - b);
  }

  // Rebuild the neurons array without the pruned ones; build an
  // old-index → new-index translation table for synapse re-indexing.
  const newNeurons: NetworkNeuron[] = [];
  const remap = new Map<number, number>();
  for (let i = 0; i < network.neurons.length; i++) {
    if (constantByIndex.has(i)) continue;
    const newIdx = newNeurons.length;
    remap.set(i, newIdx);
    newNeurons.push({ ...network.neurons[i], index: newIdx });
  }

  network.neurons = newNeurons;
  network.synapses = survivingSynapses.map((s) => ({
    from: remap.get(s.from) as number,
    to: remap.get(s.to) as number,
    weight: s.weight,
  }));

  return [...records.values()].sort((a, b) => a.neuronIndex - b.neuronIndex);
}

/** Snapshot the topology for the SVG renderer. */
function snapshotTopology(
  preNetwork: Network,
  prunedRecords: PrunedNeuronRecord[],
): TopologySnapshot {
  const prunedIndices = prunedRecords.map((r) => r.neuronIndex);
  const prunedSet = new Set(prunedIndices);
  const edges = preNetwork.synapses.map((s) => ({
    from: s.from,
    to: s.to,
    pruned: prunedSet.has(s.from) || prunedSet.has(s.to),
  }));
  const biasFolds: Array<{ from: number; to: number }> = [];
  for (const rec of prunedRecords) {
    for (const t of rec.biasFoldTargets) {
      biasFolds.push({ from: rec.neuronIndex, to: t });
    }
  }
  return {
    inputCount: preNetwork.inputCount,
    outputCount: preNetwork.outputCount,
    hiddenCount: preNetwork.neurons.length - preNetwork.inputCount - preNetwork.outputCount,
    prunedIndices,
    edges,
    biasFolds,
  };
}

/** Deep-clone a network so callers can score "before" and "after" cleanly. */
export function cloneNetwork(network: Network): Network {
  return {
    inputCount: network.inputCount,
    outputCount: network.outputCount,
    neurons: network.neurons.map((n) => ({ ...n })),
    synapses: network.synapses.map((s) => ({ ...s })),
  };
}

/**
 * Build a "demo network" for the legacy synchronous helpers exercised
 * by the unit-test suite. Mirrors the historical behaviour of the
 * pre-audit example.
 */
export function buildDemoNetwork(config: NeuronPruningConfig): Network {
  const creature = buildLargeCreature({
    inputs: config.inputs,
    hidden: config.hidden,
    outputs: config.outputs,
    density: config.density,
    seed: config.seed,
  });
  const network = networkFromCreature(creature);
  injectConstantNeurons(network, config.constantNeurons, config.seed ^ 0x5a5a_5a5a);
  return network;
}

/**
 * Held-out score for a `Creature` using its own `activate(...)` method.
 * Used to validate the evolved champion before injection — the local
 * {@link forward} helper only knows about IDENTITY/TANH/LOGISTIC, but
 * NEAT-AI may evolve any of its supported squash functions and the
 * creature itself can always activate them.
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
 * Run the neuron-pruning demo end-to-end:
 *
 *   1. Seed `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (minimal, no
 *      hidden hint).
 *   2. Run a single `evolveDir` over the binary `.bin` training set →
 *      evolved champion. The call's return value populates an
 *      {@link EvolveDirSummary} (final error, score, generations,
 *      wall-clock + seed/final topology) — no per-generation hook.
 *   3. Inject deliberately constant-output hidden neurons.
 *   4. Score pre-prune, detect constant neurons, fold biases, drop the
 *      constant neurons, score post-prune.
 */
export async function runNeuronPruningDemo(
  config: NeuronPruningConfig = DEFAULT_NEURON_PRUNING_CONFIG,
  options: { dataDir?: string } = {},
): Promise<NeuronPruningResult> {
  if (config.heldOutSize <= 0) {
    throw new Error("heldOutSize must be positive");
  }
  if (config.trainingSize <= 0) {
    throw new Error("trainingSize must be positive");
  }
  if (config.constantNeurons <= 0) {
    throw new Error("constantNeurons must be positive");
  }
  if (!(config.density >= 0 && config.density <= 1)) {
    throw new Error(`density must be in [0, 1], got ${config.density}`);
  }
  if (config.maxIterations <= 0) {
    throw new Error("maxIterations must be positive");
  }
  if (config.timeoutMinutes <= 0) {
    throw new Error("timeoutMinutes must be positive");
  }

  const start = Date.now();
  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ??
    Deno.makeTempDirSync({ prefix: "neuron_pruning_data_" });

  try {
    // Build target network and synthesise training/held-out datasets.
    const target = buildTargetNetwork(config);
    const trainingSet = generateDataset(
      target,
      config.trainingSize,
      config.seed ^ 0x1234_5678,
    );
    const heldOutDataset = generateDataset(
      target,
      config.heldOutSize,
      config.seed ^ 0x9abc_def0,
    );

    if (ownDataDir) writeBinaryDataset(trainingSet, dataDir);

    // ---- Stage 1: minimal seed → single evolveDir call → champion ----
    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const seedNeuronCount = seed.neurons.length;
    const seedSynapseCount = seed.synapses.length;

    const evolveStart = Date.now();
    const neatOptions: NeatOptions = {
      seed: config.seed,
      populationSize: config.populationSize,
      iterations: config.maxIterations,
      targetError: config.targetError,
      timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
      costOfGrowth: 0,
      // Push NEAT toward structural growth so the seed actually adds
      // hidden neurons and synapses — otherwise pruning has nothing to
      // remove.
      mutationRate: 0.6,
      mutationAmount: 3,
      verbose: false,
      log: 0,
      threads: 1,
    };
    const evolveResult = await seed.evolveDir(dataDir, neatOptions);
    const evolveWallClockMs = Date.now() - evolveStart;
    const finalError = Number.isFinite(evolveResult.error) ? evolveResult.error : 0;
    const finalScore = Number.isFinite(evolveResult.score) ? evolveResult.score : 0;
    const generations = Math.max(1, evolveResult.generation ?? 1);

    // ---- Stage 2: convert evolved champion to internal Network ---------
    const network = networkFromEvolvedCreature(seed);

    // ---- Stage 3: inject deliberately constant-output hidden neurons --
    const hiddenCount = network.neurons.length - network.inputCount - network.outputCount;
    const injectCount = Math.max(0, Math.min(config.constantNeurons, hiddenCount));
    if (injectCount > 0) {
      injectConstantNeurons(network, injectCount, config.seed ^ 0x5a5a_5a5a);
    }

    // ---- Stage 4: detect, score, prune, score -------------------------
    const preNetwork = cloneNetwork(network);
    const preScore = heldOutScore(preNetwork, heldOutDataset);
    const preNeuronCount = preNetwork.neurons.length;
    const preSynapseCount = preNetwork.synapses.length;

    const constants = detectConstantNeurons(network, heldOutDataset, config.varianceThreshold);
    const pruned = pruneConstantNeurons(network, constants);
    const postScore = heldOutScore(network, heldOutDataset);
    const postNeuronCount = network.neurons.length;
    const postSynapseCount = network.synapses.length;

    const topology = snapshotTopology(preNetwork, pruned);

    // Build the milestone summary from the evolveDir return value plus
    // the seed and final (post-prune) creature topology. The held-out
    // score callouts on the topology panel are sourced from this
    // milestone path.
    const evolutionSummary: EvolveDirSummary = {
      finalError,
      finalScore,
      wallClockMs: evolveWallClockMs,
      generations,
      seedNeurons: seedNeuronCount,
      seedSynapses: seedSynapseCount,
      finalNeurons: postNeuronCount,
      finalSynapses: postSynapseCount,
      targetError: config.targetError,
      timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
    };

    return {
      preNeuronCount,
      postNeuronCount,
      preSynapseCount,
      postSynapseCount,
      preScore,
      postScore,
      pruned,
      topology,
      evolutionSummary,
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
 * Convert an evolved `Creature` to the internal {@link Network} struct.
 * Squash functions outside the analytical helper's supported set
 * (IDENTITY / TANH / LOGISTIC) are remapped to TANH — the example's
 * downstream prune step works on the simplified analytical network,
 * not the original Creature, and remap-to-TANH keeps every neuron's
 * activation bounded so the bias-fold path stays well-defined.
 */
function networkFromEvolvedCreature(creature: Creature): Network {
  const base = buildFeedForwardNetwork(creature, {
    label: "neuron-pruning demo",
    onUnknownSquash: "tanh",
  });
  return {
    inputCount: base.inputCount,
    outputCount: base.outputCount,
    neurons: [...base.neurons],
    synapses: [...base.synapses],
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("✂️  Neuron Pruning Demo (issue #87, audited #217, telemetry rewire #303)");
  console.log("");

  const { dataDir, creaturesDir } = setupWorkingDirs(WORKING_ROOT);

  console.log(
    "🌱 Building minimal NEAT-AI seed: " +
      `new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  console.log("📊 Generating synthetic dataset and writing binary .bin training set...");

  const config = DEFAULT_NEURON_PRUNING_CONFIG;
  const target = buildTargetNetwork(config);
  const trainingSet = generateDataset(target, config.trainingSize, config.seed ^ 0x1234_5678);
  writeBinaryDataset(trainingSet, dataDir);

  console.log(
    `🧪 Evolving from minimal seed via a single Creature.evolveDir(...) call ` +
      `(targetError=${config.targetError}, timeoutMinutes=${config.timeoutMinutes})...`,
  );
  const result = await runNeuronPruningDemo(config, { dataDir });

  console.log("");
  console.log(
    `   pre-prune  neurons=${result.preNeuronCount}  synapses=${result.preSynapseCount}  ` +
      `score=${result.preScore.toPrecision(6)}`,
  );
  console.log(
    `   post-prune neurons=${result.postNeuronCount}  synapses=${result.postSynapseCount}  ` +
      `score=${result.postScore.toPrecision(6)}`,
  );
  console.log(
    `   delta      neurons=${result.preNeuronCount - result.postNeuronCount}  ` +
      `synapses=${result.preSynapseCount - result.postSynapseCount}  ` +
      `score=${(result.postScore - result.preScore).toPrecision(4)}`,
  );
  console.log(
    `   evolveDir  generations=${result.evolutionSummary.generations}  ` +
      `wallClock=${(result.evolutionSummary.wallClockMs / 1000).toFixed(1)}s  ` +
      `finalScore=${result.evolutionSummary.finalScore.toFixed(4)}  ` +
      `finalError=${result.evolutionSummary.finalError.toFixed(4)}`,
  );
  console.log("");
  console.log("   pruned neurons (index → bias-fold targets):");
  for (const rec of result.pruned) {
    console.log(
      `     #${rec.neuronIndex} (output=${rec.constantOutput.toFixed(4)}) → [${
        rec.biasFoldTargets.join(", ")
      }]`,
    );
  }

  const svg = renderNeuronPruningSVG({
    topology: result.topology,
    preNeuronCount: result.preNeuronCount,
    postNeuronCount: result.postNeuronCount,
    preScore: result.preScore,
    postScore: result.postScore,
    pruned: result.pruned,
  });
  ensureDirSync("docs/screenshots");
  ensureDirSync(join(WORKING_ROOT, "output"));
  ensureDirSync("docs/screenshots/neuron_pruning");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  await Deno.writeTextFile(WORKING_OUTPUT_PATH, svg);
  console.log(`\n🖼️  Wrote ${SCREENSHOT_PATH}`);
  console.log(`🖼️  Mirror at ${WORKING_OUTPUT_PATH}`);

  // Milestone summary SVG sourced from the single evolveDir call.
  const summarySvg = renderEvolveDirSummarySvg(result.evolutionSummary, {
    title: "Neuron Pruning — evolveDir Run Summary",
  });
  await Deno.writeTextFile(EVOLUTION_SUMMARY_SVG_PATH, summarySvg);
  console.log(`📈 Wrote ${EVOLUTION_SUMMARY_SVG_PATH}`);

  // Save the champion creature for downstream inspection.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
  console.log(`(Total wall-clock from runNeuronPruningDemo: ${result.wallClockMs} ms)`);
}
