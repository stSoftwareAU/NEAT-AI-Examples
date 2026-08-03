/**
 * Behavioural assertions for the champion returned by an `evolveDir`-backed
 * example helper (issue #725).
 *
 * Tests used to assert `result.champion === seed` — object identity with the
 * creature the caller passed in. That pins *how* the champion was produced
 * (NEAT-AI currently mutates the caller's creature in place), not *what* it
 * is, so a behaviour-preserving upstream change to return a fresh champion
 * would break every such test for no real regression. See the Testing
 * Philosophy in [AGENTS.md](../AGENTS.md).
 *
 * This helper asserts the observable contract instead: the champion is a
 * valid creature of the expected arity that activates to finite numbers.
 */

import { assert, assertEquals } from "@std/assert";
import type { Creature } from "@stsoftware/neat-ai";

/** Expected arity of a champion. */
export interface ChampionArity {
  /** Expected input neuron count. */
  input: number;
  /** Expected output neuron count. */
  output: number;
}

/**
 * Asserts the observable contract of an evolved champion.
 *
 * The champion must validate, keep the seed's input/output arity, and produce
 * a finite output vector of the right length for a sample input.
 *
 * @param champion The creature returned as the champion of an evolution run.
 * @param expected The arity the champion must expose.
 * @throws If the creature fails validation, has the wrong arity, or activates
 *   to a non-finite value.
 */
export function assertChampionContract(champion: Creature, expected: ChampionArity): void {
  champion.validate();

  assertEquals(champion.input, expected.input, "champion must keep the seed's input count");
  assertEquals(champion.output, expected.output, "champion must keep the seed's output count");

  const sample = new Float32Array(expected.input);
  for (let i = 0; i < expected.input; i++) {
    sample[i] = ((i % 5) - 2) * 0.25;
  }

  champion.clearState();
  const activated = champion.activate(sample);
  assertEquals(
    activated.length,
    expected.output,
    "champion activation must return one value per output neuron",
  );
  for (const value of activated) {
    assert(Number.isFinite(value), `champion activation must be finite, got ${value}`);
  }
}
