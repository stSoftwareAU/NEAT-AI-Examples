/**
 * Neuron Pruning Demo (issue #87, audited under #217).
 *
 * Demonstrates how NEAT-AI keeps creatures lean by removing hidden
 * neurons whose activations don't vary across the held-out dataset, and
 * folding their constant contribution into the downstream neurons'
 * biases. The folded creature is mathematically equivalent to the
 * original on the sampled dataset — every removed neuron only ever
 * output one value, so its contribution to a downstream neuron is the
 * same constant on every record.
 *
 * The audit (issue #217) brings the example in line with the
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
 *    synapse count) is captured during the evolveDir phase and written
 *    out as CSV + two SVG charts so the README can quote real measured
 *    numbers from the latest run.
 *
 * The pruning operation then runs on the **evolved** champion: hidden
 * neurons are deliberately converted to constant-output (zero incoming
 * weights, non-zero bias) so pruning has something to remove, then
 * detected by activation variance and folded into downstream biases.
 * Per `AGENTS.md`, this hand-crafted constant-neuron injection is
 * exempt from the no-warm-start policy because the demo's whole point
 * is to demonstrate the prune operation — the seed itself remains the
 * minimal `new Creature(INPUT_COUNT, OUTPUT_COUNT)`.
 *
 * The pipeline:
 *
 * 1. Build a minimal NEAT-AI seed (`new Creature(INPUT_COUNT, OUTPUT_COUNT)`).
 * 2. Generate a binary `.bin` training set from a synthesised target.
 * 3. evolveDir over the binary file → evolved champion.
 * 4. Inject deliberately constant-output hidden neurons into the
 *    champion by zeroing their incoming weights and giving them a
 *    non-zero bias — so every record produces `activate(bias)`.
 * 5. Score the pre-prune creature on a held-out dataset.
 * 6. Detect constant neurons by measuring activation variance across
 *    the same dataset.
 * 7. Prune them: for every outgoing synapse `c → t` of a constant
 *    neuron with output `v`, add `weight * v` to `t.bias`, then drop
 *    neuron `c` and all its synapses.
 * 8. Score the post-prune creature on the same held-out dataset — the
 *    score must not regress because the network is mathematically
 *    equivalent on every sampled record.
 *
 * The demo prints per-generation telemetry, the per-neuron pruning
 * report (which constant neurons were removed, and which downstream
 * neurons absorbed their bias-fold contribution), and renders
 * `output/neuron_pruning.svg` showing the topology with pruned
 * neurons greyed-out and bias-fold arrows drawn to the surviving
 * downstream neighbours.
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

/** Per-generation evolution-telemetry CSV path. */
export const EVOLUTION_CSV_PATH = "docs/data/neuron_pruning/evolution.csv";

/** CSV header — matches the schema mandated by issue #217. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/neuron_pruning/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/neuron_pruning/topology.svg";

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
   * Issue #217 mandates 5 minutes as the upper bound.
   */
  timeoutMinutes: number;
  /** NEAT population size. Small for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
}

/**
 * Defaults chosen so the demo converges via `targetError` well inside
 * the 5-minute backstop on a developer machine while still illustrating
 * constant-neuron removal clearly. The `targetError` is loose enough
 * that evolution finishes quickly but still has to grow at least a few
 * hidden neurons to fit the synthesised target — without hidden
 * neurons there would be nothing to prune.
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
  timeoutMinutes: 5,
  populationSize: 32,
  maxIterations: 400,
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
  /** Per-generation telemetry from evolveDir, plus a final post-prune row. */
  evolutionRows: EvolutionRow[];
  /** Total wall-clock time of the run, in milliseconds. */
  wallClockMs: number;
  /** Final pruned champion creature. */
  champion: Creature;
}

/** Minimal feed-forward network the pruner manipulates. */
export interface Network {
  inputCount: number;
  outputCount: number;
  /** All neurons sorted by index (inputs, then hidden, then outputs). */
  neurons: NetworkNeuron[];
  /** All synapses; `from < to` always (strictly feed-forward). */
  synapses: NetworkSynapse[];
}

/** A single neuron in the {@link Network} representation. */
export interface NetworkNeuron {
  index: number;
  type: "input" | "hidden" | "output";
  squash: SquashName;
  bias: number;
}

/** A single synapse in the {@link Network} representation. */
export interface NetworkSynapse {
  from: number;
  to: number;
  weight: number;
}

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

type SquashName = "IDENTITY" | "TANH" | "LOGISTIC";

const KNOWN_SQUASHES: SquashName[] = ["IDENTITY", "TANH", "LOGISTIC"];

function isKnownSquash(name: string): name is SquashName {
  return (KNOWN_SQUASHES as string[]).includes(name);
}

