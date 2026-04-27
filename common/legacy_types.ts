/**
 * Local "legacy" creature JSON types matching the index-based shape
 * accepted by `Creature.fromJSON`.
 *
 * `Creature.fromJSON` accepts either `CreatureExport` (UUID/ID-based,
 * the public serialised form) or `CreatureInternal` (index-based, used
 * during runtime construction). The `CreatureInternal` interface is not
 * exported from `@stsoftware/neat-ai`, so these example files declare an
 * equivalent local type to construct creature definitions with literal
 * `from` / `to` indices and `index` / `type: "input"` neuron fields.
 *
 * The runtime accepts these objects unchanged — see the
 * `CreatureInternal | CreatureExport` parameter on `Creature.fromJSON`.
 */

import type { CreatureExport, NeuronExport, SynapseExport } from "@stsoftware/neat-ai";

/** Legacy synapse shape: index-based `from` / `to` plus weight. */
export interface LegacySynapse {
  from: number;
  to: number;
  weight: number;
  type?: "positive" | "negative" | "condition";
}

/** Legacy neuron shape: includes `index` and the broader "input" type. */
export interface LegacyNeuron {
  type: "input" | "hidden" | "output" | "constant";
  uuid: string;
  index: number;
  bias?: number;
  squash?: string;
}

/** Legacy creature JSON: index-based, accepted by `Creature.fromJSON`. */
export interface LegacyCreatureJSON {
  neurons: LegacyNeuron[];
  synapses: LegacySynapse[];
  input: number;
  output: number;
}

/**
 * Type assertion helper: `Creature.fromJSON` accepts `CreatureInternal |
 * CreatureExport`, so the legacy shape is valid at runtime even though
 * its types are not assignable to `CreatureExport`. Cast through `unknown`
 * at the boundary where the library is invoked.
 */
export function asCreatureExport(json: LegacyCreatureJSON): CreatureExport {
  return json as unknown as CreatureExport;
}

/** Re-export library types for convenience in example files. */
export type { CreatureExport, NeuronExport, SynapseExport };
