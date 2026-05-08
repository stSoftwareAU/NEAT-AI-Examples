/**
 * Unit tests for the neuron-pruning demo.
 *
 * Tests are "what" tests: they call real functions with deterministic
 * inputs and assert on the returned values, the resulting topology, and
 * the SVG payload. No source-level grepping or implementation snooping.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertLess,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import {
  buildDemoNetwork,
  cloneNetwork,
  DEFAULT_NEURON_PRUNING_CONFIG,
  detectConstantNeurons,
  forward,
  generateDataset,
  heldOutScore,
  injectConstantNeurons,
  networkFromCreature,
  type NeuronPruningConfig,
  pruneConstantNeurons,
  runNeuronPruningDemo,
} from "./neuron_pruning.ts";
import { renderNeuronPruningSVG } from "./svg.ts";
import { buildLargeCreature } from "../common/large_creature.ts";

/** Small config used throughout the test suite — keeps each test fast. */
const SMALL_CONFIG: NeuronPruningConfig = {
  inputs: 3,
  hidden: 10,
  outputs: 2,
  density: 0.35,
  constantNeurons: 4,
  seed: 4242,
  heldOutSize: 24,
  varianceThreshold: 1e-12,
};

Deno.test("networkFromCreature - mirrors the Creature topology", () => {
  const creature = buildLargeCreature({
    inputs: 3,
    hidden: 6,
    outputs: 2,
    density: 0.3,
    seed: 7,
  });
  const network = networkFromCreature(creature);
  assertEquals(network.inputCount, 3);
  assertEquals(network.outputCount, 2);
  assertEquals(network.neurons.length, creature.neurons.length);
  assertEquals(network.synapses.length, creature.synapses.length);
});

Deno.test("forward - returns finite outputs of the correct shape", () => {
  const network = buildDemoNetwork(SMALL_CONFIG);
  const inputs = new Float32Array([0.1, -0.4, 0.7]);
  const acts = forward(network, inputs);
  assertEquals(acts.length, network.neurons.length);
  for (let i = 0; i < acts.length; i++) {
    assert(Number.isFinite(acts[i]), `activation ${i} is not finite: ${acts[i]}`);
  }
});

Deno.test("forward - rejects mismatched input length", () => {
  const network = buildDemoNetwork(SMALL_CONFIG);
  assertThrows(
    () => forward(network, new Float32Array([0.1, 0.2])),
    Error,
    "expected",
  );
});

Deno.test("injectConstantNeurons - drops incoming synapses on the chosen neurons", () => {
  const creature = buildLargeCreature({
    inputs: 3,
    hidden: 8,
    outputs: 2,
    density: 0.4,
    seed: 11,
  });
  const network = networkFromCreature(creature);
  const before = network.synapses.length;
  const chosen = injectConstantNeurons(network, 3, 11);
  assertEquals(chosen.length, 3);
  // All chosen indices are hidden neurons.
  for (const idx of chosen) {
    assert(idx >= network.inputCount);
    assert(idx < network.neurons.length - network.outputCount);
  }
  // No surviving synapse points into a chosen neuron.
  for (const s of network.synapses) {
    assert(!chosen.includes(s.to), `synapse ${s.from}->${s.to} should have been removed`);
  }
  assertLess(network.synapses.length, before);
});

Deno.test("injectConstantNeurons - rejects count larger than hidden", () => {
  const creature = buildLargeCreature({
    inputs: 2,
    hidden: 4,
    outputs: 2,
    density: 0.3,
    seed: 1,
  });
  const network = networkFromCreature(creature);
  assertThrows(() => injectConstantNeurons(network, 99, 1), Error, "exceeds");
});

Deno.test(
  "detectConstantNeurons - flags zero-input hidden neurons as constant",
  () => {
    const network = buildDemoNetwork(SMALL_CONFIG);
    // Build the dataset off the unmodified target creature so that the
    // injected neurons are objectively dead weight on the held-out task.
    const target = networkFromCreature(
      buildLargeCreature({
        inputs: SMALL_CONFIG.inputs,
        hidden: SMALL_CONFIG.hidden,
        outputs: SMALL_CONFIG.outputs,
        density: SMALL_CONFIG.density,
        seed: SMALL_CONFIG.seed,
      }),
    );
    const dataset = generateDataset(target, SMALL_CONFIG.heldOutSize, 99);
    const constants = detectConstantNeurons(network, dataset, SMALL_CONFIG.varianceThreshold);
    // We injected exactly `constantNeurons` zero-input hidden neurons, so
    // the detector must find at least that many constant neurons. (It may
    // legitimately find more if a hidden neuron's incoming weights happen
    // to cancel out across the dataset — that is also a valid prune.)
    assertGreater(constants.length, SMALL_CONFIG.constantNeurons - 1);
  },
);

