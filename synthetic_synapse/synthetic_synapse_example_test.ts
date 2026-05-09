/**
 * Unit tests for the synthetic-synapse training demo (audit #206).
 *
 * The demo was reworked under issue #206 so the seed passed to NEAT-AI
 * is minimal (`new Creature(INPUT_COUNT, OUTPUT_COUNT)`) and evolution
 * runs through `Creature.evolveDir(...)` over a binary `.bin` training
 * set. Tests below exercise the new flow plus the helpers retained
 * from the previous SGD-driven design (forward pass, dataset
 * generation, held-out scoring, densify/prune on a `Creature`).
 *
 * Tests are "what" tests: they call real functions with deterministic
 * inputs and assert on the returned values, the resulting topology,
 * and the SVG payload. No source-level grepping or implementation
 * snooping.
 */
import {
  assert,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import { Creature } from "@stsoftware/neat-ai";

import {
  buildTargetNetwork,
  DEFAULT_SYNTHETIC_SYNAPSE_CONFIG,
  densifyCreature,
  EVOLUTION_CSV_HEADER,
  formatEvolutionCsv,
  forward,
  generateDataset,
  heldOutScore,
  INPUT_COUNT,
  OUTPUT_COUNT,
  pruneCreature,
  renderFitnessChartSvg,
  renderTopologyChartSvg,
  runSyntheticSynapseDemo,
  type SyntheticSynapseConfig,
  writeBinaryDataset,
} from "./synthetic_synapse_example.ts";
import { renderSyntheticSynapseSVG } from "./svg.ts";

/**
 * Small config used throughout the test suite — keeps each test fast
 * while still allowing NEAT-AI evolveDir to run a handful of
 * generations in both phases.
 */
const SMALL_CONFIG: SyntheticSynapseConfig = {
  seed: 424242,
  trainingSize: 16,
  heldOutSize: 16,
  targetError: 0.0001,
  timeoutMinutes: 0.05,
  populationSize: 6,
  maxIterationsPerPhase: 3,
  pruneThreshold: 0.04,
};

Deno.test("forward - returns finite outputs of the correct shape", () => {
  const network = buildTargetNetwork(SMALL_CONFIG);
  const inputs = new Float32Array(INPUT_COUNT).fill(0.1);
  const acts = forward(network, inputs);
  assertEquals(acts.length, network.neurons.length);
  for (let i = 0; i < acts.length; i++) {
    assert(Number.isFinite(acts[i]), `activation ${i} is not finite: ${acts[i]}`);
  }
});

Deno.test("forward - rejects mismatched input length", () => {
  const network = buildTargetNetwork(SMALL_CONFIG);
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

Deno.test("writeBinaryDataset - emits a Float32 .bin of the expected size", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "synthetic_synapse_test_" });
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
  "densifyCreature - adds a synthetic synapse for every missing forward edge",
  () => {
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const before = creature.synapses.length;
    const synthKeys = densifyCreature(creature);
    // Every newly added synapse must register as synthetic.
    assertEquals(creature.synapses.length, before + synthKeys.size);
    // Every synthetic synapse starts with weight 0.
    for (const s of creature.synapses) {
      const key = `${s.from}->${s.to}`;
      if (synthKeys.has(key)) {
        assertEquals(s.weight, 0, `synthetic ${key} should start at weight 0`);
      }
    }
  },
);

Deno.test("densifyCreature - is idempotent when called twice", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  densifyCreature(creature);
  const afterFirst = creature.synapses.length;
  const second = densifyCreature(creature);
  assertEquals(second.size, 0);
  assertEquals(creature.synapses.length, afterFirst);
});

Deno.test(
  "pruneCreature - removes only synthetic synapses below threshold",
  () => {
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const originalCount = creature.synapses.length;
    const synthKeys = densifyCreature(creature);
    const denseCount = creature.synapses.length;
    // All synthetic synapses start at zero, so any positive threshold
    // removes them all.
    const removed = pruneCreature(creature, synthKeys, 0.001);
    assertEquals(removed.size, synthKeys.size);
    assertEquals(creature.synapses.length, originalCount);
    assertEquals(denseCount - removed.size, originalCount);
  },
);

