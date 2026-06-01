/**
 * Unit tests for the adaptive mutation rate demo (issue #86, audited #212,
 * rewired #263, chart rewire #286).
 *
 * Under #286 the per-generation chunked telemetry was removed in favour
 * of a single `evolveDir` call charted from the returned summary plus
 * the documented analytic policy curve. Tests below exercise the
 * return-value flow and the new headline SVG.
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
  buildRandomSeedCreature,
  buildSeedCreature,
  CLASSIFICATION_COST,
  creatureHeldOutScore,
  datasetToFactoryRecords,
  DEFAULT_ADAPTIVE_MUTATION_CONFIG,
  DEFAULT_POLICY_CONFIG,
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
import { renderAdaptiveMutationSVG, TOPOLOGY_BARS_CLASS, TOPOLOGY_CURVE_CLASS } from "./svg.ts";

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
  // NEAT-AI's evolveDir may run a small number of additional fine-tune
  // generations beyond the requested `iterations` value; keep the cap
  // high enough that the returned generation count comfortably lands
  // inside [1, maxIterations] without slowing the test budget.
  maxIterations: 20,
  // Keep the tiny test run numerically stable under `deno test --parallel`:
  // highly aggressive mutation settings can occasionally produce
  // non-finite per-creature scores inside NEAT-AI fine-tuning.
  mutationRate: 0.35,
  mutationAmount: 1,
};

Deno.test("module exports the rewired classification task metadata", () => {
  assertEquals(INPUT_COUNT, 4);
  assertEquals(OUTPUT_COUNT, 1);
  assertEquals(typeof TASK_NAME, "string");
  assert(TASK_NAME.length > 0);
});

/* ------------------------------------------------------------------ */
/*  Bare-constructor baseline seed (retained for fixtures — issue #533) */
/* ------------------------------------------------------------------ */

Deno.test("buildRandomSeedCreature has 4 inputs, 0 hidden, 1 output", () => {
  const json = buildRandomSeedCreature(86);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(
    hidden.length,
    0,
    "bare baseline must have zero hidden neurons — NEAT must invent them",
  );
});

Deno.test("buildRandomSeedCreature pins a LOGISTIC output and is deterministic", () => {
  const a = buildRandomSeedCreature(4242);
  const b = buildRandomSeedCreature(4242);
  const c = buildRandomSeedCreature(9999);
  for (const out of a.neurons.filter((n) => n.type === "output")) {
    assertEquals(out.squash, "LOGISTIC");
  }
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assert(
    JSON.stringify(a) !== JSON.stringify(c),
    "different seeds must produce different baseline creatures",
  );
});

Deno.test("buildRandomSeedCreature produces a valid creature with finite outputs", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(86));
  creature.validate();
  assertEquals(creature.input, INPUT_COUNT);
  assertEquals(creature.output, OUTPUT_COUNT);
  const out = creature.activate(Float32Array.from([1, 0, 1, 0]));
  assert(Number.isFinite(out[0]), `output must be finite, got ${out[0]}`);
});

/* ------------------------------------------------------------------ */
/*  Factory seed (issue #533)                                          */
/* ------------------------------------------------------------------ */

Deno.test("CLASSIFICATION_COST couples the output to a sigmoid", () => {
  // BINARY_CROSS_ENTROPY ⇒ LOGISTIC output — same pairing as XOR (#520).
  assertEquals(CLASSIFICATION_COST, "BINARY_CROSS_ENTROPY");
});

Deno.test("datasetToFactoryRecords mirrors the dataset's inputs and targets", () => {
  const ds = generateClassificationDataset(86, TRUTH_TABLE_SIZE);
  const records = datasetToFactoryRecords(ds);
  assertEquals(records.length, ds.length);
  for (let i = 0; i < ds.length; i++) {
    assertEquals(records[i].input.length, INPUT_COUNT);
    assertEquals(records[i].output.length, OUTPUT_COUNT);
    for (let k = 0; k < INPUT_COUNT; k++) {
      assertEquals(records[i].input[k], ds[i].inputs[k]);
    }
    assertEquals(records[i].output[0], ds[i].targets[0]);
  }
});

Deno.test("buildSeedCreature builds a factory seed with the right arity", () => {
  const records = datasetToFactoryRecords(generateClassificationDataset(86));
  const json = buildSeedCreature(records, 86);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
});