Deno.test("detectConstantNeurons - rejects negative threshold", () => {
  const network = buildDemoNetwork(SMALL_CONFIG);
  assertThrows(
    () => detectConstantNeurons(network, [], -1),
    Error,
    "varianceThreshold",
  );
});

Deno.test("pruneConstantNeurons - returns empty when no constants are supplied", () => {
  const network = buildDemoNetwork(SMALL_CONFIG);
  const before = network.neurons.length;
  const records = pruneConstantNeurons(network, []);
  assertEquals(records.length, 0);
  assertEquals(network.neurons.length, before);
});

Deno.test(
  "pruneConstantNeurons - bias-fold preserves forward outputs to floating-point",
  () => {
    const network = buildDemoNetwork(SMALL_CONFIG);
    const target = networkFromCreature(
      buildLargeCreature({
        inputs: SMALL_CONFIG.inputs,
        hidden: SMALL_CONFIG.hidden,
        outputs: SMALL_CONFIG.outputs,
        density: SMALL_CONFIG.density,
        seed: SMALL_CONFIG.seed,
      }),
    );
    const dataset = generateDataset(target, 16, 7);

    // Capture the pre-prune outputs for every dataset point.
    const beforeOuts: number[][] = [];
    for (const point of dataset) {
      const acts = forward(network, point.inputs);
      const outStart = network.neurons.length - network.outputCount;
      beforeOuts.push(
        Array.from(acts.subarray(outStart, outStart + network.outputCount)),
      );
    }

    const constants = detectConstantNeurons(network, dataset, SMALL_CONFIG.varianceThreshold);
    assertGreater(constants.length, 0);

    const records = pruneConstantNeurons(network, constants);
    assertEquals(records.length, constants.length);

    // Post-prune outputs must match pre-prune outputs to floating-point
    // tolerance — bias-folding is mathematically exact for genuinely
    // constant neurons.
    for (let i = 0; i < dataset.length; i++) {
      const acts = forward(network, dataset[i].inputs);
      const outStart = network.neurons.length - network.outputCount;
      for (let o = 0; o < network.outputCount; o++) {
        assertAlmostEquals(acts[outStart + o], beforeOuts[i][o], 1e-5);
      }
    }
  },
);

Deno.test("pruneConstantNeurons - records bias-fold targets per pruned neuron", () => {
  const network = buildDemoNetwork(SMALL_CONFIG);
  const target = networkFromCreature(
    buildLargeCreature({
      inputs: SMALL_CONFIG.inputs,
      hidden: SMALL_CONFIG.hidden,
      outputs: SMALL_CONFIG.outputs,
      density: SMALL_CONFIG.density,
      seed: SMALL_CONFIG.seed,
    }),
  );
  const dataset = generateDataset(target, 16, 7);
  const constants = detectConstantNeurons(network, dataset, SMALL_CONFIG.varianceThreshold);
  const records = pruneConstantNeurons(network, constants);
  // Every record references the original neuron index plus the targets
  // that absorbed its constant contribution.
  for (const rec of records) {
    assertEquals(typeof rec.neuronIndex, "number");
    assert(Number.isFinite(rec.constantOutput));
    // bias-fold targets are sorted ascending and contain no duplicates.
    for (let i = 1; i < rec.biasFoldTargets.length; i++) {
      assertGreater(rec.biasFoldTargets[i], rec.biasFoldTargets[i - 1]);
    }
  }
});

Deno.test("runNeuronPruningDemo - removes neurons and does not regress score", () => {
  const result = runNeuronPruningDemo(SMALL_CONFIG);
  assertGreater(
    result.preNeuronCount,
    result.postNeuronCount,
    "pruning must strictly reduce the neuron count",
  );
  // Held-out score must not regress beyond a tiny float tolerance — the
  // pruned neurons were truly constant on every dataset record, so the
  // pruned creature is mathematically equivalent on the same data.
  const tolerance = 1e-4;
  assert(
    result.postScore + tolerance >= result.preScore,
    `post-prune score ${result.postScore} regressed versus pre-prune ${result.preScore}`,
  );
});

Deno.test("runNeuronPruningDemo - is deterministic for the same config", () => {
  const a = runNeuronPruningDemo(SMALL_CONFIG);
  const b = runNeuronPruningDemo(SMALL_CONFIG);
  assertEquals(a.preNeuronCount, b.preNeuronCount);
  assertEquals(a.postNeuronCount, b.postNeuronCount);
  assertEquals(a.preScore, b.preScore);
  assertEquals(a.postScore, b.postScore);
  assertEquals(a.pruned.length, b.pruned.length);
  for (let i = 0; i < a.pruned.length; i++) {
    assertEquals(a.pruned[i].neuronIndex, b.pruned[i].neuronIndex);
    assertEquals(a.pruned[i].constantOutput, b.pruned[i].constantOutput);
    assertEquals(a.pruned[i].biasFoldTargets, b.pruned[i].biasFoldTargets);
  }
});

