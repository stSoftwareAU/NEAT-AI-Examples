/**
 * Unit tests for the synthetic-synapse training demo.
 *
 * Tests are "what" tests: they call real functions with deterministic inputs
 * and assert on the returned values, the resulting topology, and the SVG
 * payload. No source-level grepping or implementation snooping.
 */
import {
  assert,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertLess,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import {
  buildStudentNetwork,
  buildTargetNetwork,
  cloneNetworkForTests,
  DEFAULT_SYNTHETIC_SYNAPSE_CONFIG,
  densify,
  forward,
  generateDataset,
  heldOutScore,
  networkFromCreature,
  prune,
  runSyntheticSynapseDemo,
  type SyntheticSynapseConfig,
  trainNetwork,
} from "./synthetic_synapse_example.ts";
import { renderSyntheticSynapseSVG } from "./svg.ts";
import { buildLargeCreature } from "../common/large_creature.ts";

/** Small config used throughout the test suite — keeps each test fast. */
const SMALL_CONFIG: SyntheticSynapseConfig = {
  inputs: 3,
  hidden: 8,
  outputs: 2,
  sparseDensity: 0.2,
  seed: 424242,
  heldOutSize: 24,
  trainingSize: 24,
  sparseEpochs: 30,
  densifiedEpochs: 30,
  learningRate: 0.05,
  pruneThreshold: 0.04,
};

Deno.test("networkFromCreature - mirrors the Creature topology", () => {
  const creature = buildLargeCreature({
    inputs: 3,
    hidden: 6,
    outputs: 2,
    density: 0.25,
    seed: 7,
  });
  const network = networkFromCreature(creature);
  assertEquals(network.inputCount, 3);
  assertEquals(network.outputCount, 2);
  assertEquals(network.neurons.length, creature.neurons.length);
  assertEquals(network.synapses.length, creature.synapses.length);
  // None of the synapses are flagged as synthetic before densification.
  assert(network.synapses.every((s) => !s.synthetic));
  // Original-key set captures every starting synapse.
  assertEquals(network.originalSynapseKeys.size, network.synapses.length);
});

Deno.test("forward - returns finite outputs of the correct shape", () => {
  const network = buildStudentNetwork(SMALL_CONFIG);
  const inputs = new Float32Array([0.1, -0.4, 0.7]);
  const acts = forward(network, inputs);
  assertEquals(acts.length, network.neurons.length);
  for (let i = 0; i < acts.length; i++) {
    assert(Number.isFinite(acts[i]), `activation ${i} is not finite: ${acts[i]}`);
  }
});

Deno.test("forward - rejects mismatched input length", () => {
  const network = buildStudentNetwork(SMALL_CONFIG);
  assertThrows(
    () => forward(network, new Float32Array([0.1, 0.2])),
    Error,
    "expected",
  );
});

Deno.test("generateDataset - is deterministic for a given seed", () => {
  const target = buildTargetNetwork(SMALL_CONFIG);
  const a = generateDataset(target, 8, 99);
  const b = generateDataset(target, 8, 99);
  for (let i = 0; i < a.length; i++) {
    assertEquals(Array.from(a[i].inputs), Array.from(b[i].inputs));
    assertEquals(Array.from(a[i].targets), Array.from(b[i].targets));
  }
});

Deno.test("generateDataset - rejects non-positive size", () => {
  const target = buildTargetNetwork(SMALL_CONFIG);
  assertThrows(() => generateDataset(target, 0, 1), Error, "size must be positive");
});

Deno.test("trainNetwork - improves held-out score on the synthetic task", () => {
  const target = buildTargetNetwork(SMALL_CONFIG);
  const training = generateDataset(target, 32, 1);
  const held = generateDataset(target, 32, 2);
  const network = buildStudentNetwork(SMALL_CONFIG);
  const before = heldOutScore(network, held);
  trainNetwork(network, training, 40, 0.05);
  const after = heldOutScore(network, held);
  assertGreater(after, before, "training should improve held-out score");
});

Deno.test("densify - adds zero-weight synthetic synapses without changing forward output", () => {
  const network = buildStudentNetwork(SMALL_CONFIG);
  const inputs = new Float32Array([0.3, -0.2, 0.5]);
  const before = Array.from(forward(network, inputs));
  const beforeCount = network.synapses.length;
  const added = densify(network);
  assertGreater(added, 0, "densify should add at least one synthetic synapse");
  assertEquals(network.synapses.length, beforeCount + added);
  // Synthetic synapses start at zero weight, so the forward output is unchanged.
  const after = Array.from(forward(network, inputs));
  for (let i = 0; i < before.length; i++) {
    assertEquals(after[i], before[i], `activation ${i} changed unexpectedly`);
  }
});

Deno.test("densify - is idempotent when called twice in a row", () => {
  const network = buildStudentNetwork(SMALL_CONFIG);
  densify(network);
  const after1 = network.synapses.length;
  const added2 = densify(network);
  assertEquals(added2, 0);
  assertEquals(network.synapses.length, after1);
});

Deno.test("prune - removes synthetic synapses below the threshold but keeps originals", () => {
  const network = buildStudentNetwork(SMALL_CONFIG);
  const originalCount = network.synapses.length;
  const synthAdded = densify(network);
  const denseCount = network.synapses.length;
  // All synthetic synapses start at zero, so a positive threshold removes them all.
  const removed = prune(network, 0.001);
  assertEquals(removed, synthAdded);
  // Every remaining synapse must be original — nothing synthetic survives a 0.001 threshold on zero weights.
  assert(network.synapses.every((s) => !s.synthetic));
  assertEquals(network.synapses.length, originalCount);
  assertEquals(denseCount - removed, originalCount);
});

Deno.test("prune - rejects negative threshold", () => {
  const network = buildStudentNetwork(SMALL_CONFIG);
  assertThrows(() => prune(network, -1), Error, "threshold must be >= 0");
});

Deno.test("runSyntheticSynapseDemo - produces three phases with monotonic count change", () => {
  const result = runSyntheticSynapseDemo(SMALL_CONFIG);
  assertEquals(result.phases.length, 3);
  const [sparse, densified, pruned] = result.phases;
  assertEquals(sparse.phase, "sparse");
  assertEquals(densified.phase, "densified");
  assertEquals(pruned.phase, "pruned");
  // Densification adds synapses; pruning removes some.
  assertGreater(densified.synapseCount, sparse.synapseCount);
  assertLess(pruned.synapseCount, densified.synapseCount);
  // Pruned creature still has at least the original synapses.
  assertGreaterOrEqual(pruned.synapseCount, sparse.synapseCount);
  // Held-out scores are finite.
  for (const p of result.phases) {
    assert(Number.isFinite(p.heldOutScore));
  }
  assert(Number.isFinite(result.controlScore));
});

Deno.test("runSyntheticSynapseDemo - pruned score does not regress versus control", () => {
  const result = runSyntheticSynapseDemo(SMALL_CONFIG);
  const pruned = result.phases[result.phases.length - 1];
  // Allow a tiny floating-point tolerance: the synthetic-synapse path
  // must do at least as well as the matched-budget control.
  const tolerance = 1e-3;
  assertGreaterOrEqual(
    pruned.heldOutScore + tolerance,
    result.controlScore,
    `pruned score ${pruned.heldOutScore} regressed versus control ${result.controlScore}`,
  );
});

Deno.test("runSyntheticSynapseDemo - is deterministic for the same config", () => {
  const a = runSyntheticSynapseDemo(SMALL_CONFIG);
  const b = runSyntheticSynapseDemo(SMALL_CONFIG);
  for (let i = 0; i < a.phases.length; i++) {
    assertEquals(a.phases[i].synapseCount, b.phases[i].synapseCount);
    assertEquals(a.phases[i].heldOutScore, b.phases[i].heldOutScore);
  }
  assertEquals(a.controlScore, b.controlScore);
  assertEquals(a.controlSynapseCount, b.controlSynapseCount);
});

Deno.test("runSyntheticSynapseDemo - rejects bad epoch counts", () => {
  assertThrows(
    () => runSyntheticSynapseDemo({ ...SMALL_CONFIG, sparseEpochs: 0 }),
    Error,
  );
  assertThrows(
    () => runSyntheticSynapseDemo({ ...SMALL_CONFIG, densifiedEpochs: -1 }),
    Error,
  );
});

Deno.test("renderSyntheticSynapseSVG - emits a well-formed SVG with topology and chart", () => {
  const result = runSyntheticSynapseDemo(SMALL_CONFIG);
  const svg = renderSyntheticSynapseSVG({
    phases: result.phases,
    controlScore: result.controlScore,
    controlSynapseCount: result.controlSynapseCount,
    topologies: result.topologies,
  });
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  // All three phase labels are present.
  assertStringIncludes(svg, "1. sparse");
  assertStringIncludes(svg, "2. densified");
  assertStringIncludes(svg, "3. pruned");
  // The bar chart and topology classes are wired up.
  assertStringIncludes(svg, "bar-synapse");
  assertStringIncludes(svg, "synapse-original");
  assertStringIncludes(svg, "synapse-synthetic");
  assertStringIncludes(svg, "control");
});

Deno.test("renderSyntheticSynapseSVG - rejects malformed phase ordering", () => {
  const result = runSyntheticSynapseDemo(SMALL_CONFIG);
  const reordered = [result.phases[1], result.phases[0], result.phases[2]];
  assertThrows(
    () =>
      renderSyntheticSynapseSVG({
        phases: reordered,
        controlScore: result.controlScore,
        controlSynapseCount: result.controlSynapseCount,
        topologies: result.topologies,
      }),
    Error,
    "expected",
  );
});

Deno.test("renderSyntheticSynapseSVG - byte-deterministic for identical input", () => {
  const result = runSyntheticSynapseDemo(SMALL_CONFIG);
  const a = renderSyntheticSynapseSVG({
    phases: result.phases,
    controlScore: result.controlScore,
    controlSynapseCount: result.controlSynapseCount,
    topologies: result.topologies,
  });
  const b = renderSyntheticSynapseSVG({
    phases: result.phases,
    controlScore: result.controlScore,
    controlSynapseCount: result.controlSynapseCount,
    topologies: result.topologies,
  });
  assertEquals(a, b);
});

Deno.test("cloneNetworkForTests - returns an independent copy", () => {
  const original = buildStudentNetwork(SMALL_CONFIG);
  const clone = cloneNetworkForTests(original);
  clone.synapses[0].weight = 999;
  assertEquals(original.synapses[0].weight !== 999, true);
});

Deno.test("DEFAULT_SYNTHETIC_SYNAPSE_CONFIG - has positive sizes and rates", () => {
  const c = DEFAULT_SYNTHETIC_SYNAPSE_CONFIG;
  assertGreater(c.inputs, 0);
  assertGreater(c.hidden, 0);
  assertGreater(c.outputs, 0);
  assertGreater(c.heldOutSize, 0);
  assertGreater(c.trainingSize, 0);
  assertGreater(c.sparseEpochs, 0);
  assertGreater(c.densifiedEpochs, 0);
  assertGreater(c.learningRate, 0);
  assertGreaterOrEqual(c.pruneThreshold, 0);
});