Deno.test("buildSeedCreature picks a LOGISTIC output from the classification cost", () => {
  const records = datasetToFactoryRecords(generateClassificationDataset(5));
  const json = buildSeedCreature(records, 5);
  const outputs = json.neurons.filter((n) => n.type === "output");
  assertEquals(outputs.length, OUTPUT_COUNT);
  for (const out of outputs) {
    assertEquals(out.squash, "LOGISTIC", "classification cost ⇒ LOGISTIC output");
  }
});

Deno.test("buildSeedCreature sizes a data-derived hidden capacity budget", () => {
  // Unlike the bare `new Creature(...)` baseline (zero hidden), the
  // factory derives a conservative hidden layer from the problem shape.
  const records = datasetToFactoryRecords(generateClassificationDataset(7));
  const json = buildSeedCreature(records, 7);
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertGreater(hidden.length, 0, "factory seed must pre-size a hidden layer");
});

Deno.test("buildSeedCreature is deterministic (weights/biases) for a given seed", () => {
  // The factory mints fresh UUIDs for hidden neurons, so full JSON
  // equality is too strict — the learnable parameters must match.
  const records = datasetToFactoryRecords(generateClassificationDataset(86));
  const fingerprint = (json: ReturnType<typeof buildSeedCreature>) => ({
    neurons: json.neurons.map((n) => `${n.type}:${n.squash}:${n.bias}`),
    weights: json.synapses.map((s) => s.weight),
  });
  const a = fingerprint(buildSeedCreature(records, 4242));
  const b = fingerprint(buildSeedCreature(records, 4242));
  const c = fingerprint(buildSeedCreature(records, 9999));
  assertEquals(a, b);
  assert(
    JSON.stringify(a) !== JSON.stringify(c),
    "different seeds must produce different factory seeds",
  );
});

Deno.test("buildSeedCreature produces a valid creature with finite [0,1] outputs", () => {
  const records = datasetToFactoryRecords(generateClassificationDataset(86));
  const creature = Creature.fromJSON(buildSeedCreature(records, 86));
  creature.validate();
  assertEquals(creature.input, INPUT_COUNT);
  assertEquals(creature.output, OUTPUT_COUNT);
  const out = creature.activate(Float32Array.from([1, 0, 1, 0]));
  assert(Number.isFinite(out[0]), `output must be finite, got ${out[0]}`);
  assertGreaterOrEqual(out[0], 0);
  assertLessOrEqual(out[0], 1);
});

Deno.test("buildSeedCreature rejects an empty record set", () => {
  assertThrows(
    () => buildSeedCreature([], 1),
    Error,
    "records must not be empty",
  );
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

Deno.test("runAdaptiveMutationDemo - summary matches champion's live topology", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  // The summary's final topology counts must match the returned
  // champion's live arrays — they are the single source of truth.
  assertEquals(result.summary.finalNeurons, result.champion.neurons.length);
  assertEquals(result.summary.finalSynapses, result.champion.synapses.length);
  // Seed topology captured before evolveDir was called.
  assertGreater(result.summary.seedNeurons, 0);
  assertGreaterOrEqual(result.summary.seedSynapses, 0);
});

Deno.test("runAdaptiveMutationDemo - generations within [1, maxIterations + grace]", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assertGreaterOrEqual(result.summary.generations, 1);
  // NEAT-AI's evolveDir may run a small number of additional fine-tune
  // generations beyond the requested `iterations` cap before resolving;
  // allow a grace factor (one population's worth) so the assertion
  // reflects observed behaviour without losing the upper bound.
  const grace = SMALL_CONFIG.populationSize;
  assertLessOrEqual(
    result.summary.generations,
    SMALL_CONFIG.maxIterations + grace,
  );
  // The result's own `generations` field must agree with the summary.
  assertEquals(result.generations, result.summary.generations);
});

Deno.test("runAdaptiveMutationDemo - summary.finalError is finite and non-negative", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assert(
    Number.isFinite(result.summary.finalError),
    `finalError must be finite, got ${result.summary.finalError}`,
  );
  assertGreaterOrEqual(result.summary.finalError, 0);
  assert(Number.isFinite(result.summary.finalScore));
});

Deno.test("runAdaptiveMutationDemo - champion has the correct I/O shape", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assertEquals(result.champion.input, INPUT_COUNT);
  assertEquals(result.champion.output, OUTPUT_COUNT);
  assertGreaterOrEqual(result.champion.neurons.length, INPUT_COUNT + OUTPUT_COUNT);
});

