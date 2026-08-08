/**
 * Shared feed-forward evaluation core for exported `Creature`s (issue #775).
 *
 * `neuron_pruning` and `synthetic_synapse` both convert an evolved
 * `Creature` into a plain layered network and run a deterministic
 * forward pass over it, then score that network against a held-out
 * dataset. The two copies had drifted apart on the activation-ordering
 * part of that rule, so the single correct version now lives here and
 * both examples import it.
 *
 * The rule, stated once:
 *
 * 1. Input neurons pass their raw input through their own squash.
 * 2. Every non-input neuron sums `bias + Σ weight × upstream activation`
 *    and squashes the result.
 * 3. Neurons are activated one at a time in index order, each finalising
 *    its sum before any downstream neuron reads it. Synapses are always
 *    `from < to` (strictly feed-forward), so index order is a valid
 *    topological order. This ordering is **essential** for hidden→hidden
 *    cascades — pre-aggregating every synapse in a single pass would read
 *    upstream hidden activations before they were computed.
 */
import type { Creature } from "@stsoftware/neat-ai";

/** Squash functions the analytical helpers can evaluate. */
export type SquashName = "IDENTITY" | "TANH" | "LOGISTIC";

const KNOWN_SQUASHES: readonly SquashName[] = ["IDENTITY", "TANH", "LOGISTIC"];

/** Type guard for the supported squash names. */
function isKnownSquash(name: string): name is SquashName {
  return (KNOWN_SQUASHES as readonly string[]).includes(name);
}

/** A single neuron in the analytical network representation. */
export interface NetworkNeuron {
  index: number;
  type: "input" | "hidden" | "output";
  squash: SquashName;
  bias: number;
}

/** A single synapse in the analytical network representation. */
export interface NetworkSynapse {
  from: number;
  to: number;
  weight: number;
}

/**
 * Minimal feed-forward network. Callers may extend the neuron and
 * synapse records with their own fields (e.g. the synthetic-synapse
 * demo's `synthetic` flag) — the helpers here only read the fields
 * declared below.
 */
export interface FeedForwardNetwork {
  inputCount: number;
  outputCount: number;
  /** All neurons sorted by index (inputs, then hidden, then outputs). */
  neurons: readonly NetworkNeuron[];
  /** All synapses; `from < to` always (strictly feed-forward). */
  synapses: readonly NetworkSynapse[];
}

/** One scored record: an input vector and the expected outputs. */
export interface ScoredRecord {
  inputs: ArrayLike<number>;
  targets: ArrayLike<number>;
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

/** Options for {@link networkFromCreature}. */
export interface NetworkFromCreatureOptions {
  /** Demo name quoted in the unsupported-squash error message. */
  label: string;
  /**
   * How to treat a squash outside IDENTITY / TANH / LOGISTIC.
   * `"throw"` (the default) rejects the creature; `"tanh"` remaps it,
   * which keeps every activation bounded for callers that only need a
   * well-defined analytical stand-in for an evolved champion.
   */
  onUnknownSquash?: "throw" | "tanh";
}

/** Construct a {@link FeedForwardNetwork} from a `Creature`. */
export function networkFromCreature(
  creature: Creature,
  options: NetworkFromCreatureOptions,
): FeedForwardNetwork {
  const onUnknownSquash = options.onUnknownSquash ?? "throw";
  const neurons: NetworkNeuron[] = creature.neurons.map((n, idx) => {
    const raw = (n.squash ?? "IDENTITY").toUpperCase();
    let squash: SquashName;
    if (isKnownSquash(raw)) {
      squash = raw;
    } else if (onUnknownSquash === "tanh") {
      squash = "TANH";
    } else {
      throw new Error(`Unsupported squash function for ${options.label}: ${raw}`);
    }
    const type: NetworkNeuron["type"] = idx < creature.input
      ? "input"
      : idx >= creature.neurons.length - creature.output
      ? "output"
      : "hidden";
    return { index: idx, type, squash, bias: n.bias ?? 0 };
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
export function forward(
  network: FeedForwardNetwork,
  input: ArrayLike<number>,
): Float32Array {
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

/** Mean-squared error between the network's outputs and each record's targets. */
function mseAgainst(
  network: FeedForwardNetwork,
  dataset: readonly ScoredRecord[],
): number {
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
export function heldOutScore(
  network: FeedForwardNetwork,
  dataset: readonly ScoredRecord[],
): number {
  return -mseAgainst(network, dataset);
}