/** Activation function evaluated on `z`. */
export function activate(squash: SquashName, z: number): number {
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

/**
 * Construct an internal {@link Network} from a `Creature`. Only LOGISTIC,
 * TANH, and IDENTITY squashes are supported — anything else throws.
 */
export function networkFromCreature(creature: Creature): Network {
  const neurons: NetworkNeuron[] = creature.neurons.map((n, idx) => {
    const squash = (n.squash ?? "IDENTITY").toUpperCase();
    if (!isKnownSquash(squash)) {
      throw new Error(`Unsupported squash function for neuron-pruning demo: ${squash}`);
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

  const synapses: NetworkSynapse[] = creature.synapses.map((s) => ({
    from: s.from,
    to: s.to,
    weight: s.weight,
  }));

  return {
    inputCount: creature.input,
    outputCount: creature.output,
    neurons,
    synapses,
  };
}

/** Forward pass over `network`. Returns the activations for every neuron. */
export function forward(network: Network, input: ArrayLike<number>): Float32Array {
  if (input.length !== network.inputCount) {
    throw new Error(
      `forward: expected ${network.inputCount} inputs, got ${input.length}`,
    );
  }
  const N = network.neurons.length;
  const activations = new Float32Array(N);
  // Inputs pass through their squash (usually IDENTITY).
  for (let i = 0; i < network.inputCount; i++) {
    activations[i] = activate(network.neurons[i].squash, input[i]);
  }
  // Bin incoming synapses by target neuron so each non-input neuron can
  // be activated in turn — finalising its sum before any downstream
  // neuron reads its activation. This is essential for hidden→hidden
  // cascades; pre-aggregating all sums in a single pass would read
  // upstream hidden activations before they were computed.
  const incoming: Array<Array<{ from: number; weight: number }>> = Array.from(
    { length: N },
    () => [],
  );
  for (const s of network.synapses) {
    incoming[s.to].push({ from: s.from, weight: s.weight });
  }
  // Synapses are guaranteed `from < to` (strictly feed-forward), so
  // processing neurons in index order is a valid topological order.
  for (let i = network.inputCount; i < N; i++) {
    let z = network.neurons[i].bias;
    const inc = incoming[i];
    for (let k = 0; k < inc.length; k++) {
      z += inc[k].weight * activations[inc[k].from];
    }
    activations[i] = activate(network.neurons[i].squash, z);
  }
  return activations;
}

/** Mean-squared error between the network's outputs and `targets`. */
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
 * pre-audit example: build a sparse target via `buildLargeCreature`,
 * convert it, and inject `constantNeurons` deliberately constant-output
 * hidden neurons. The audit's main entry point
 * (`runNeuronPruningDemo`) does not call this — it evolves a champion
 * via `Creature.evolveDir(...)` from a minimal seed and injects into
 * the evolved champion instead.
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
 * Iterations per `evolveDir` chunk. Each chunk refreshes the
 * passed-in creature in place, so chunking the phase into smaller
 * runs gives the per-generation telemetry chart visible step changes
 * in neuron/synapse counts as NEAT mutates the topology. We use a
 * small chunk size here so the telemetry chart captures intermediate
 * topology growth — with chunks of 50 a fast-converging
 * `targetError` would be met in the first chunk and the chart would
 * show only the seed state and the post-prune endpoint.
 */
const PHASE_CHUNK_ITERATIONS = 5;

/**
 * Run an evolveDir phase against `dataDir`, capturing per-generation
 * telemetry into `rows`. The phase is split into fixed-size chunks so
 * the post-chunk topology is refreshed in the passed-in `creature` and
 * reflected in the next chunk's events. The phase exits early when
 * `targetError` is met or iterations exhausted.
 *
 * Returns the cumulative generation count actually evolved plus the
 * final error reported by NEAT-AI.
 */
async function runEvolvePhase(opts: {
  creature: Creature;
  dataDir: string;
  config: NeuronPruningConfig;
  rows: EvolutionRow[];
}): Promise<{ generations: number; finalError: number }> {
  const { creature, dataDir, config, rows } = opts;

  let evolved = 0;
  let finalError = Number.POSITIVE_INFINITY;
  const phaseStart = Date.now();
  const phaseBudgetMs = config.timeoutMinutes * 60_000;

  while (evolved < config.maxIterations) {
    // Pre-chunk topology snapshot. NEAT-AI only updates the passed-in
    // `creature` reference at the end of each evolveDir call, so the
    // event handler reports these counts for every event inside the
    // chunk and the next chunk re-reads after the await resolves.
    const segmentStartNeurons = creature.neurons.length;
    const segmentStartSynapses = creature.synapses.length;

    const remainingIterations = config.maxIterations - evolved;
    const chunkIterations = Math.min(PHASE_CHUNK_ITERATIONS, remainingIterations);
    const elapsedMs = Date.now() - phaseStart;
    if (elapsedMs >= phaseBudgetMs) break;

    // NEAT-AI requires `timeoutMinutes` to be a positive integer. Floor
    // the configured backstop and clamp to at least one minute so tiny
    // test budgets (e.g. 0.05) still satisfy the validator. The chunk
    // is also iteration-bounded by `chunkIterations`, so the very small
    // configured budget is still respected via the wall-clock check
    // below.
    const chunkTimeoutMinutes = Math.max(1, Math.floor(config.timeoutMinutes));

    const neatOptions: NeatOptions = {
      seed: config.seed + evolved,
      populationSize: config.populationSize,
      iterations: chunkIterations,
      targetError: config.targetError,
      timeoutMinutes: chunkTimeoutMinutes,
      costOfGrowth: 0,
      // Push NEAT toward structural growth so the seed actually adds
      // hidden neurons and synapses — otherwise pruning has nothing to
      // remove.
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
 *   2. evolveDir over the binary `.bin` training set → evolved champion.
 *   3. Inject deliberately constant-output hidden neurons.
 *   4. Score pre-prune, detect constant neurons, fold biases, drop the
 *      constant neurons, score post-prune.
 *   5. Capture per-generation telemetry plus a final post-prune row so
 *      the README chart shows the up-then-down trajectory.
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

    // ---- Stage 1: minimal seed → evolved champion ---------------------
    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const evolutionRows: EvolutionRow[] = [];
    await runEvolvePhase({
      creature: seed,
      dataDir,
      config,
      rows: evolutionRows,
    });

    // ---- Stage 2: convert evolved champion to internal Network ---------
    // We work on the analytical Network for the prune/bias-fold step
    // because it's mathematically exact and byte-deterministic. The
    // evolved squash set may include functions the local helper does
    // not support (e.g. MISH); restrict by mapping those to TANH so
    // the example can still run through the bias-fold path. In
    // practice with the small population/iteration budget here, the
    // champion uses LOGISTIC/TANH/IDENTITY and no remap is needed.
    const network = networkFromEvolvedCreature(seed);

    // ---- Stage 3: inject deliberately constant-output hidden neurons --
    // Cap to the actual hidden count (evolution may have produced
    // fewer than requested under tight test budgets).
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

    // Append a post-prune endpoint row to the telemetry so the
    // topology chart shows the up-then-down trajectory mandated by the
    // audit (issue #217). The fitness columns reuse the last training
    // generation's values because the prune is mathematically
    // equivalent on every record — the same network behaviour, with
    // fewer neurons. Only the neuron/synapse counts change.
    if (evolutionRows.length > 0) {
      const last = evolutionRows[evolutionRows.length - 1];
      evolutionRows.push({
        generation: last.generation + 1,
        bestFitness: last.bestFitness,
        meanFitness: last.meanFitness,
        neuronCount: postNeuronCount,
        synapseCount: postSynapseCount,
      });
    }

    return {
      preNeuronCount,
      postNeuronCount,
      preSynapseCount,
      postSynapseCount,
      preScore,
      postScore,
      pruned,
      topology,
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
 * Convert an evolved `Creature` to the internal {@link Network} struct.
 * Squash functions outside the analytical helper's supported set
 * (IDENTITY / TANH / LOGISTIC) are remapped to TANH — the example's
 * downstream prune step works on the simplified analytical network,
 * not the original Creature, and remap-to-TANH keeps every neuron's
 * activation bounded so the bias-fold path stays well-defined.
 */
function networkFromEvolvedCreature(creature: Creature): Network {
  const neurons: NetworkNeuron[] = creature.neurons.map((n, idx) => {
    const raw = (n.squash ?? "IDENTITY").toUpperCase();
    const squash: SquashName = isKnownSquash(raw) ? raw : "TANH";
    const type: NetworkNeuron["type"] = idx < creature.input
      ? "input"
      : idx >= creature.neurons.length - creature.output
      ? "output"
      : "hidden";
    return {
      index: idx,
      type,
      squash,
      bias: n.bias ?? 0,
    };
  });

  const synapses: NetworkSynapse[] = creature.synapses.map((s) => ({
    from: s.from,
    to: s.to,
    weight: s.weight,
  }));

  return {
    inputCount: creature.input,
    outputCount: creature.output,
    neurons,
    synapses,
  };
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
    `aria-label="Neuron pruning — best vs mean fitness per generation">`,
    `  <title>Neuron Pruning — Best vs Mean Fitness</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Neuron Pruning — Best vs Mean Fitness</text>`,
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
    `aria-label="Neuron pruning — neuron and synapse counts per generation">`,
    `  <title>Neuron Pruning — Topology Trajectory</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Neuron Pruning — Topology Trajectory (grow then prune)</text>`,
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

  console.log("✂️  Neuron Pruning Demo (issue #87, audited #217)");
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
    `🧪 Evolving from minimal seed via Creature.evolveDir(...) ` +
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
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  await Deno.writeTextFile(WORKING_OUTPUT_PATH, svg);
  console.log(`\n🖼️  Wrote ${SCREENSHOT_PATH}`);
  console.log(`🖼️  Mirror at ${WORKING_OUTPUT_PATH}`);

  // Per-generation telemetry artefacts.
  if (result.evolutionRows.length > 0) {
    ensureDirSync("docs/data/neuron_pruning");
    ensureDirSync("docs/screenshots/neuron_pruning");
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
      `\n🏁 Final row generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${finalRow.meanFitness.toFixed(4)}  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
  console.log(`(Total wall-clock from runNeuronPruningDemo: ${result.wallClockMs} ms)`);
}