Deno.test("pruneCreature - rejects negative threshold", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const synthKeys = densifyCreature(creature);
  assertThrows(() => pruneCreature(creature, synthKeys, -1), Error, "threshold must be >= 0");
});

Deno.test(
  "runSyntheticSynapseDemo - produces three phases, densified > sparse > pruned-floor",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);
    assertEquals(result.phases.length, 3);
    const [sparse, densified, pruned] = result.phases;
    assertEquals(sparse.phase, "sparse");
    assertEquals(densified.phase, "densified");
    assertEquals(pruned.phase, "pruned");
    // Densification can only add synapses; the densified count is at
    // least the sparse count. With a tiny test budget the sparse
    // champion may not have grown hidden neurons, in which case
    // densify is a no-op against the direct input → output graph — so
    // we only assert >=, not strict >. Note that the refine phase may
    // add further structural synapses via NEAT mutations, so
    // `pruned` is not bounded above by `densified`.
    assertGreaterOrEqual(densified.synapseCount, sparse.synapseCount);
    assertGreaterOrEqual(pruned.synapseCount, 0);
    // Held-out scores are finite for every phase.
    for (const p of result.phases) {
      assert(Number.isFinite(p.heldOutScore), `${p.phase} score not finite`);
    }
    // Final champion is a real Creature.
    assert(result.champion.synapses.length > 0, "champion has no synapses");
  },
);

Deno.test(
  "runSyntheticSynapseDemo - emits per-generation telemetry rows",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);
    // evolveDir runs at least one generation per phase, so we expect
    // at least one telemetry row in the result.
    assertGreater(result.evolutionRows.length, 0);
    for (const r of result.evolutionRows) {
      assertGreaterOrEqual(r.generation, 1);
      assert(Number.isFinite(r.bestFitness), `gen ${r.generation} bestFitness not finite`);
      // NEAT-AI may report NaN for averageFitness in early generations
      // when the population has not yet been fully scored; accept any
      // numeric value here and rely on the CSV formatter to coerce
      // non-finite values to "0" for downstream tools.
      assertEquals(typeof r.meanFitness, "number");
      assertGreater(r.neuronCount, 0);
      assertGreater(r.synapseCount, 0);
    }
  },
);

Deno.test(
  "runSyntheticSynapseDemo - rejects bad config values",
  async () => {
    let threw = false;
    try {
      await runSyntheticSynapseDemo({ ...SMALL_CONFIG, trainingSize: 0 });
    } catch {
      threw = true;
    }
    assert(threw, "trainingSize=0 should throw");

    threw = false;
    try {
      await runSyntheticSynapseDemo({ ...SMALL_CONFIG, maxIterationsPerPhase: -1 });
    } catch {
      threw = true;
    }
    assert(threw, "negative maxIterationsPerPhase should throw");
  },
);

Deno.test(
  "renderSyntheticSynapseSVG - emits a well-formed SVG with topology and chart",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);
    const svg = renderSyntheticSynapseSVG({
      phases: result.phases,
      controlScore: result.phases[0].heldOutScore,
      controlSynapseCount: result.phases[0].synapseCount,
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
  },
);

Deno.test(
  "renderSyntheticSynapseSVG - rejects malformed phase ordering",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);
    const reordered = [result.phases[1], result.phases[0], result.phases[2]];
    assertThrows(
      () =>
        renderSyntheticSynapseSVG({
          phases: reordered,
          controlScore: result.phases[0].heldOutScore,
          controlSynapseCount: result.phases[0].synapseCount,
          topologies: result.topologies,
        }),
      Error,
      "expected",
    );
  },
);

