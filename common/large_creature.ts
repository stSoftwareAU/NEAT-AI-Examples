/**
 * Shared builder for large, deterministic NEAT creatures.
 *
 * Several planned demos (discovery-at-scale, synthetic synapse pruning,
 * adaptive mutation, neuron pruning — see issue #75) need a consistent way
 * to spawn realistically-sized creatures with hundreds of hidden neurons and
 * thousands of synapses. `buildLargeCreature(opts)` returns such a creature
 * deterministically — the same seed and options produce a byte-identical
 * `Creature` across machines, because the construction is driven by the
 * shared seeded PRNG in `common/deterministic_random.ts`.
 *
 * Defaults (8 inputs, 256 hidden, 4 outputs, 30% connection density) yield
 * roughly 10,000 synapses — large enough to exercise size-adaptive
 * behaviours but small enough to run on developer hardware.
 *
 * The connection topology is strictly feed-forward: every synapse goes from
 * a lower-indexed neuron (inputs first, then hidden, then outputs) to a
 * higher-indexed one. This guarantees the network is acyclic and that
 * `Creature.validate()` succeeds without further fix-up.
 */

import { Creature, CreatureUtil } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "./deterministic_random.ts";
import {
  asCreatureExport,
  type LegacyCreatureJSON,
  type LegacyNeuron,
  type LegacySynapse,
} from "./legacy_types.ts";

/** Configuration for `buildLargeCreature`. All fields are optional. */
export interface LargeCreatureOptions {
  /** Number of input neurons. Default 8. */
  inputs?: number;
  /** Number of hidden neurons. Default 256. */
  hidden?: number;
  /** Number of output neurons. Default 4. */
  outputs?: number;
  /**
   * Fraction of all possible feed-forward edges to populate, in [0, 1].
   * Default 0.3 — yields roughly 10,000 synapses for the default neuron
   * counts. Mandatory wiring (one incoming per hidden/output, one outgoing
   * per hidden) is added regardless of density to keep the graph valid.
   */
  density?: number;
  /** Seed for the deterministic PRNG. Default 1337. */
  seed?: number;
  /** Activation function for hidden neurons. Default "TANH". */
  hiddenSquash?: string;
  /** Activation function for output neurons. Default "LOGISTIC". */
  outputSquash?: string;
}

/** Concrete defaults applied when an option is omitted. */
export const DEFAULT_LARGE_CREATURE_OPTIONS = {
  inputs: 8,
  hidden: 256,
  outputs: 4,
  density: 0.3,
  seed: 1337,
  hiddenSquash: "TANH",
  outputSquash: "LOGISTIC",
} as const satisfies Required<LargeCreatureOptions>;

/**
 * Builds a deterministic large creature suitable for size-adaptive demos.
 *
 * @param opts Optional overrides for neuron counts, density, seed, and
 *             activation functions. Any omitted field falls back to
 *             {@link DEFAULT_LARGE_CREATURE_OPTIONS}.
 * @returns A validated `Creature` whose serialised form is identical for
 *          identical inputs.
 * @throws If neuron counts are not all positive, or `density` is outside [0, 1].
 */
export function buildLargeCreature(opts: LargeCreatureOptions = {}): Creature {
  const o = { ...DEFAULT_LARGE_CREATURE_OPTIONS, ...opts };

  if (!Number.isInteger(o.inputs) || o.inputs < 1) {
    throw new Error(`inputs must be a positive integer, got ${o.inputs}`);
  }
  if (!Number.isInteger(o.hidden) || o.hidden < 1) {
    throw new Error(`hidden must be a positive integer, got ${o.hidden}`);
  }
  if (!Number.isInteger(o.outputs) || o.outputs < 1) {
    throw new Error(`outputs must be a positive integer, got ${o.outputs}`);
  }
  if (!(o.density >= 0 && o.density <= 1)) {
    throw new Error(`density must be in [0, 1], got ${o.density}`);
  }

  const rng = createDeterministicRandom(o.seed);
  const totalNeurons = o.inputs + o.hidden + o.outputs;
  const neurons: LegacyNeuron[] = [];

  for (let i = 0; i < o.inputs; i++) {
    neurons.push({
      type: "input",
      squash: "IDENTITY",
      index: i,
      uuid: `input-${i}`,
    });
  }
  for (let i = 0; i < o.hidden; i++) {
    neurons.push({
      type: "hidden",
      squash: o.hiddenSquash,
      index: o.inputs + i,
      bias: rng() * 0.4 - 0.2,
      uuid: `hidden-${i}`,
    });
  }
  for (let i = 0; i < o.outputs; i++) {
    neurons.push({
      type: "output",
      squash: o.outputSquash,
      index: o.inputs + o.hidden + i,
      bias: rng() * 0.4 - 0.2,
      uuid: `output-${i}`,
    });
  }

  const synapses: LegacySynapse[] = [];
  const seen = new Set<string>();
  const addSynapse = (from: number, to: number): void => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    synapses.push({ from, to, weight: rng() * 2 - 1 });
  };

  // Mandatory: every hidden neuron must have at least one incoming synapse
  // from a lower-indexed neuron (input or earlier hidden).
  for (let h = 0; h < o.hidden; h++) {
    const to = o.inputs + h;
    const from = Math.floor(rng() * to);
    addSynapse(from, to);
  }
  // Mandatory: every hidden neuron must have at least one outgoing synapse
  // to a higher-indexed neuron (later hidden or output).
  for (let h = 0; h < o.hidden; h++) {
    const from = o.inputs + h;
    const remaining = totalNeurons - from - 1;
    const to = from + 1 + Math.floor(rng() * remaining);
    addSynapse(from, to);
  }
  // Mandatory: every output neuron must have at least one incoming synapse
  // from a hidden neuron, so outputs are not stranded from the inputs.
  for (let p = 0; p < o.outputs; p++) {
    const to = o.inputs + o.hidden + p;
    const from = o.inputs + Math.floor(rng() * o.hidden);
    addSynapse(from, to);
  }

  // Build the list of all candidate feed-forward edges (i -> j with i < j,
  // j must be a hidden or output neuron).
  const candidates: Array<[number, number]> = [];
  for (let i = 0; i < o.inputs + o.hidden; i++) {
    const jStart = Math.max(i + 1, o.inputs);
    for (let j = jStart; j < totalNeurons; j++) {
      candidates.push([i, j]);
    }
  }

  const target = Math.floor(candidates.length * o.density);

  // Fisher-Yates shuffle of candidate indices using the same PRNG so the
  // selection order is deterministic.
  const order = candidates.map((_, k) => k);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }

  for (const idx of order) {
    if (synapses.length >= target) break;
    const [from, to] = candidates[idx];
    addSynapse(from, to);
  }

  const json: LegacyCreatureJSON = {
    neurons,
    synapses,
    input: o.inputs,
    output: o.outputs,
  };

  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
  CreatureUtil.makeUUID(creature);
  return creature;
}
