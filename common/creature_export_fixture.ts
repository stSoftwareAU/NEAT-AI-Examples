/**
 * Real `CreatureExport` fixtures for tests (issue #722).
 *
 * `CreatureExport` is a plain value object, not a boundary, so tests that
 * persist, merge, or round-trip exports must use data a real `Creature` can
 * actually produce. A hand-rolled literal agrees with whatever the test
 * asserts and hides exactly the bugs worth catching — a field-name typo, a
 * missing required field, or drift in the exported shape.
 *
 * `makeCreatureExport` builds a genuine creature and exports it, so every
 * consumer test exercises the same shape the production path writes to disk.
 */

import { Creature, type CreatureExport } from "@stsoftware/neat-ai";

import { buildLargeCreature, DEFAULT_LARGE_CREATURE_OPTIONS } from "./large_creature.ts";

/** Options for {@link makeCreatureExport}. */
export interface CreatureExportFixtureOptions {
  /** Input neuron count. Must be a positive integer. */
  input: number;
  /** Output neuron count. Must be a positive integer. */
  output: number;
  /**
   * Hidden neuron count. Default 0 — a fresh seed built exactly as production
   * builds one (`new Creature(input, output)`), whose random weights differ on
   * every call. A positive count yields an evolved-style topology that is
   * deterministic for a given `seed`.
   */
  hidden?: number;
  /** PRNG seed for the hidden-neuron variant. Ignored when `hidden` is 0. */
  seed?: number;
}

/**
 * Builds a real, validated creature and returns its export.
 *
 * @param options Neuron counts and (for the hidden variant) the PRNG seed.
 * @returns The export of a genuine `Creature` — never a hand-rolled literal.
 * @throws If `input`, `output`, or `hidden` is not a suitable integer.
 */
export function makeCreatureExport(options: CreatureExportFixtureOptions): CreatureExport {
  const { input, output, hidden = 0, seed } = options;

  if (!Number.isInteger(input) || input < 1) {
    throw new Error(`input must be a positive integer, got ${input}`);
  }
  if (!Number.isInteger(output) || output < 1) {
    throw new Error(`output must be a positive integer, got ${output}`);
  }
  if (!Number.isInteger(hidden) || hidden < 0) {
    throw new Error(`hidden must be a non-negative integer, got ${hidden}`);
  }

  if (hidden === 0) {
    return new Creature(input, output).exportJSON();
  }

  return buildLargeCreature({
    inputs: input,
    outputs: output,
    hidden,
    seed: seed ?? DEFAULT_LARGE_CREATURE_OPTIONS.seed,
  }).exportJSON();
}
