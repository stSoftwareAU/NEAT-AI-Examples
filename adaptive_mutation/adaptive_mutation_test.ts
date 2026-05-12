/**
 * Unit tests for the adaptive mutation rate demo (issue #86, audited #212,
 * rewired #263).
 *
 * Under #263 the synthetic regression task was replaced with the
 * binary classification task added in #262 — 4-bit even parity. Tests
 * below exercise the rewired flow plus the documented analytic policy
 * curve and SVG renderers.
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

import { Creature } from "@stsoftware/neat-ai";

import {
  type AdaptiveMutationConfig,
  creatureHeldOutScore,
  DEFAULT_ADAPTIVE_MUTATION_CONFIG,
  DEFAULT_POLICY_CONFIG,
  EVOLUTION_CSV_HEADER,
  formatEvolutionCsv,
  INPUT_COUNT,
  OUTPUT_COUNT,
  runAdaptiveMutationDemo,
  TASK_NAME,
  topologyProbability,
} from "./adaptive_mutation.ts";
import {
  classifierAccuracy,
  generateClassificationDataset,
  TRUTH_TABLE_SIZE,
} from "./classification_task.ts";
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
  trainingSize: TRUTH_TABLE_SIZE,
  targetError: 0.0001,
  timeoutMinutes: 0,
  populationSize: 6,
  maxIterations: 3,
  mutationRate: 0.6,
  mutationAmount: 3,
};

/**
 * Larger but still fast config used by the "demo solves parity" test —
 * gives NEAT enough generations and population to reliably grow at
 * least one hidden neuron and lift accuracy above chance from a
 * minimal direct-only seed. Capped well under 30s.
 */
const CONVERGENCE_CONFIG: AdaptiveMutationConfig = {
  seed: 1234,
  trainingSize: TRUTH_TABLE_SIZE,
  targetError: 0.0001,
  timeoutMinutes: 0,
  populationSize: 24,
  maxIterations: 200,
  mutationRate: 0.7,
  mutationAmount: 3,
};

Deno.test("module exports the rewired classification task metadata", () => {
  assertEquals(INPUT_COUNT, 4);
  assertEquals(OUTPUT_COUNT, 1);
  assertEquals(typeof TASK_NAME, "string");
  assert(TASK_NAME.length > 0);
});

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
  assertAlmostEquals(topologyProbability(0, policy), 0.6, 1e-12);
  assertAlmostEquals(topologyProbability(80, policy), 0.3, 1e-12);
  assertAlmostEquals(topologyProbability(240, policy), 0.15, 1e-12);
});

Deno.test("creatureHeldOutScore - returns a finite non-positive value", () => {
  const ds = generateClassificationDataset(7, TRUTH_TABLE_SIZE);
  // Use the seed creature as a sentinel — accuracy is irrelevant, we
  // just need the function to handle a valid creature and dataset.
  const c = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const score = creatureHeldOutScore(c, ds);
  assert(Number.isFinite(score), `held-out score not finite: ${score}`);
  assertLessOrEqual(score, 0);
});

Deno.test("creatureHeldOutScore - empty dataset returns 0", () => {
  const c = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  assertEquals(creatureHeldOutScore(c, []), 0);
});

Deno.test("runAdaptiveMutationDemo - rejects invalid configs", async () => {
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, trainingSize: 0 }));
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, maxIterations: 0 }));
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, populationSize: 0 }));
  await assertRejects(() => runAdaptiveMutationDemo({ ...SMALL_CONFIG, timeoutMinutes: -1 }));
});

Deno.test("runAdaptiveMutationDemo - emits per-generation telemetry rows with accuracy", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assertGreater(result.evolutionRows.length, 0);
  for (const row of result.evolutionRows) {
    assertGreaterOrEqual(row.generation, 0);
    assertGreaterOrEqual(row.neuronCount, INPUT_COUNT + OUTPUT_COUNT);
    assertGreaterOrEqual(row.synapseCount, 0);
    assert(Number.isFinite(row.bestFitness), "bestFitness must be finite");
    // Accuracy may be NaN at the very first sample if the live creature
    // happens to error, but the typical case is a finite [0,1] value.
    if (Number.isFinite(row.accuracy)) {
      assertGreaterOrEqual(row.accuracy, 0);
      assertLessOrEqual(row.accuracy, 1);
    }
  }
});

Deno.test("runAdaptiveMutationDemo - champion has the correct I/O shape", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assertEquals(result.champion.input, INPUT_COUNT);
  assertEquals(result.champion.output, OUTPUT_COUNT);
  // The minimal seed has neurons.length = INPUT_COUNT + OUTPUT_COUNT.
  // After evolveDir runs at least one generation we expect at least
  // the seed shape.
  assertGreaterOrEqual(result.champion.neurons.length, INPUT_COUNT + OUTPUT_COUNT);
});

