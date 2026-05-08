/**
 * Unit tests for the adaptive mutation rate demo (issue #86).
 *
 * "What" tests only — every test calls a real function and asserts on
 * observable outputs (record structure, summary statistics, SVG
 * structure). No greps over source files.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertLessOrEqual,
  assertThrows,
} from "@std/assert";

import {
  applyOperator,
  buildInitialPopulation,
  chooseOperator,
  type CreatureSize,
  DEFAULT_ADAPTIVE_MUTATION_CONFIG,
  DEFAULT_POLICY_CONFIG,
  meanTopologyShare,
  OPERATOR_CATEGORY,
  runAdaptiveMutationDemo,
  runSingleEvolution,
  topologyProbability,
} from "./adaptive_mutation.ts";
import {
  PANEL_CLASS,
  renderAdaptiveMutationSVG,
  TOPOLOGY_CURVE_CLASS,
  WEIGHT_CURVE_CLASS,
} from "./svg.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

Deno.test("topologyProbability decreases monotonically as size grows", () => {
  const sizes: CreatureSize[] = [
    { hidden: 5, synapses: 8 },
    { hidden: 50, synapses: 100 },
    { hidden: 256, synapses: 10_000 },
  ];
  const probs = sizes.map((s) => topologyProbability(s));
  for (const p of probs) {
    assertGreaterOrEqual(p, 0);
    assertLessOrEqual(p, DEFAULT_POLICY_CONFIG.baseTopologyProb);
  }
  // Strictly decreasing — bigger creature → smaller topology share.
  assertGreater(probs[0], probs[1]);
  assertGreater(probs[1], probs[2]);
});

Deno.test("topologyProbability rejects invalid policy", () => {
  assertThrows(() =>
    topologyProbability(
      { hidden: 1, synapses: 1 },
      { ...DEFAULT_POLICY_CONFIG, baseTopologyProb: 0 },
    )
  );
  assertThrows(() =>
    topologyProbability(
      { hidden: 1, synapses: 1 },
      { ...DEFAULT_POLICY_CONFIG, sizeScale: 0 },
    )
  );
});

Deno.test("chooseOperator returns operators consistent with the OPERATOR_CATEGORY map", () => {
  const rng = createDeterministicRandom(123);
  const size: CreatureSize = { hidden: 5, synapses: 8 };
  for (let i = 0; i < 200; i++) {
    const op = chooseOperator(size, rng);
    assert(op in OPERATOR_CATEGORY, `unknown operator ${op}`);
  }
});

Deno.test("chooseOperator on a tiny creature is biased toward topology operators", () => {
  const rng = createDeterministicRandom(42);
  const size: CreatureSize = { hidden: 5, synapses: 8 };
  let topology = 0;
  let weight = 0;
  for (let i = 0; i < 1000; i++) {
    // Use a fresh size each iteration so the operator does not actually
    // mutate the size in the loop — we only want to sample the policy.
    const op = chooseOperator({ ...size }, rng);
    if (OPERATOR_CATEGORY[op] === "topology") topology++;
    else weight++;
  }
  // For size = 13 and default policy: p(topology) ≈ 0.6 / (1 + 13/80)
  // ≈ 0.516. Allow generous tolerance for sampling noise.
  const share = topology / (topology + weight);
  assertGreater(share, 0.4);
});

Deno.test("chooseOperator on a huge creature is biased toward weight operators", () => {
  const rng = createDeterministicRandom(7);
  const size: CreatureSize = { hidden: 256, synapses: 10_000 };
  let topology = 0;
  let weight = 0;
  for (let i = 0; i < 1000; i++) {
    const op = chooseOperator({ ...size }, rng);
    if (OPERATOR_CATEGORY[op] === "topology") topology++;
    else weight++;
  }
  const share = topology / (topology + weight);
  // For size ≈ 10256 the topology probability is < 0.01 — anything
  // approaching 0.1 would mean the policy is broken.
  assertGreaterOrEqual(0.1, share);
});

Deno.test("applyOperator keeps creature sizes non-negative", () => {
  const size: CreatureSize = { hidden: 1, synapses: 1 };
  // remove_neuron must refuse to drop below 1 hidden.
  applyOperator(size, "remove_neuron");
  assertEquals(size.hidden, 1);
  // remove_synapse must refuse to drop below 1 synapse.
  applyOperator(size, "remove_synapse");
  assertEquals(size.synapses, 1);
});

Deno.test("applyOperator add_neuron grows hidden by 1 and synapses by 1", () => {
  const size: CreatureSize = { hidden: 5, synapses: 12 };
  applyOperator(size, "add_neuron");
  assertEquals(size.hidden, 6);
  assertEquals(size.synapses, 13);
});

Deno.test("applyOperator add_synapse grows synapses by 1 only", () => {
  const size: CreatureSize = { hidden: 5, synapses: 12 };
  applyOperator(size, "add_synapse");
  assertEquals(size.hidden, 5);
  assertEquals(size.synapses, 13);
});

Deno.test("applyOperator weight/bias operators do not change size", () => {
  const size: CreatureSize = { hidden: 5, synapses: 12 };
  applyOperator(size, "mod_weight");
  assertEquals(size, { hidden: 5, synapses: 12 });
  applyOperator(size, "mod_bias");
  assertEquals(size, { hidden: 5, synapses: 12 });
});

Deno.test("buildInitialPopulation returns the requested number of creatures", () => {
  const pop = buildInitialPopulation(DEFAULT_ADAPTIVE_MUTATION_CONFIG.small, 5);
  assertEquals(pop.length, 5);
  for (const c of pop) {
    assertEquals(c.hidden, DEFAULT_ADAPTIVE_MUTATION_CONFIG.small.initialHidden);
    assertGreater(c.synapses, 0);
  }
});

Deno.test("buildInitialPopulation rejects non-positive populationSize", () => {
  assertThrows(() => buildInitialPopulation(DEFAULT_ADAPTIVE_MUTATION_CONFIG.small, 0));
});

Deno.test("runSingleEvolution records exactly `generations` GenerationRecords", () => {
  const rng = createDeterministicRandom(1);
  const result = runSingleEvolution(
    DEFAULT_ADAPTIVE_MUTATION_CONFIG.small,
    25,
    3,
    4,
    DEFAULT_POLICY_CONFIG,
    rng,
  );
  assertEquals(result.records.length, 25);
  for (let g = 0; g < 25; g++) {
    assertEquals(result.records[g].generation, g);
    // topologyRate + weightRate must equal 1 (within float tolerance).
    assertAlmostEquals(
      result.records[g].topologyRate + result.records[g].weightRate,
      1,
      1e-9,
    );
    assertGreaterOrEqual(result.records[g].topologyRate, 0);
    assertLessOrEqual(result.records[g].topologyRate, 1);
    // The total mutations recorded must equal mutationsPerGeneration *
    // populationSize.
    assertEquals(
      result.records[g].topologyMutations + result.records[g].weightMutations,
      3 * 4,
    );
  }
});

Deno.test("runSingleEvolution rejects invalid args", () => {
  const rng = createDeterministicRandom(1);
  assertThrows(() =>
    runSingleEvolution(
      DEFAULT_ADAPTIVE_MUTATION_CONFIG.small,
      0,
      3,
      4,
      DEFAULT_POLICY_CONFIG,
      rng,
    )
  );
  assertThrows(() =>
    runSingleEvolution(
      DEFAULT_ADAPTIVE_MUTATION_CONFIG.small,
      5,
      0,
      4,
      DEFAULT_POLICY_CONFIG,
      rng,
    )
  );
});

Deno.test("meanTopologyShare averages the per-generation topology rates", () => {
  const records = [
    {
      generation: 0,
      meanSize: 0,
      topologyMutations: 0,
      weightMutations: 0,
      topologyRate: 1,
      weightRate: 0,
    },
    {
      generation: 1,
      meanSize: 0,
      topologyMutations: 0,
      weightMutations: 0,
      topologyRate: 0.5,
      weightRate: 0.5,
    },
    {
      generation: 2,
      meanSize: 0,
      topologyMutations: 0,
      weightMutations: 0,
      topologyRate: 0,
      weightRate: 1,
    },
  ];
  assertAlmostEquals(meanTopologyShare(records), 0.5, 1e-9);
  assertEquals(meanTopologyShare([]), 0);
});

Deno.test("runAdaptiveMutationDemo: small topology share strictly exceeds large share", () => {
  const result = runAdaptiveMutationDemo(DEFAULT_ADAPTIVE_MUTATION_CONFIG);
  // The acceptance criterion from issue #86: topology share is lower
  // in the large-creature run than in the small-creature run.
  assertGreater(
    result.smallTopologyShareMean,
    result.largeTopologyShareMean,
    `small topology share (${result.smallTopologyShareMean.toFixed(4)}) must exceed ` +
      `large topology share (${result.largeTopologyShareMean.toFixed(4)})`,
  );
  // The small run should still spend a meaningful fraction on topology.
  assertGreater(result.smallTopologyShareMean, 0.2);
  // The large run should be essentially all weight/bias.
  assertGreaterOrEqual(0.05, result.largeTopologyShareMean);
});

Deno.test("runAdaptiveMutationDemo produces matched-length records for both runs", () => {
  const result = runAdaptiveMutationDemo({
    ...DEFAULT_ADAPTIVE_MUTATION_CONFIG,
    generations: 20,
  });
  assertEquals(result.small.records.length, 20);
  assertEquals(result.large.records.length, 20);
  // Numeric arrays — verify every entry is a finite number in [0, 1].
  for (let g = 0; g < 20; g++) {
    for (const run of [result.small, result.large]) {
      const r = run.records[g];
      assert(Number.isFinite(r.topologyRate));
      assert(Number.isFinite(r.weightRate));
      assert(Number.isFinite(r.meanSize));
      assertGreaterOrEqual(r.topologyRate, 0);
      assertLessOrEqual(r.topologyRate, 1);
      assertGreaterOrEqual(r.weightRate, 0);
      assertLessOrEqual(r.weightRate, 1);
    }
  }
});

Deno.test("runAdaptiveMutationDemo is deterministic for the same config", () => {
  const a = runAdaptiveMutationDemo(DEFAULT_ADAPTIVE_MUTATION_CONFIG);
  const b = runAdaptiveMutationDemo(DEFAULT_ADAPTIVE_MUTATION_CONFIG);
  assertEquals(a.smallTopologyShareMean, b.smallTopologyShareMean);
  assertEquals(a.largeTopologyShareMean, b.largeTopologyShareMean);
  for (let g = 0; g < a.small.records.length; g++) {
    assertEquals(a.small.records[g].topologyRate, b.small.records[g].topologyRate);
    assertEquals(a.large.records[g].topologyRate, b.large.records[g].topologyRate);
  }
});

Deno.test("runAdaptiveMutationDemo rejects invalid configs", () => {
  assertThrows(() =>
    runAdaptiveMutationDemo({ ...DEFAULT_ADAPTIVE_MUTATION_CONFIG, generations: 0 })
  );
  assertThrows(() =>
    runAdaptiveMutationDemo({ ...DEFAULT_ADAPTIVE_MUTATION_CONFIG, populationSize: 0 })
  );
});

Deno.test("renderAdaptiveMutationSVG produces a well-formed SVG with both panels", () => {
  const result = runAdaptiveMutationDemo({
    ...DEFAULT_ADAPTIVE_MUTATION_CONFIG,
    generations: 16,
  });
  const svg = renderAdaptiveMutationSVG({
    small: result.small,
    large: result.large,
  });
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes(TOPOLOGY_CURVE_CLASS), "must include topology curve class");
  assert(svg.includes(WEIGHT_CURVE_CLASS), "must include weight curve class");
  assert(svg.includes(PANEL_CLASS), "must include the panel class");

  // Expect 4 polylines: small {topology, weight} + large {topology, weight}.
  const polylines = svg.match(/<polyline /g) ?? [];
  assertGreaterOrEqual(polylines.length, 4);

  // Width / height must be positive integers.
  const widthMatch = svg.match(/width="(\d+)"/);
  const heightMatch = svg.match(/height="(\d+)"/);
  assert(widthMatch);
  assert(heightMatch);
  assertGreater(Number.parseInt(widthMatch![1], 10), 0);
  assertGreater(Number.parseInt(heightMatch![1], 10), 0);
});

Deno.test("renderAdaptiveMutationSVG rejects empty record arrays", () => {
  const empty = {
    label: "x",
    records: [],
    initialSize: { hidden: 0, synapses: 0 },
    finalMeanSize: { hidden: 0, synapses: 0 },
  };
  assertThrows(() => renderAdaptiveMutationSVG({ small: empty, large: empty }));
});

Deno.test("renderAdaptiveMutationSVG rejects mismatched record lengths", () => {
  const result = runAdaptiveMutationDemo({
    ...DEFAULT_ADAPTIVE_MUTATION_CONFIG,
    generations: 10,
  });
  const trimmed = {
    ...result.large,
    records: result.large.records.slice(0, 5),
  };
  assertThrows(() => renderAdaptiveMutationSVG({ small: result.small, large: trimmed }));
});