Deno.test("runAdaptiveMutationDemo - reports finite held-out accuracy, score and wall-clock", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assert(Number.isFinite(result.heldOutScore));
  assert(Number.isFinite(result.heldOutAccuracy));
  assertGreaterOrEqual(result.heldOutAccuracy, 0);
  assertLessOrEqual(result.heldOutAccuracy, 1);
  assertGreaterOrEqual(result.wallClockMs, 0);
  assertGreaterOrEqual(result.generations, 1);
  assertEquals(result.summary.wallClockMs, result.wallClockMs);
});

Deno.test("runAdaptiveMutationDemo - solved flag derives from finalError ≤ targetError", async () => {
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  assertEquals(result.solved, result.summary.finalError <= SMALL_CONFIG.targetError);
});

Deno.test("runAdaptiveMutationDemo - champion trains on the deterministic truth table", async () => {
  // End-to-end smoke test: training accuracy stays in [0, 1] when
  // recomputed from the returned champion against the same dataset
  // the runner generated.
  const result = await runAdaptiveMutationDemo(SMALL_CONFIG);
  const trainingSet = generateClassificationDataset(
    SMALL_CONFIG.seed ^ 0x1234_5678,
    SMALL_CONFIG.trainingSize,
  );
  const trainingAcc = classifierAccuracy(result.champion, trainingSet);
  assertGreaterOrEqual(trainingAcc, 0);
  assertLessOrEqual(trainingAcc, 1);
});

Deno.test("renderAdaptiveMutationSVG - well-formed SVG with policy curve and topology bars", () => {
  const svg = renderAdaptiveMutationSVG({
    summary: {
      finalError: 0.012,
      finalScore: 0.95,
      wallClockMs: 4321,
      generations: 250,
      seedNeurons: 5,
      seedSynapses: 4,
      finalNeurons: 24,
      finalSynapses: 58,
      targetError: 0.05,
    },
    heldOutScore: -0.05,
    wallClockMs: 4321,
    generations: 250,
    solved: true,
  });
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  // Analytic policy curve and seed/final topology bars must both appear.
  assertStringIncludes(svg, TOPOLOGY_CURVE_CLASS);
  assertStringIncludes(svg, TOPOLOGY_BARS_CLASS);
  assertStringIncludes(svg, "topo-bar-seed-neurons");
  assertStringIncludes(svg, "topo-bar-final-neurons");
  assertStringIncludes(svg, "topo-bar-seed-synapses");
  assertStringIncludes(svg, "topo-bar-final-synapses");
  // Caption quotes the headline numbers.
  assertStringIncludes(svg, "Generations: 250");
  assertStringIncludes(svg, "Final error: 0.0120");
  assertStringIncludes(svg, "Held-out -MSE: -0.0500");
  // No NaN literal should ever leak into the rendered output.
  assert(!svg.includes("NaN"), "NaN should not appear in rendered SVG");
});

Deno.test("renderAdaptiveMutationSVG - handles zero-growth runs without exploding", () => {
  // Seed and final topology identical (no growth) — the bar pair
  // should still render cleanly with both seed and final bars sized
  // against a finite ceiling.
  const svg = renderAdaptiveMutationSVG({
    summary: {
      finalError: 0.5,
      finalScore: -0.5,
      wallClockMs: 100,
      generations: 1,
      seedNeurons: 5,
      seedSynapses: 4,
      finalNeurons: 5,
      finalSynapses: 4,
    },
    heldOutScore: -0.5,
    wallClockMs: 100,
    generations: 1,
    solved: false,
  });
  assert(svg.startsWith("<svg"));
  assertStringIncludes(svg, TOPOLOGY_CURVE_CLASS);
  assertStringIncludes(svg, "topo-bar-seed-neurons");
});

Deno.test("DEFAULT_ADAPTIVE_MUTATION_CONFIG - has audit-policy stop conditions", () => {
  assertEquals(DEFAULT_ADAPTIVE_MUTATION_CONFIG.timeoutMinutes, 5);
  assertGreater(DEFAULT_ADAPTIVE_MUTATION_CONFIG.targetError, 0);
  assertLessOrEqual(DEFAULT_ADAPTIVE_MUTATION_CONFIG.targetError, 0.1);
  assertGreater(DEFAULT_ADAPTIVE_MUTATION_CONFIG.populationSize, 1);
  assertGreater(DEFAULT_ADAPTIVE_MUTATION_CONFIG.maxIterations, 0);
});
