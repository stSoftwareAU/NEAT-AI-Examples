/**
 * Synthetic Synapse Training Demo (issue #85).
 *
 * Demonstrates NEAT-AI's **synthetic-synapse training** technique: temporarily
 * **densifying** the inter-layer connectivity of an evolved sparse creature so
 * backprop has more degrees of freedom, then **pruning** the near-zero
 * synapses afterwards so the deployed creature stays lean.
 *
 * Textbook NEAT (Stanley & Miikkulainen 2002) struggles at scale because
 * evolutionary search is unlikely to discover every useful inter-layer edge in
 * a wide network — NEAT-AI ships several mitigations (GPU-accelerated
 * Discovery, memetic evolution, MCMC mutation acceptance, adaptive mutation,
 * advanced breeding) and synthetic-synapse training is one of them. Synthetic
 * synapse training side-steps that weakness by adding every missing edge between
 * adjacent layers as a zero-weight "synthetic" synapse, training all weights
 * (existing and synthetic) together, and finally dropping any synthetic
 * synapse whose magnitude has stayed close to zero — the gradient told us it
 * was not useful.
 *
 * The demo runs three phases on a sparse creature produced by
 * {@link buildLargeCreature}:
 *
 * 1. **sparse**     — train only the existing edges.
 * 2. **densified**  — add all missing inter-layer edges as zero-weight
 *                     synthetic synapses, then train every edge.
 * 3. **pruned**     — drop synthetic synapses whose magnitude stayed below a
 *                     threshold; the surviving creature is sparse again but
 *                     keeps the useful synthetic edges.
 *
 * A separate **control** run reuses the original sparse creature and trains
 * for the same total budget without densifying. The comparison is reported in
 * the console and rendered as `output/synthetic_synapse.svg`.
 *
 * Training is implemented as plain SGD with analytical backpropagation over
 * the feed-forward topology — no NEAT-AI internal training pipeline is
 * invoked. This keeps the demo self-contained, fast, and reproducible.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import { Creature } from "@stsoftware/neat-ai";

import { buildLargeCreature } from "../common/large_creature.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { renderSyntheticSynapseSVG } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-synapse";

/**
 * Path to the SVG snapshot the runner emits. Lives under `docs/screenshots/`
 * so the rendered topology + bar chart is committed to the repo and shows up
 * inline on GitHub the same way every other example screenshot does.
 */
export const SCREENSHOT_PATH = "docs/screenshots/synthetic_synapse.svg";

/**
 * Mirror copy of the SVG written under `WORKING_ROOT/output/` so the
 * canonical "output/" location requested in issue #85 is also populated.
 */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "synthetic_synapse.svg");

/** Names of the three phases captured by {@link runSyntheticSynapseDemo}. */
export type PhaseName = "sparse" | "densified" | "pruned";

/** Configuration for {@link runSyntheticSynapseDemo}. */
export interface SyntheticSynapseConfig {
  /** Number of input neurons in the student creature. */
  inputs: number;
  /** Number of hidden neurons in the student creature. */
  hidden: number;
  /** Number of output neurons in the student creature. */
  outputs: number;
  /** Density of the initial sparse student creature, in [0, 1]. */
  sparseDensity: number;
  /** Random seed for student creature, target weights, and dataset. */
  seed: number;
  /** Total records in the held-out dataset. */
  heldOutSize: number;
  /** Total records in the training dataset (mini-batch size each step). */
  trainingSize: number;
  /** SGD epochs run during the sparse phase. */
  sparseEpochs: number;
  /** SGD epochs run during the densified phase. */
  densifiedEpochs: number;
  /** Learning rate for SGD weight updates. */
  learningRate: number;
  /**
   * Magnitude threshold below which a synthetic synapse is pruned at the
   * end of the densified phase. Existing (non-synthetic) edges are never
   * pruned, even when their weight falls below this threshold.
   */
  pruneThreshold: number;
}

/**
 * Defaults chosen so the demo runs end-to-end in well under two minutes
 * on a developer machine while still illustrating the densify-then-prune
 * effect clearly.
 */