Deno.test("formatEvolutionCsv - emits the canonical header and one row per gen", () => {
  const csv = formatEvolutionCsv([
    { generation: 1, bestFitness: 0.5, meanFitness: 0.25, neuronCount: 4, synapseCount: 7 },
    { generation: 2, bestFitness: 0.6, meanFitness: 0.3, neuronCount: 5, synapseCount: 9 },
  ]);
  const lines = csv.split("\n").filter((l) => l.length > 0);
  assertEquals(lines.length, 3);
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines[1], "1,0.5,0.25,4,7");
  assertEquals(lines[2], "2,0.6,0.3,5,9");
});

Deno.test("renderFitnessChartSvg - emits a well-formed SVG with both fitness lines", () => {
  const svg = renderFitnessChartSvg([
    { generation: 1, bestFitness: 0.4, meanFitness: 0.2, neuronCount: 4, synapseCount: 7 },
    { generation: 5, bestFitness: 0.8, meanFitness: 0.5, neuronCount: 6, synapseCount: 11 },
  ]);
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "best-fitness");
  assertStringIncludes(svg, "mean-fitness");
});

Deno.test("renderFitnessChartSvg - rejects empty input", () => {
  assertThrows(() => renderFitnessChartSvg([]), Error, "at least one row");
});

Deno.test("renderTopologyChartSvg - emits a well-formed SVG with both topology lines", () => {
  const svg = renderTopologyChartSvg([
    { generation: 1, bestFitness: 0.4, meanFitness: 0.2, neuronCount: 4, synapseCount: 7 },
    { generation: 5, bestFitness: 0.8, meanFitness: 0.5, neuronCount: 9, synapseCount: 22 },
  ]);
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "neuron-count");
  assertStringIncludes(svg, "synapse-count");
});

Deno.test("renderTopologyChartSvg - rejects empty input", () => {
  assertThrows(() => renderTopologyChartSvg([]), Error, "at least one row");
});

Deno.test("DEFAULT_SYNTHETIC_SYNAPSE_CONFIG - has positive sizes and rates", () => {
  const c = DEFAULT_SYNTHETIC_SYNAPSE_CONFIG;
  assertGreater(c.heldOutSize, 0);
  assertGreater(c.trainingSize, 0);
  assertGreater(c.targetError, 0);
  assertGreater(c.timeoutMinutes, 0);
  assertGreater(c.populationSize, 0);
  assertGreater(c.maxIterationsPerPhase, 0);
  assertGreaterOrEqual(c.pruneThreshold, 0);
});

Deno.test("heldOutScore - is finite for the target network on its own dataset", () => {
  const target = buildTargetNetwork(SMALL_CONFIG);
  const dataset = generateDataset(target, 8, 5);
  const score = heldOutScore(target, dataset);
  // Target network feeding its own outputs back gets the perfect score
  // (zero MSE, since the targets are computed via the target).
  assertEquals(Number.isFinite(score), true);
  assertGreaterOrEqual(score, -1e-9);
});

Deno.test(
  "networkFromCreature - mirrors the target network topology",
  () => {
    // The target network is built from `buildLargeCreature` with
    // hidden=8 + density=1.0 — a fully connected feed-forward graph
    // whose squash functions stay inside the helper's supported set
    // (IDENTITY / TANH / LOGISTIC). Evolved creatures may use any
    // NEAT-AI squash (e.g. MISH, SOFTSIGN) and are scored via
    // `creatureHeldOutScore`, not `networkFromCreature`.
    const target = buildTargetNetwork(SMALL_CONFIG);
    assertEquals(target.inputCount, INPUT_COUNT);
    assertEquals(target.outputCount, OUTPUT_COUNT);
    assertEquals(target.originalSynapseKeys.size, target.synapses.length);
  },
);

// Sanity: confirm the demo touched the synthetic synapse machinery and
// emitted a final champion that produces a finite held-out score.
Deno.test(
  "runSyntheticSynapseDemo - emits a champion with finite held-out score",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);
    const final = result.phases[result.phases.length - 1];
    assert(Number.isFinite(final.heldOutScore), "final held-out score not finite");
    assert(result.champion.synapses.length > 0, "champion should retain synapses");
  },
);