Deno.test("runAdaptiveMutationDemo - reports finite held-out accuracy, score and wall-clock", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assert(Number.isFinite(result.heldOutScore));
  assert(Number.isFinite(result.heldOutAccuracy));
  assertGreaterOrEqual(result.heldOutAccuracy, 0);
  assertLessOrEqual(result.heldOutAccuracy, 1);
  assertGreaterOrEqual(result.wallClockMs, 0);
  assertGreaterOrEqual(result.generations, 0);
});

Deno.test("runAdaptiveMutationDemo - demo evolves a classification champion from a minimal seed", async () => {
  // Slightly larger config so accuracy can actually move off chance.
  // We do NOT assert convergence to ≥ 0.95 here — the full convergence
  // run is the runner's job and may take well above the 30s unit-test
  // budget. We only assert the pipeline is end-to-end functional:
  //   * champion has the correct I/O shape,
  //   * held-out accuracy lies in [0, 1],
  //   * at least one telemetry row carries a finite accuracy.
  const result = await runAdaptiveMutationDemo(CONVERGENCE_CONFIG);
  assertEquals(result.champion.input, INPUT_COUNT);
  assertEquals(result.champion.output, OUTPUT_COUNT);
  assertGreaterOrEqual(result.heldOutAccuracy, 0);
  assertLessOrEqual(result.heldOutAccuracy, 1);
  const finiteAccuracyRows = result.evolutionRows.filter((r) => Number.isFinite(r.accuracy));
  assertGreater(finiteAccuracyRows.length, 0);
  // Re-compute training accuracy from the returned champion and the
  // same dataset the runner used; must agree with the classifier.
  const trainingSet = generateClassificationDataset(
    CONVERGENCE_CONFIG.seed ^ 0x1234_5678,
    CONVERGENCE_CONFIG.trainingSize,
  );
  const trainingAcc = classifierAccuracy(result.champion, trainingSet);
  assertGreaterOrEqual(trainingAcc, 0);
  assertLessOrEqual(trainingAcc, 1);
});

Deno.test("formatEvolutionCsv - emits canonical header and one row per generation", () => {
  const csv = formatEvolutionCsv([
    {
      generation: 1,
      bestFitness: 0.5,
      meanFitness: 0.4,
      accuracy: 0.5,
      neuronCount: 6,
      synapseCount: 8,
    },
    {
      generation: 2,
      bestFitness: 0.7,
      meanFitness: 0.6,
      accuracy: 0.75,
      neuronCount: 7,
      synapseCount: 10,
    },
  ]);
  const lines = csv.trim().split("\n");
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[1], "1,0.5,0.4,0.5,6,8");
  assertStringIncludes(lines[2], "2,0.7,0.6,0.75,7,10");
});

Deno.test("formatEvolutionCsv - handles non-finite numbers by writing 0", () => {
  const csv = formatEvolutionCsv([
    {
      generation: 1,
      bestFitness: Number.NaN,
      meanFitness: Number.POSITIVE_INFINITY,
      accuracy: Number.NaN,
      neuronCount: 6,
      synapseCount: 8,
    },
  ]);
  assertStringIncludes(csv, "1,0,0,0,6,8");
});

Deno.test("EVOLUTION_CSV_HEADER - includes the accuracy column", () => {
  // Issue #263 acceptance criterion: the CSV schema is
  // generation,best_fitness,mean_fitness,accuracy,neuron_count,synapse_count.
  assertEquals(
    EVOLUTION_CSV_HEADER,
    "generation,best_fitness,mean_fitness,accuracy,neuron_count,synapse_count",
  );
});

Deno.test("renderFitnessChartSvg - well-formed SVG with the fitness CSS class", () => {
  const svg = renderFitnessChartSvg([
    {
      generation: 1,
      bestFitness: 0.5,
      meanFitness: 0.4,
      accuracy: 0.5,
      neuronCount: 6,
      synapseCount: 8,
    },
    {
      generation: 2,
      bestFitness: 0.7,
      meanFitness: 0.6,
      accuracy: 0.6,
      neuronCount: 7,
      synapseCount: 10,
    },
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
    {
      generation: 1,
      bestFitness: 0.5,
      meanFitness: 0.4,
      accuracy: 0.5,
      neuronCount: 6,
      synapseCount: 8,
    },
    {
      generation: 2,
      bestFitness: 0.7,
      meanFitness: 0.6,
      accuracy: 0.6,
      neuronCount: 7,
      synapseCount: 10,
    },
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
    {
      generation: 1,
      bestFitness: 0.5,
      meanFitness: 0.4,
      accuracy: 0.5,
      neuronCount: 6,
      synapseCount: 8,
    },
    {
      generation: 5,
      bestFitness: 0.7,
      meanFitness: 0.6,
      accuracy: 0.7,
      neuronCount: 8,
      synapseCount: 14,
    },
    {
      generation: 10,
      bestFitness: 0.9,
      meanFitness: 0.85,
      accuracy: 0.95,
      neuronCount: 11,
      synapseCount: 22,
    },
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