Deno.test("runNeuronPruningDemo - rejects bad config values", () => {
  assertThrows(() => runNeuronPruningDemo({ ...SMALL_CONFIG, heldOutSize: 0 }), Error);
  assertThrows(() => runNeuronPruningDemo({ ...SMALL_CONFIG, constantNeurons: 0 }), Error);
  assertThrows(() => runNeuronPruningDemo({ ...SMALL_CONFIG, density: 1.5 }), Error);
});

Deno.test("runNeuronPruningDemo - held-out score is finite for both phases", () => {
  const result = runNeuronPruningDemo(SMALL_CONFIG);
  assert(Number.isFinite(result.preScore));
  assert(Number.isFinite(result.postScore));
});

Deno.test("heldOutScore - higher is better and identical for identical networks", () => {
  const a = buildDemoNetwork(SMALL_CONFIG);
  const b = buildDemoNetwork(SMALL_CONFIG);
  const target = networkFromCreature(
    buildLargeCreature({
      inputs: SMALL_CONFIG.inputs,
      hidden: SMALL_CONFIG.hidden,
      outputs: SMALL_CONFIG.outputs,
      density: SMALL_CONFIG.density,
      seed: SMALL_CONFIG.seed,
    }),
  );
  const data = generateDataset(target, 16, 13);
  assertEquals(heldOutScore(a, data), heldOutScore(b, data));
  // Score is non-positive (it's -MSE).
  assert(heldOutScore(a, data) <= 0);
});

Deno.test("cloneNetwork - returns an independent copy", () => {
  const original = buildDemoNetwork(SMALL_CONFIG);
  const clone = cloneNetwork(original);
  clone.synapses[0].weight = 999;
  assertEquals(original.synapses[0].weight !== 999, true);
  clone.neurons[clone.neurons.length - 1].bias = 999;
  assertEquals(original.neurons[original.neurons.length - 1].bias !== 999, true);
});

Deno.test(
  "renderNeuronPruningSVG - emits a well-formed SVG with topology and summary",
  () => {
    const result = runNeuronPruningDemo(SMALL_CONFIG);
    const svg = renderNeuronPruningSVG({
      topology: result.topology,
      preNeuronCount: result.preNeuronCount,
      postNeuronCount: result.postNeuronCount,
      preScore: result.preScore,
      postScore: result.postScore,
      pruned: result.pruned,
    });
    assertStringIncludes(svg, "<svg");
    assertStringIncludes(svg, "</svg>");
    assertStringIncludes(svg, "Topology");
    assertStringIncludes(svg, "Summary");
    assertStringIncludes(svg, "bias-fold");
    assertStringIncludes(svg, "neuron-pruned");
    assertStringIncludes(svg, "neuron-kept");
    assertStringIncludes(svg, "edge-original");
    // The SVG embeds the legend.
    assertStringIncludes(svg, "constant activation");
  },
);

Deno.test("renderNeuronPruningSVG - rejects inconsistent topology", () => {
  const result = runNeuronPruningDemo(SMALL_CONFIG);
  assertThrows(
    () =>
      renderNeuronPruningSVG({
        topology: result.topology,
        preNeuronCount: result.preNeuronCount + 5,
        postNeuronCount: result.postNeuronCount,
        preScore: result.preScore,
        postScore: result.postScore,
        pruned: result.pruned,
      }),
    Error,
    "preNeuronCount",
  );
});

Deno.test("renderNeuronPruningSVG - byte-deterministic for identical input", () => {
  const result = runNeuronPruningDemo(SMALL_CONFIG);
  const a = renderNeuronPruningSVG({
    topology: result.topology,
    preNeuronCount: result.preNeuronCount,
    postNeuronCount: result.postNeuronCount,
    preScore: result.preScore,
    postScore: result.postScore,
    pruned: result.pruned,
  });
  const b = renderNeuronPruningSVG({
    topology: result.topology,
    preNeuronCount: result.preNeuronCount,
    postNeuronCount: result.postNeuronCount,
    preScore: result.preScore,
    postScore: result.postScore,
    pruned: result.pruned,
  });
  assertEquals(a, b);
});

Deno.test("DEFAULT_NEURON_PRUNING_CONFIG - has positive sizes and counts", () => {
  const c = DEFAULT_NEURON_PRUNING_CONFIG;
  assertGreater(c.inputs, 0);
  assertGreater(c.hidden, 0);
  assertGreater(c.outputs, 0);
  assertGreater(c.heldOutSize, 0);
  assertGreater(c.constantNeurons, 0);
  assert(c.density > 0 && c.density <= 1);
  assert(c.varianceThreshold >= 0);
});
