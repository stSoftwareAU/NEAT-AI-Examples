/**
 * Neuron Pruning Demo (issue #87).
 *
 * Demonstrates how NEAT-AI keeps large creatures lean by removing neurons
 * whose activations don't vary across the held-out dataset, and folding
 * their constant contribution into the downstream neurons' biases. The
 * folded creature is mathematically equivalent to the original on the
 * sampled dataset — every removed neuron only ever output one value, so
 * its contribution to a downstream neuron is the same constant on every
 * record.
 *
 * The pipeline:
 *
 * 1. Build a sparse creature with {@link buildLargeCreature}.
 * 2. Inject deliberately constant-output hidden neurons by zeroing their
 *    incoming weights and giving them a non-zero bias — so every record
 *    produces `activate(bias)`.
 * 3. Score the pre-prune creature on a held-out dataset.
 * 4. Detect constant neurons by measuring activation variance across the
 *    same dataset.
 * 5. Prune them: for every outgoing synapse `c → t` of a constant neuron
 *    with output `v`, add `weight * v` to `t.bias`, then drop neuron `c`
 *    and all its synapses.
 * 6. Score the post-prune creature on the same held-out dataset — the
 *    score must not regress because the network is mathematically
 *    equivalent on every sampled record.
 *
 * The demo prints a per-neuron pruning report (which constant neurons
 * were removed, and which downstream neurons absorbed their bias-fold
 * contribution) and renders `output/neuron_pruning.svg` showing the
 * topology with pruned neurons greyed-out and bias-fold arrows drawn to
 * the surviving downstream neighbours.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import { Creature } from "@stsoftware/neat-ai";

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

/** Configuration for {@link runNeuronPruningDemo}. */
export interface NeuronPruningConfig {
  /** Number of input neurons in the creature under demo. */
  inputs: number;
  /** Number of hidden neurons in the creature under demo. */
  hidden: number;
  /** Number of output neurons in the creature under demo. */
  outputs: number;
  /** Connection density of the underlying sparse creature, in [0, 1]. */
  density: number;
  /**
   * Number of hidden neurons to deliberately convert into constant-output
   * neurons. Must satisfy `0 < constantNeurons <= hidden`.
   */
  constantNeurons: number;
  /** Random seed for the creature, dataset, and neuron selection. */
  seed: number;
  /** Total records in the held-out dataset. */
  heldOutSize: number;
  /**
   * Variance threshold below which a neuron's activation is considered
   * constant. Defaults to `1e-12` — anything smaller than this is
   * floating-point noise.
   */
  varianceThreshold: number;
}

/**
 * Defaults chosen so the demo runs end-to-end in a fraction of a second
 * on a developer machine while still illustrating constant-neuron
 * removal clearly.
 */
export const DEFAULT_NEURON_PRUNING_CONFIG: NeuronPruningConfig = {
  inputs: 4,
  hidden: 16,
  outputs: 2,
  density: 0.3,
  constantNeurons: 5,
  seed: 870870870,
  heldOutSize: 64,
  varianceThreshold: 1e-12,
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
  /** Neuron count of the creature before pruning. */
  preNeuronCount: number;
  /** Neuron count of the creature after pruning. */
  postNeuronCount: number;
  /** Held-out score (negative MSE — higher is better) before pruning. */
  preScore: number;
  /** Held-out score (negative MSE — higher is better) after pruning. */
  postScore: number;
  /** Per-pruned-neuron audit entries. */
  pruned: PrunedNeuronRecord[];
  /** Topology snapshot used by the SVG renderer. */
  topology: TopologySnapshot;
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
 * Build the demo network: a sparse creature from `buildLargeCreature`
 * with `constantNeurons` of its hidden neurons converted to deliberately
 * constant-output neurons.
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
 * Run the neuron-pruning demo end-to-end: build the creature, score
 * pre-prune, detect and remove constant neurons (folding biases into
 * downstream neurons), score post-prune, and capture an audit trail
 * suitable for the SVG renderer.
 */
export function runNeuronPruningDemo(
  config: NeuronPruningConfig = DEFAULT_NEURON_PRUNING_CONFIG,
): NeuronPruningResult {
  if (config.heldOutSize <= 0) {
    throw new Error("heldOutSize must be positive");
  }
  if (config.constantNeurons <= 0) {
    throw new Error("constantNeurons must be positive");
  }
  if (!(config.density >= 0 && config.density <= 1)) {
    throw new Error(`density must be in [0, 1], got ${config.density}`);
  }

  // The "target" the dataset is generated from is the pristine, sparse
  // creature without any injected constant neurons. That way the
  // injected neurons are objectively dead weight on the held-out task.
  const targetCreature = buildLargeCreature({
    inputs: config.inputs,
    hidden: config.hidden,
    outputs: config.outputs,
    density: config.density,
    seed: config.seed,
  });
  const target = networkFromCreature(targetCreature);
  const heldOut = generateDataset(target, config.heldOutSize, config.seed ^ 0x1234_abcd);

  // The "demo" creature is the same sparse creature with some hidden
  // neurons converted to constant-output by zeroing their incoming
  // synapses. We score, snapshot, then prune.
  const network = buildDemoNetwork(config);

  const preNetwork = cloneNetwork(network);
  const preScore = heldOutScore(preNetwork, heldOut);
  const preNeuronCount = preNetwork.neurons.length;

  const constants = detectConstantNeurons(network, heldOut, config.varianceThreshold);
  const pruned = pruneConstantNeurons(network, constants);
  const postScore = heldOutScore(network, heldOut);
  const postNeuronCount = network.neurons.length;

  const topology = snapshotTopology(preNetwork, pruned);

  return {
    preNeuronCount,
    postNeuronCount,
    preScore,
    postScore,
    pruned,
    topology,
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("✂️  Neuron Pruning Demo (issue #87)");
  console.log("");

  setupWorkingDirs(WORKING_ROOT);

  console.log("🧪 Building creature, detecting constant neurons, pruning with bias-fold...");
  const result = runNeuronPruningDemo(DEFAULT_NEURON_PRUNING_CONFIG);

  console.log("");
  console.log(
    `   pre-prune  neurons=${result.preNeuronCount}  score=${result.preScore.toPrecision(6)}`,
  );
  console.log(
    `   post-prune neurons=${result.postNeuronCount}  score=${result.postScore.toPrecision(6)}`,
  );
  console.log(
    `   delta      neurons=${result.preNeuronCount - result.postNeuronCount}  ` +
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

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
