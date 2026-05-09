/**
 * Unit tests for the adaptive mutation rate demo (issue #86, audited #212).
 *
 * The demo was reworked under issue #212 so the seed passed to NEAT-AI
 * is minimal (`new Creature(INPUT_COUNT, OUTPUT_COUNT)`) and evolution
 * runs through `Creature.evolveDir(...)` over a binary `.bin` training
 * set. Tests below exercise the new flow plus the documented analytic
 * policy curve and SVG renderers.
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
  assertLessOrEqual,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import {
  type AdaptiveMutationConfig,
  buildTargetNetwork,
  creatureHeldOutScore,
  DEFAULT_ADAPTIVE_MUTATION_CONFIG,
  DEFAULT_POLICY_CONFIG,
  EVOLUTION_CSV_HEADER,
  formatEvolutionCsv,
  generateDataset,
  INPUT_COUNT,
  OUTPUT_COUNT,
  runAdaptiveMutationDemo,
  topologyProbability,
  writeBinaryDataset,
} from "./adaptive_mutation.ts";
import {
  FITNESS_CURVE_CLASS,
  NEURON_CURVE_CLASS,
  renderAdaptiveMutationSVG,
  renderFitnessChartSvg,
  renderTopologyChartSvg,
  SIZE_CURVE_CLASS,
  SYNAPSE_CURVE_CLASS,
  TOPOLOGY_CURVE_CLASS,
} from "./svg.ts";

/**
 * Small config used throughout the test suite — keeps each test fast
 * while still allowing NEAT-AI evolveDir to run a handful of
 * generations. `timeoutMinutes: 0` skips the FFI cleanup paths so the
 * Deno test sanitiser stays clean.
 */
const SMALL_CONFIG: AdaptiveMutationConfig = {
  seed: 86,
  trainingSize: 16,
  targetError: 0.0001,
  timeoutMinutes: 0,
  populationSize: 6,
  maxIterations: 3,
  mutationRate: 0.6,
  mutationAmount: 3,
};

Deno.test("topologyProbability decreases monotonically as size grows", () => {
  const probs = [0, 13, 100, 10_256].map((s) => topologyProbability(s));
  for (const p of probs) {
    assertGreaterOrEqual(p, 0);
    assertLessOrEqual(p, DEFAULT_POLICY_CONFIG.baseTopologyProb);
  }
  assertGreater(probs[0], probs[1]);
  assertGreater(probs[1], probs[2]);
  assertGreater(probs[2], probs[3]);
});

Deno.test("topologyProbability rejects invalid policy", () => {
  assertThrows(() => topologyProbability(10, { ...DEFAULT_POLICY_CONFIG, baseTopologyProb: 0 }));
  assertThrows(() => topologyProbability(10, { ...DEFAULT_POLICY_CONFIG, sizeScale: 0 }));
});

Deno.test("topologyProbability rejects negative or non-finite size", () => {
  assertThrows(() => topologyProbability(-1));
  assertThrows(() => topologyProbability(Number.NaN));
  assertThrows(() => topologyProbability(Number.POSITIVE_INFINITY));
});

Deno.test("topologyProbability matches the documented closed form", () => {
  const policy = { baseTopologyProb: 0.6, sizeScale: 80 };
  // size 0 → baseTopologyProb.
  assertAlmostEquals(topologyProbability(0, policy), 0.6, 1e-12);
  // size 80 → half of base.
  assertAlmostEquals(topologyProbability(80, policy), 0.3, 1e-12);
  // size 240 → quarter of base.
  assertAlmostEquals(topologyProbability(240, policy), 0.15, 1e-12);
});

Deno.test("buildTargetNetwork - returns a creature with the correct I/O shape", () => {
  const target = buildTargetNetwork(SMALL_CONFIG.seed);
  assertEquals(target.input, INPUT_COUNT);
  assertEquals(target.output, OUTPUT_COUNT);
  assertGreater(target.synapses.length, 0);
});

