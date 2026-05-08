/**
 * Unit tests for the shared large-creature builder.
 *
 * These are "what" tests — they verify the builder produces creatures with
 * the requested shape, that the same seed reproduces the same creature, and
 * that the result validates and activates without producing non-finite
 * outputs. No timing assertions are made (timing belongs in benchmarks).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";

import { buildLargeCreature, DEFAULT_LARGE_CREATURE_OPTIONS } from "./large_creature.ts";

Deno.test("buildLargeCreature - same seed produces identical creatures", () => {
  const a = buildLargeCreature({ seed: 42, inputs: 4, hidden: 16, outputs: 2 });
  const b = buildLargeCreature({ seed: 42, inputs: 4, hidden: 16, outputs: 2 });
  assertEquals(
    JSON.stringify(a.exportJSON()),
    JSON.stringify(b.exportJSON()),
    "creatures built with the same seed and options must be byte-identical",
  );
});

Deno.test("buildLargeCreature - different seeds produce different creatures", () => {
  const a = buildLargeCreature({ seed: 1, inputs: 4, hidden: 16, outputs: 2 });
  const b = buildLargeCreature({ seed: 2, inputs: 4, hidden: 16, outputs: 2 });
  const aJson = JSON.stringify(a.exportJSON());
  const bJson = JSON.stringify(b.exportJSON());
  assert(aJson !== bJson, "different seeds should produce different creatures");
});

Deno.test("buildLargeCreature - neuron counts match requested options", () => {
  const inputs = 5;
  const hidden = 32;
  const outputs = 3;
  const c = buildLargeCreature({ seed: 7, inputs, hidden, outputs });
  assertEquals(c.input, inputs, "input count");
  assertEquals(c.output, outputs, "output count");
  assertEquals(c.neurons.length, inputs + hidden + outputs, "total neuron count");
});

Deno.test("buildLargeCreature - synapse count grows with density", () => {
  const opts = { seed: 11, inputs: 4, hidden: 16, outputs: 2 } as const;
  const sparse = buildLargeCreature({ ...opts, density: 0.1 });
  const dense = buildLargeCreature({ ...opts, density: 0.8 });
  assert(
    dense.synapses.length > sparse.synapses.length,
    `expected higher density to add synapses (got ${sparse.synapses.length} vs ${dense.synapses.length})`,
  );
});

Deno.test("buildLargeCreature - synapse count matches the density target", () => {
  const inputs = 4;
  const hidden = 16;
  const outputs = 2;
  const density = 0.5;
  const c = buildLargeCreature({ seed: 23, inputs, hidden, outputs, density });

  // Count of forward-only candidate edges from any neuron i to a higher-index
  // hidden or output neuron.
  let candidates = 0;
  const total = inputs + hidden + outputs;
  for (let i = 0; i < inputs + hidden; i++) {
    for (let j = Math.max(i + 1, inputs); j < total; j++) {
      candidates++;
    }
  }
  const expected = Math.floor(candidates * density);
  // Mandatory edges (one incoming per hidden, one incoming per output, one
  // outgoing per hidden) may push the count above the bare density target,
  // so the actual synapse count must be at least that target.
  assert(
    c.synapses.length >= expected,
    `expected at least ${expected} synapses (density target), got ${c.synapses.length}`,
  );
});

Deno.test("buildLargeCreature - produces finite output for a sample input", () => {
  const inputs = 6;
  const c = buildLargeCreature({ seed: 99, inputs, hidden: 32, outputs: 3 });
  const sample = new Float32Array(inputs);
  for (let i = 0; i < inputs; i++) sample[i] = (i + 1) * 0.1;

  const out = c.activate(sample);
  assertEquals(out.length, 3, "output array should match output neuron count");
  for (const v of out) {
    assert(Number.isFinite(v), `output value must be finite, got ${v}`);
  }
});

Deno.test("buildLargeCreature - default options produce a large, valid creature", () => {
  const c = buildLargeCreature();
  const { inputs, hidden, outputs } = DEFAULT_LARGE_CREATURE_OPTIONS;
  assertEquals(
    c.neurons.length,
    inputs + hidden + outputs,
    "default neuron count",
  );
  // Defaults aim for ~10,000 synapses (parent issue #75 calls for size-adaptive demos).
  assert(
    c.synapses.length >= 8_000,
    `expected default creature to have ~10k synapses, got ${c.synapses.length}`,
  );
  // Validation is invoked inside the builder; calling it again must remain a no-op.
  c.validate();
});

Deno.test("buildLargeCreature - rejects invalid options", () => {
  assertThrows(() => buildLargeCreature({ inputs: 0 }), Error);
  assertThrows(() => buildLargeCreature({ hidden: 0 }), Error);
  assertThrows(() => buildLargeCreature({ outputs: 0 }), Error);
  assertThrows(() => buildLargeCreature({ density: -0.1 }), Error);
  assertThrows(() => buildLargeCreature({ density: 1.5 }), Error);
});