export const DEFAULT_SYNTHETIC_SYNAPSE_CONFIG: SyntheticSynapseConfig = {
  inputs: 4,
  hidden: 12,
  outputs: 2,
  sparseDensity: 0.18,
  seed: 850850850,
  heldOutSize: 64,
  trainingSize: 64,
  sparseEpochs: 80,
  densifiedEpochs: 80,
  learningRate: 0.05,
  pruneThreshold: 0.04,
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
  /** Synapse count at the end of this phase. */
  synapseCount: number;
  /** Held-out score (negative MSE — higher is better). */
  heldOutScore: number;
}

/** Combined result of running the synthetic-synapse demo. */
export interface SyntheticSynapseResult {
  /** Three phase records: sparse → densified → pruned. */
  phases: PhaseRecord[];
  /** Held-out score of the matched-budget control run (no densification). */
  controlScore: number;
  /** Synapse count of the control creature at the end of training. */
  controlSynapseCount: number;
  /** Best topology snapshot per phase, for the SVG renderer. */
  topologies: Record<PhaseName, TopologySnapshot>;
}

/** Minimal feed-forward network we manipulate during training. */
interface Network {
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
  /** True if added during densification, false if part of the original sparse creature. */
  synthetic: boolean;
}

/** Topology snapshot captured for rendering. */
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

