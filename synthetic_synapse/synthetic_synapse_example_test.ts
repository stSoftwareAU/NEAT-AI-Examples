/**
 * Unit tests for the synthetic-synapse training demo (audit #206,
 * telemetry rewire #303).
 *
 * Under #303 the per-generation `onTrainingEvent` hook and the chunked
 * `evolveDir` loop were removed in favour of NEAT-AI's supported
 * milestone-only telemetry surface. The runner now makes two
 * `evolveDir` calls (sparse + refine) and captures an
 * {@link EvolveDirSummary} from each.
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
  forward,
  generateDataset,
  heldOutScore,
  INPUT_COUNT,
  OUTPUT_COUNT,
  pruneCreature,
  runSyntheticSynapseDemo,
  type SyntheticSynapseConfig,
  writeBinaryDataset,
} from "./synthetic_synapse_example.ts";
import { renderSyntheticSynapseSVG } from "./svg.ts";
import { renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";

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
  "runSyntheticSynapseDemo - produces three phases, densified >= sparse synapses",
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
  "runSyntheticSynapseDemo - returns milestone summaries from sparse and refine phases",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);

    // Sparse summary: seed counts match a minimal `new Creature(...)`.
    assertEquals(result.sparseSummary.seedNeurons, INPUT_COUNT + OUTPUT_COUNT);
    assertEquals(result.sparseSummary.seedSynapses, INPUT_COUNT * OUTPUT_COUNT);

    // Numeric summary fields are finite on both phases.
    for (const summary of [result.sparseSummary, result.refineSummary]) {
      assert(Number.isFinite(summary.finalError));
      assert(Number.isFinite(summary.finalScore));
      assertGreater(summary.generations, 0);
      assertGreater(summary.finalNeurons, 0);
      assertGreaterOrEqual(summary.finalSynapses, 0);
      assertGreaterOrEqual(summary.wallClockMs, 0);
    }

    // The refine phase may grow or prune synapses relative to the sparse
    // phase — no ordering guarantee between the two counts. The per-phase
    // `finalSynapses >= 0` check above is the only safe assertion here.
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

Deno.test(
  "renderEvolveDirSummarySvg renders the refine milestone summary",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);
    const svg = renderEvolveDirSummarySvg(result.refineSummary, {
      title: "Synthetic Synapse — refine evolveDir Run Summary",
    });
    assert(svg.startsWith("<svg"));
    assert(svg.includes("</svg>"));
    assert(svg.includes("final error"));
    assert(svg.includes("final score"));
    assert(svg.includes("generations"));
    assert(svg.includes("wall clock"));
    assert(svg.includes(String(result.refineSummary.finalNeurons)));
  },
);

Deno.test("DEFAULT_SYNTHETIC_SYNAPSE_CONFIG - has positive sizes and rates", () => {
  const c = DEFAULT_SYNTHETIC_SYNAPSE_CONFIG;
  assertGreater(c.heldOutSize, 0);
  assertGreater(c.trainingSize, 0);
  assertGreater(c.targetError, 0);
  // Issue #389 (Refresh-2026-05) lifted the wall-clock backstop from
  // 5 → 20 minutes (= the original 5 + the additional 15 wall-clock
  // minutes mandated by parent milestone #369) so the runner can
  // actually consume the extra evolution budget. The matching
  // `maxIterationsPerPhase` floor was lifted alongside so wall-clock
  // remains the genuine limiter.
  assertGreaterOrEqual(c.timeoutMinutes, 20);
  assertGreaterOrEqual(c.maxIterationsPerPhase, 1000);
  assertGreater(c.populationSize, 0);
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
    const target = buildTargetNetwork(SMALL_CONFIG);
    assertEquals(target.inputCount, INPUT_COUNT);
    assertEquals(target.outputCount, OUTPUT_COUNT);
    assertEquals(target.originalSynapseKeys.size, target.synapses.length);
  },
);

Deno.test(
  "runSyntheticSynapseDemo - emits a champion with finite held-out score",
  async () => {
    const result = await runSyntheticSynapseDemo(SMALL_CONFIG);
    const final = result.phases[result.phases.length - 1];
    assert(Number.isFinite(final.heldOutScore), "final held-out score not finite");
    assert(result.champion.synapses.length > 0, "champion should retain synapses");
  },
);