Deno.test("generateDataset - is deterministic for a given seed", () => {
  const target = buildTargetNetwork(SMALL_CONFIG.seed);
  const a = generateDataset(target, 8, 99);
  const b = generateDataset(target, 8, 99);
  for (let i = 0; i < a.length; i++) {
    assertEquals(Array.from(a[i].inputs), Array.from(b[i].inputs));
    assertEquals(Array.from(a[i].targets), Array.from(b[i].targets));
  }
});

Deno.test("generateDataset - rejects non-positive size", () => {
  const target = buildTargetNetwork(SMALL_CONFIG.seed);
  assertThrows(() => generateDataset(target, 0, 1), Error, "size must be positive");
});

Deno.test("writeBinaryDataset - emits a Float32 .bin of the expected size", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "adaptive_mutation_test_" });
  try {
    const target = buildTargetNetwork(SMALL_CONFIG.seed);
    const ds = generateDataset(target, 4, 1);
    const path = writeBinaryDataset(ds, tmp);
    const stat = await Deno.stat(path);
    const expectedBytes = ds.length * (INPUT_COUNT + OUTPUT_COUNT) * 4;
    assertEquals(stat.size, expectedBytes);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("creatureHeldOutScore - returns a finite non-positive value", () => {
  const target = buildTargetNetwork(SMALL_CONFIG.seed);
  const ds = generateDataset(target, 8, 7);
  const score = creatureHeldOutScore(target, ds);
  assert(Number.isFinite(score), `held-out score not finite: ${score}`);
  assertLessOrEqual(score, 0);
});

Deno.test("creatureHeldOutScore - empty dataset returns 0", () => {
  const target = buildTargetNetwork(SMALL_CONFIG.seed);
  assertEquals(creatureHeldOutScore(target, []), 0);
});

Deno.test("runAdaptiveMutationDemo - rejects invalid configs", async () => {
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, trainingSize: 0 }));
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, maxIterations: 0 }));
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, populationSize: 0 }));
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, timeoutMinutes: -1 }));
});

Deno.test("runAdaptiveMutationDemo - emits per-generation telemetry rows", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assertGreater(result.evolutionRows.length, 0);
  for (const row of result.evolutionRows) {
    assertGreaterOrEqual(row.generation, 0);
    assertGreaterOrEqual(row.neuronCount, INPUT_COUNT + OUTPUT_COUNT);
    assertGreaterOrEqual(row.synapseCount, 0);
    assert(Number.isFinite(row.bestFitness), "bestFitness must be finite");
  }
});

Deno.test("runAdaptiveMutationDemo - champion has the correct I/O shape", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assertEquals(result.champion.input, INPUT_COUNT);
  assertEquals(result.champion.output, OUTPUT_COUNT);
  // The minimal seed has neurons.length = INPUT_COUNT + OUTPUT_COUNT.
  // After evolveDir runs at least one generation with mutationRate 0.6
  // we expect at least the seed shape.
  assertGreaterOrEqual(result.champion.neurons.length, INPUT_COUNT + OUTPUT_COUNT);
});

Deno.test("runAdaptiveMutationDemo - reports finite held-out score and wall-clock", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assert(Number.isFinite(result.heldOutScore));
  assertGreaterOrEqual(result.wallClockMs, 0);
  assertGreaterOrEqual(result.generations, 0);
});

Deno.test("formatEvolutionCsv - emits canonical header and one row per generation", () => {
  const csv = formatEvolutionCsv([
    { generation: 1, bestFitness: 0.5, meanFitness: 0.4, neuronCount: 6, synapseCount: 8 },
    { generation: 2, bestFitness: 0.7, meanFitness: 0.6, neuronCount: 7, synapseCount: 10 },
  ]);
  const lines = csv.trim().split("\n");
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[1], "1,0.5,0.4,6,8");
  assertStringIncludes(lines[2], "2,0.7,0.6,7,10");
});

