/**
 * Unit tests for the neuron-pruning demo (audit #217, telemetry rewire #303).
 *
 * The demo was reworked under issue #217 so the seed passed to NEAT-AI
 * is minimal (`new Creature(INPUT_COUNT, OUTPUT_COUNT)`) and evolution
 * runs through `Creature.evolveDir(...)` over a binary `.bin` training
 * set. Under #303 the per-generation telemetry hook was removed in
 * favour of NEAT-AI's milestone-only telemetry surface — the runner now
 * makes a single `evolveDir` call and captures an
 * `EvolveDirSummary` from its return value.
 *
 * Tests are "what" tests: they call real functions with deterministic
 * inputs and assert on the returned values, the resulting topology,
 * and the SVG payload. No source-level grepping or implementation
 * snooping.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertLess,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import {
  buildDemoNetwork,
  buildTargetNetwork,
  cloneNetwork,
  DEFAULT_NEURON_PRUNING_CONFIG,
  detectConstantNeurons,
  forward,
  generateDataset,
  heldOutScore,
  injectConstantNeurons,
  INPUT_COUNT,
  networkFromCreature,
  type NeuronPruningConfig,
  OUTPUT_COUNT,
  pruneConstantNeurons,
  runNeuronPruningDemo,
  writeBinaryDataset,
} from "./neuron_pruning.ts";
import { renderNeuronPruningSVG } from "./svg.ts";
import { renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { buildLargeCreature } from "../common/large_creature.ts";

/**
 * Small config used throughout the test suite — keeps each test fast
 * while still allowing NEAT-AI evolveDir to run a handful of generations.
 */
const SMALL_CONFIG: NeuronPruningConfig = {
  inputs: INPUT_COUNT,
  hidden: 6,
  outputs: OUTPUT_COUNT,
  density: 0.5,
  constantNeurons: 2,
  seed: 4242,
  trainingSize: 24,
  heldOutSize: 24,
  varianceThreshold: 1e-12,
  targetError: 0.0001,
  timeoutMinutes: 0.05,
  populationSize: 6,
  maxIterations: 3,
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
  const inputs = new Float32Array(INPUT_COUNT).fill(0.1);
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
    assertGreaterOrEqual(constants.length, SMALL_CONFIG.constantNeurons);
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
  for (const rec of records) {
    assertEquals(typeof rec.neuronIndex, "number");
    assert(Number.isFinite(rec.constantOutput));
    for (let i = 1; i < rec.biasFoldTargets.length; i++) {
      assertGreater(rec.biasFoldTargets[i], rec.biasFoldTargets[i - 1]);
    }
  }
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

Deno.test("writeBinaryDataset - emits a Float32 .bin of the expected size", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "neuron_pruning_test_" });
  try {
    const target = buildTargetNetwork(SMALL_CONFIG);
    const dataset = generateDataset(target, 4, 42);
    const path = writeBinaryDataset(dataset, tmp);
    const stat = await Deno.stat(path);
    // 4 records × (INPUT_COUNT + OUTPUT_COUNT) × 4 bytes per Float32.
    assertEquals(stat.size, 4 * (INPUT_COUNT + OUTPUT_COUNT) * 4);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test(
  "runNeuronPruningDemo - removes neurons and does not regress score",
  async () => {
    const result = await runNeuronPruningDemo(SMALL_CONFIG);
    assertGreaterOrEqual(result.preNeuronCount, result.postNeuronCount);
    const tolerance = 1e-4;
    assert(
      result.postScore + tolerance >= result.preScore,
      `post-prune score ${result.postScore} regressed versus pre-prune ${result.preScore}`,
    );
  },
);

Deno.test(
  "runNeuronPruningDemo - returns a milestone summary from a single evolveDir call",
  async () => {
    const result = await runNeuronPruningDemo(SMALL_CONFIG);
    const summary = result.evolutionSummary;
    assert(Number.isFinite(summary.finalError));
    assert(Number.isFinite(summary.finalScore));
    assertGreater(summary.generations, 0);
    // Seed counts match a minimal `new Creature(INPUT_COUNT, OUTPUT_COUNT)`.
    assertEquals(summary.seedNeurons, INPUT_COUNT + OUTPUT_COUNT);
    // Final topology counts match the post-prune state on the result.
    assertEquals(summary.finalNeurons, result.postNeuronCount);
    assertEquals(summary.finalSynapses, result.postSynapseCount);
    assertGreaterOrEqual(summary.wallClockMs, 0);
  },
);

Deno.test(
  "runNeuronPruningDemo - returns a Creature champion with finite held-out score",
  async () => {
    const result = await runNeuronPruningDemo(SMALL_CONFIG);
    assert(Number.isFinite(result.preScore));
    assert(Number.isFinite(result.postScore));
    assert(result.champion.synapses.length >= 0, "champion missing synapses field");
  },
);

Deno.test("runNeuronPruningDemo - rejects bad config values", async () => {
  let threw = false;
  try {
    await runNeuronPruningDemo({ ...SMALL_CONFIG, heldOutSize: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "heldOutSize=0 should throw");

  threw = false;
  try {
    await runNeuronPruningDemo({ ...SMALL_CONFIG, constantNeurons: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "constantNeurons=0 should throw");

  threw = false;
  try {
    await runNeuronPruningDemo({ ...SMALL_CONFIG, density: 1.5 });
  } catch {
    threw = true;
  }
  assert(threw, "density>1 should throw");

  threw = false;
  try {
    await runNeuronPruningDemo({ ...SMALL_CONFIG, maxIterations: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "maxIterations=0 should throw");
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
  async () => {
    const result = await runNeuronPruningDemo(SMALL_CONFIG);
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
    assertStringIncludes(svg, "neuron-kept");
    assertStringIncludes(svg, "edge-original");
    assertStringIncludes(svg, "constant activation");
  },
);

Deno.test("renderNeuronPruningSVG - rejects inconsistent topology", async () => {
  const result = await runNeuronPruningDemo(SMALL_CONFIG);
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

Deno.test(
  "renderEvolveDirSummarySvg renders the milestone summary derived from runNeuronPruningDemo",
  async () => {
    const result = await runNeuronPruningDemo(SMALL_CONFIG);
    const svg = renderEvolveDirSummarySvg(result.evolutionSummary, {
      title: "Neuron Pruning — evolveDir Run Summary",
    });
    assert(svg.startsWith("<svg"));
    assert(svg.includes("</svg>"));
    assert(svg.includes("final error"));
    assert(svg.includes("final score"));
    assert(svg.includes("generations"));
    assert(svg.includes("wall clock"));
    assert(svg.includes(String(result.evolutionSummary.seedNeurons)));
    assert(svg.includes(String(result.evolutionSummary.finalNeurons)));
  },
);

Deno.test("DEFAULT_NEURON_PRUNING_CONFIG - has positive sizes and counts", () => {
  const c = DEFAULT_NEURON_PRUNING_CONFIG;
  assertGreater(c.inputs, 0);
  assertGreater(c.hidden, 0);
  assertGreater(c.outputs, 0);
  assertGreater(c.heldOutSize, 0);
  assertGreater(c.trainingSize, 0);
  assertGreater(c.constantNeurons, 0);
  assertGreater(c.targetError, 0);
  assertGreater(c.timeoutMinutes, 0);
  assertGreater(c.populationSize, 0);
  assertGreater(c.maxIterations, 0);
  assert(c.density > 0 && c.density <= 1);
  assert(c.varianceThreshold >= 0);
});