/** Derivative of `activate(squash, z)` evaluated at `a = activate(squash, z)`. */
function activateDerivative(squash: SquashName, a: number): number {
  switch (squash) {
    case "IDENTITY":
      return 1;
    case "TANH":
      return 1 - a * a;
    case "LOGISTIC":
      return a * (1 - a);
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
  // Inputs pass through their squash (usually IDENTITY).
  for (let i = 0; i < network.inputCount; i++) {
    activations[i] = activate(network.neurons[i].squash, input[i]);
  }
  // Pre-aggregate weighted-sum contributions per target neuron.
  const sums = new Float32Array(network.neurons.length);
  for (let i = network.inputCount; i < network.neurons.length; i++) {
    sums[i] = network.neurons[i].bias;
  }
  for (const s of network.synapses) {
    sums[s.to] += s.weight * activations[s.from];
  }
  // Activate non-input neurons in order. Synapses are guaranteed `from < to`,
  // so processing in index order is a valid topological order.
  for (let i = network.inputCount; i < network.neurons.length; i++) {
    activations[i] = activate(network.neurons[i].squash, sums[i]);
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
 * One epoch of full-batch SGD with analytical backprop over the
 * feed-forward topology. Updates `network.synapses[*].weight` and
 * `network.neurons[*].bias` in place.
 */
function trainEpoch(
  network: Network,
  dataset: readonly DataPoint[],
  learningRate: number,
): void {
  if (dataset.length === 0) return;
  const N = network.neurons.length;
  const incomingByNeuron: number[][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < network.synapses.length; i++) {
    incomingByNeuron[network.synapses[i].to].push(i);
  }
  // Accumulators (mean over the batch).
  const weightGrad = new Float32Array(network.synapses.length);
  const biasGrad = new Float32Array(N);

  for (const point of dataset) {
    const acts = forward(network, point.inputs);
    const delta = new Float32Array(N);
    // Output-layer deltas: dL/dz = (yhat - target) * f'(a).
    const outStart = N - network.outputCount;
    for (let o = 0; o < network.outputCount; o++) {
      const i = outStart + o;
      const err = acts[i] - point.targets[o];
      delta[i] = err * activateDerivative(network.neurons[i].squash, acts[i]);
    }
    // Hidden-layer deltas in reverse topological order. Inputs do not need
    // deltas because their weights are read-only.
    for (let i = outStart - 1; i >= network.inputCount; i--) {
      let sum = 0;
      // For every synapse leaving neuron `i`, accumulate weight * delta(target).
      // We can find these by scanning the synapses array — fast enough for
      // the small network sizes used in this demo.
      for (let s = 0; s < network.synapses.length; s++) {
        const syn = network.synapses[s];
        if (syn.from === i) {
          sum += syn.weight * delta[syn.to];
        }
      }
      delta[i] = sum * activateDerivative(network.neurons[i].squash, acts[i]);
    }
    // Accumulate gradients.
    for (let s = 0; s < network.synapses.length; s++) {
      const syn = network.synapses[s];
      weightGrad[s] += delta[syn.to] * acts[syn.from];
    }
    for (let i = network.inputCount; i < N; i++) {
      biasGrad[i] += delta[i];
    }
  }

  const scale = learningRate / dataset.length;
  for (let s = 0; s < network.synapses.length; s++) {
    network.synapses[s].weight -= scale * weightGrad[s];
  }
  for (let i = network.inputCount; i < N; i++) {
    network.neurons[i].bias -= scale * biasGrad[i];
  }
}

/** Run `epochs` full-batch SGD epochs on the given network. */
export function trainNetwork(
  network: Network,
  dataset: readonly DataPoint[],
  epochs: number,
  learningRate: number,
): void {
  for (let e = 0; e < epochs; e++) {
    trainEpoch(network, dataset, learningRate);
  }
}

/**
 * Add every missing inter-layer edge as a zero-weight synthetic synapse.
 * "Adjacent layers" here are simply `inputs → hidden` and `hidden → output`,
 * which matches the layer assignment for the strictly feed-forward
 * topologies produced by {@link buildLargeCreature}.
 *
 * @returns The number of synthetic synapses added.
 */
export function densify(network: Network): number {
  const N = network.neurons.length;
  const outStart = N - network.outputCount;
  const existing = new Set(network.synapses.map((s) => synapseKey(s.from, s.to)));
  let added = 0;

  // Inputs → hidden.
  for (let i = 0; i < network.inputCount; i++) {
    for (let h = network.inputCount; h < outStart; h++) {
      const key = synapseKey(i, h);
      if (existing.has(key)) continue;
      network.synapses.push({ from: i, to: h, weight: 0, synthetic: true });
      existing.add(key);
      added++;
    }
  }
  // Hidden → output.
  for (let h = network.inputCount; h < outStart; h++) {
    for (let o = outStart; o < N; o++) {
      const key = synapseKey(h, o);
      if (existing.has(key)) continue;
      network.synapses.push({ from: h, to: o, weight: 0, synthetic: true });
      existing.add(key);
      added++;
    }
  }
  return added;
}

/**
 * Drop every synthetic synapse whose absolute weight is below
 * `threshold`. Original (non-synthetic) synapses are never pruned even if
 * their weight has drifted below the threshold — those edges are part of
 * the evolved topology and removing them would change the creature's
 * NEAT-side identity.
 *
 * @returns The number of synapses removed.
 */
export function prune(network: Network, threshold: number): number {
  if (threshold < 0) {
    throw new Error(`prune threshold must be >= 0, got ${threshold}`);
  }
  const before = network.synapses.length;
  network.synapses = network.synapses.filter((s) =>
    !s.synthetic || Math.abs(s.weight) >= threshold
  );
  return before - network.synapses.length;
}

/** Snapshot the topology for the SVG renderer. */
function snapshotTopology(network: Network): TopologySnapshot {
  return {
    inputCount: network.inputCount,
    outputCount: network.outputCount,
    hiddenCount: network.neurons.length - network.inputCount - network.outputCount,
    edges: network.synapses.map((s) => ({
      from: s.from,
      to: s.to,
      synthetic: s.synthetic,
    })),
  };
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
 * Build the "ground truth" network the dataset is generated from. We reuse
 * `buildLargeCreature` with the SAME shape but a fully connected density
 * (1.0) and a different seed, so the target uses every potential edge —
 * exactly the kind of dense connectivity that synthetic synapses are
 * designed to expose.
 */
export function buildTargetNetwork(config: SyntheticSynapseConfig): Network {
  const target = buildLargeCreature({
    inputs: config.inputs,
    hidden: config.hidden,
    outputs: config.outputs,
    density: 1.0,
    seed: config.seed ^ 0x7777_7777,
  });
  return networkFromCreature(target);
}

/** Build the sparse student creature this demo trains. */
export function buildStudentNetwork(config: SyntheticSynapseConfig): Network {
  const student = buildLargeCreature({
    inputs: config.inputs,
    hidden: config.hidden,
    outputs: config.outputs,
    density: config.sparseDensity,
    seed: config.seed,
  });
  return networkFromCreature(student);
}

/** Deep-clone a network (so each phase starts from the same baseline). */
function cloneNetwork(network: Network): Network {
  return {
    inputCount: network.inputCount,
    outputCount: network.outputCount,
    neurons: network.neurons.map((n) => ({ ...n })),
    synapses: network.synapses.map((s) => ({ ...s })),
    originalSynapseKeys: new Set(network.originalSynapseKeys),
  };
}

/**
 * Run the synthetic-synapse demo end-to-end: sparse → densified → pruned,
 * plus a matched-budget control with no densification.
 */
export function runSyntheticSynapseDemo(
  config: SyntheticSynapseConfig = DEFAULT_SYNTHETIC_SYNAPSE_CONFIG,
): SyntheticSynapseResult {
  if (config.sparseEpochs <= 0 || config.densifiedEpochs <= 0) {
    throw new Error("sparseEpochs and densifiedEpochs must be positive");
  }
  if (config.heldOutSize <= 0 || config.trainingSize <= 0) {
    throw new Error("heldOutSize and trainingSize must be positive");
  }

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

  // ---- Synthetic-synapse run ---------------------------------------------
  const synthetic = buildStudentNetwork(config);
  const phases: PhaseRecord[] = [];
  const topologies: Record<PhaseName, TopologySnapshot> = {} as Record<
    PhaseName,
    TopologySnapshot
  >;

  // Phase 1 — sparse.
  trainNetwork(synthetic, trainingSet, config.sparseEpochs, config.learningRate);
  phases.push({
    phase: "sparse",
    synapseCount: synthetic.synapses.length,
    heldOutScore: heldOutScore(synthetic, heldOutSet),
  });
  topologies.sparse = snapshotTopology(synthetic);

  // Phase 2 — densified. Add zero-weight synthetic synapses, then keep
  // training. The new edges start at zero so the network's behaviour is
  // unchanged at insertion time — only their gradients are non-zero.
  densify(synthetic);
  trainNetwork(synthetic, trainingSet, config.densifiedEpochs, config.learningRate);
  phases.push({
    phase: "densified",
    synapseCount: synthetic.synapses.length,
    heldOutScore: heldOutScore(synthetic, heldOutSet),
  });
  topologies.densified = snapshotTopology(synthetic);

  // Phase 3 — pruned. Drop synthetic synapses whose magnitude stayed
  // below threshold; original edges are kept regardless.
  prune(synthetic, config.pruneThreshold);
  phases.push({
    phase: "pruned",
    synapseCount: synthetic.synapses.length,
    heldOutScore: heldOutScore(synthetic, heldOutSet),
  });
  topologies.pruned = snapshotTopology(synthetic);

  // ---- Control run -------------------------------------------------------
  // Same student creature, same training budget, but no densification.
  const control = buildStudentNetwork(config);
  trainNetwork(
    control,
    trainingSet,
    config.sparseEpochs + config.densifiedEpochs,
    config.learningRate,
  );

  return {
    phases,
    controlScore: heldOutScore(control, heldOutSet),
    controlSynapseCount: control.synapses.length,
    topologies,
  };
}

/** Internal alias to keep the entry-point clean. */
const _cloneForTests = cloneNetwork;
export { _cloneForTests as cloneNetworkForTests };

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Synthetic Synapse Training Demo (issue #85)");
  console.log("");

  setupWorkingDirs(WORKING_ROOT);

  console.log("🧪 Running sparse → densified → pruned phases plus matched control...");
  const result = runSyntheticSynapseDemo(DEFAULT_SYNTHETIC_SYNAPSE_CONFIG);

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
  console.log(
    `   ${"control".padEnd(11)} ${String(result.controlSynapseCount).padStart(10)} ${
      result.controlScore.toPrecision(6).padStart(16)
    }`,
  );

  const prunedScore = result.phases[result.phases.length - 1].heldOutScore;
  const lift = prunedScore - result.controlScore;
  console.log(
    `\n   pruned − control = ${lift.toPrecision(4)} ${
      lift >= 0 ? "(no regression — synthetic synapses help)" : "(regression!)"
    }`,
  );

  const svg = renderSyntheticSynapseSVG({
    phases: result.phases,
    controlScore: result.controlScore,
    controlSynapseCount: result.controlSynapseCount,
    topologies: result.topologies,
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