Deno.test("formatEvolutionCsv - handles non-finite numbers by writing 0", () => {
  const csv = formatEvolutionCsv([
    {
      generation: 1,
      bestFitness: Number.NaN,
      meanFitness: Number.POSITIVE_INFINITY,
      neuronCount: 6,
      synapseCount: 8,
    },
  ]);
  assertStringIncludes(csv, "1,0,0,6,8");
});

Deno.test("renderFitnessChartSvg - well-formed SVG with the fitness CSS class", () => {
  const svg = renderFitnessChartSvg([
    { generation: 1, bestFitness: 0.5, meanFitness: 0.4, neuronCount: 6, synapseCount: 8 },
    { generation: 2, bestFitness: 0.7, meanFitness: 0.6, neuronCount: 7, synapseCount: 10 },
  ]);
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assertStringIncludes(svg, FITNESS_CURVE_CLASS);
});

Deno.test("renderFitnessChartSvg - rejects empty rows", () => {
  assertThrows(() => renderFitnessChartSvg([]), Error, "at least one row");
});

Deno.test("renderTopologyChartSvg - well-formed SVG with the topology CSS classes", () => {
  const svg = renderTopologyChartSvg([
    { generation: 1, bestFitness: 0.5, meanFitness: 0.4, neuronCount: 6, synapseCount: 8 },
    { generation: 2, bestFitness: 0.7, meanFitness: 0.6, neuronCount: 7, synapseCount: 10 },
  ]);
  assert(svg.startsWith("<svg"));
  assertStringIncludes(svg, NEURON_CURVE_CLASS);
  assertStringIncludes(svg, SYNAPSE_CURVE_CLASS);
});

Deno.test("renderTopologyChartSvg - rejects empty rows", () => {
  assertThrows(() => renderTopologyChartSvg([]), Error, "at least one row");
});

Deno.test("renderAdaptiveMutationSVG - well-formed SVG with both panel curves", () => {
  const rows = [
    { generation: 1, bestFitness: 0.5, meanFitness: 0.4, neuronCount: 6, synapseCount: 8 },
    { generation: 5, bestFitness: 0.7, meanFitness: 0.6, neuronCount: 8, synapseCount: 14 },
    { generation: 10, bestFitness: 0.9, meanFitness: 0.85, neuronCount: 11, synapseCount: 22 },
  ];
  const svg = renderAdaptiveMutationSVG({
    rows,
    heldOutScore: -0.05,
    wallClockMs: 4321,
    generations: 10,
    solved: true,
  });
  assert(svg.startsWith("<svg"));
  assertStringIncludes(svg, SIZE_CURVE_CLASS);
  assertStringIncludes(svg, TOPOLOGY_CURVE_CLASS);
  // Caption quotes the measured numbers from the latest run.
  assertStringIncludes(svg, "Generations: 10");
  assertStringIncludes(svg, "Held-out -MSE: -0.0500");
});

Deno.test("renderAdaptiveMutationSVG - rejects empty rows", () => {
  assertThrows(() =>
    renderAdaptiveMutationSVG({
      rows: [],
      heldOutScore: 0,
      wallClockMs: 0,
      generations: 0,
      solved: false,
    })
  );
});

Deno.test("DEFAULT_ADAPTIVE_MUTATION_CONFIG - has audit-policy stop conditions", () => {
  assertEquals(DEFAULT_ADAPTIVE_MUTATION_CONFIG.timeoutMinutes, 5);
  assertGreater(DEFAULT_ADAPTIVE_MUTATION_CONFIG.targetError, 0);
  assertLessOrEqual(DEFAULT_ADAPTIVE_MUTATION_CONFIG.targetError, 0.1);
  assertGreater(DEFAULT_ADAPTIVE_MUTATION_CONFIG.populationSize, 1);
  assertGreater(DEFAULT_ADAPTIVE_MUTATION_CONFIG.maxIterations, 0);
});
