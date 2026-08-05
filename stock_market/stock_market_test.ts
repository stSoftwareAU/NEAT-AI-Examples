/**
 * Unit tests for the stock-market direction-prediction example
 * (audit issue #218, telemetry rewired under #301, multi-run wiring
 * under #328). "What" tests only — each test calls a real function with
 * deterministic data and asserts on the observable outputs (file
 * contents, accuracy floor, SVG structure, signal records, multi-run
 * resume semantics).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertRejects,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { appendMultiRunRun, loadMultiRunState } from "../common/multi_run_state.ts";
import {
  buildSamples,
  computeNormalizationStats,
  normalizeSamples,
  splitChronologically,
} from "./data.ts";
import {
  balancedDirectionalAccuracy,
  buildRandomSeedCreature,
  buildSeedCreature,
  classifyGlyph,
  cumulativeStrategyReturn,
  DEFAULT_EVOLVE_OPTIONS,
  directionalAccuracy,
  evolveResultToMultiRunSample,
  evolveStockController,
  EXAMPLE_SLUG,
  INPUT_COUNT,
  loadPrices,
  OUTPUT_COUNT,
  predictionFromOutput,
  readTrainingRecords,
  replayController,
  runMultiRunStock,
  WINDOW_SIZE,
  writeStockTrainingDataset,
} from "./stock_market.ts";
import { renderChartSVG } from "./svg.ts";

/**
 * Build a deterministic synthetic price fixture: a noisy series with a
 * small positive drift. Long enough for a 70/15/15 split with
 * windowSize=5 and still yield a non-trivial number of samples.
 */
function syntheticPrices(n: number, seed = 1): { date: string; close: number }[] {
  const rng = createDeterministicRandom(seed);
  const points: { date: string; close: number }[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    points.push({ date: `2020-01-${(i + 1).toString().padStart(2, "0")}`, close: p });
    const shock = (rng() - 0.45) * 0.04;
    p = Math.max(1, p * (1 + shock));
  }
  return points;
}

Deno.test("buildRandomSeedCreature has WINDOW_SIZE inputs and 1 output", () => {
  const json = buildRandomSeedCreature(12345);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(hidden.length, 0, "random seed must have zero hidden neurons");
});

Deno.test("buildRandomSeedCreature pins the output activation to LOGISTIC", () => {
  const json = buildRandomSeedCreature(5, WINDOW_SIZE);
  const outputs = json.neurons.filter((n) => n.type === "output");
  assertEquals(outputs.length, OUTPUT_COUNT);
  for (const out of outputs) {
    assertEquals(out.squash, "LOGISTIC");
  }
});

Deno.test("buildRandomSeedCreature is deterministic for a given seed", () => {
  const a = buildRandomSeedCreature(4242);
  const b = buildRandomSeedCreature(4242);
  const c = buildRandomSeedCreature(9999);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assert(
    JSON.stringify(a) !== JSON.stringify(c),
    "different seeds must produce different random creatures",
  );
});

Deno.test("buildRandomSeedCreature produces a valid creature with finite outputs", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(7));
  creature.validate();
  assertEquals(creature.input, INPUT_COUNT);
  assertEquals(creature.output, OUTPUT_COUNT);
  creature.clearState();
  const out = creature.activate(Float32Array.from(new Array(WINDOW_SIZE).fill(0)));
  assertEquals(out.length, OUTPUT_COUNT);
  assert(Number.isFinite(out[0]));
});

/* ------------------------------------------------------------------ */
/*  Factory seed (issue #519)                                          */
/* ------------------------------------------------------------------ */

/** Synthetic factory records: `windowSize` features + one regression target. */
function syntheticRecords(
  count: number,
  windowSize: number,
): { input: Float32Array; output: Float32Array }[] {
  const recs: { input: Float32Array; output: Float32Array }[] = [];
  for (let i = 0; i < count; i++) {
    const input = new Float32Array(windowSize);
    for (let j = 0; j < windowSize; j++) input[j] = Math.sin(i * 0.2 + j) * 0.02;
    // Up-skewed target mean (~0.66) so the bias warm-start is observable.
    recs.push({ input, output: Float32Array.from([i % 3 === 0 ? 0 : 1]) });
  }
  return recs;
}

Deno.test("buildSeedCreature builds a factory seed with the right arity", () => {
  const json = buildSeedCreature(syntheticRecords(140, WINDOW_SIZE), 12345, WINDOW_SIZE);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
});

Deno.test("buildSeedCreature sizes a data-derived hidden capacity budget", () => {
  // Unlike the bare `new Creature(...)` seed (zero hidden), the factory
  // derives a conservative hidden-layer budget from the problem shape.
  const json = buildSeedCreature(syntheticRecords(140, WINDOW_SIZE), 7, WINDOW_SIZE);
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertGreater(hidden.length, 0, "factory seed must pre-size a hidden layer");
});

Deno.test("buildSeedCreature picks a linear (regression) output activation", () => {
  const json = buildSeedCreature(syntheticRecords(140, WINDOW_SIZE), 5, WINDOW_SIZE);
  const outputs = json.neurons.filter((n) => n.type === "output");
  assertEquals(outputs.length, OUTPUT_COUNT);
  for (const out of outputs) {
    assertEquals(out.squash, "IDENTITY", "regression cost ⇒ linear output");
  }
});

Deno.test("buildSeedCreature warm-starts the output bias to the target mean", () => {
  const records = syntheticRecords(150, WINDOW_SIZE);
  let sum = 0;
  for (const r of records) sum += r.output[0];
  const mean = sum / records.length;
  const json = buildSeedCreature(records, 3, WINDOW_SIZE);
  const out = json.neurons.find((n) => n.type === "output");
  assert(out !== undefined);
  assertAlmostEquals(out!.bias ?? 0, mean, 1e-3, "output bias should equal the target mean");
});

Deno.test("buildSeedCreature is deterministic (weights/biases) for a given seed", () => {
  // The factory mints fresh random UUIDs for hidden neurons, so full
  // JSON equality is too strict. The meaningful invariant is that the
  // learnable parameters (topology shape, biases, squashes, weights) are
  // identical for a fixed seed.
  const records = syntheticRecords(120, WINDOW_SIZE);
  const fingerprint = (json: ReturnType<typeof buildSeedCreature>) => ({
    neurons: json.neurons.map((n) => `${n.type}:${n.squash}:${n.bias}`),
    weights: json.synapses.map((s) => s.weight),
  });
  const a = fingerprint(buildSeedCreature(records, 4242, WINDOW_SIZE));
  const b = fingerprint(buildSeedCreature(records, 4242, WINDOW_SIZE));
  assertEquals(a, b);
});

Deno.test("buildSeedCreature produces a valid creature with finite outputs", () => {
  const creature = Creature.fromJSON(
    buildSeedCreature(syntheticRecords(120, WINDOW_SIZE), 7, WINDOW_SIZE),
  );
  creature.validate();
  creature.clearState();
  const out = creature.activate(Float32Array.from(new Array(WINDOW_SIZE).fill(0)));
  assertEquals(out.length, OUTPUT_COUNT);
  assert(Number.isFinite(out[0]));
});

Deno.test("buildSeedCreature throws on an empty record set", () => {
  let threw = false;
  try {
    buildSeedCreature([], 1, WINDOW_SIZE);
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for empty records");
});

Deno.test("readTrainingRecords round-trips a written .bin into factory records", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_records_" });
  try {
    const prices = syntheticPrices(80, 7);
    const samples = buildSamples(prices, { windowSize: 5 });
    const stats = computeNormalizationStats(samples);
    const normalized = normalizeSamples(samples, stats);
    writeStockTrainingDataset(normalized, tmp, 5);
    const records = readTrainingRecords(tmp, 5);
    assertEquals(records.length, normalized.length);
    for (let i = 0; i < records.length; i++) {
      assertEquals(records[i].input.length, 5);
      assertEquals(records[i].output.length, OUTPUT_COUNT);
      for (let j = 0; j < 5; j++) {
        assertAlmostEquals(records[i].input[j], normalized[i].features[j], 1e-6);
      }
      assertAlmostEquals(records[i].output[0], normalized[i].label, 1e-6);
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("evolveStockController seeds via the factory when not resuming", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_factory_seed_" });
  try {
    const prices = syntheticPrices(200, 5);
    const samples = buildSamples(prices, { windowSize: 5 });
    const split = splitChronologically(samples, {
      trainFraction: 0.7,
      validationFraction: 0.15,
    });
    const stats = computeNormalizationStats(split.train);
    writeStockTrainingDataset(normalizeSamples(split.train, stats), tmp, 5);
    const result = await evolveStockController({
      ...DEFAULT_EVOLVE_OPTIONS,
      windowSize: 5,
      seed: 1,
      populationSize: 4,
      maxGenerations: 2,
      errorThreshold: 0,
      timeoutMinutes: 0,
      dataDir: tmp,
    });
    // The factory seed carries a pre-sized hidden layer, so it has more
    // than the single output neuron a bare `new Creature(5, 1)` would.
    assertGreater(result.seedNeurons, OUTPUT_COUNT);
    assertGreater(result.seedSynapses, 0);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeStockTrainingDataset writes one record per sample", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_data_" });
  try {
    const prices = syntheticPrices(40, 7);
    const samples = buildSamples(prices, { windowSize: 5 });
    const path = writeStockTrainingDataset(samples, tmp, 5);
    assertEquals(existsSync(path), true);
    const bytes = Deno.readFileSync(path);
    const stride = 5 + OUTPUT_COUNT;
    assertEquals(bytes.length, samples.length * stride * 4);
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, samples.length * stride);
    for (let i = 0; i < samples.length; i++) {
      for (let j = 0; j < 5; j++) {
        assertAlmostEquals(view[i * stride + j], samples[i].features[j], 1e-6);
      }
      assertEquals(view[i * stride + 5], samples[i].label);
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeStockTrainingDataset throws on empty samples", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_data_empty_" });
  try {
    let threw = false;
    try {
      writeStockTrainingDataset([], tmp);
    } catch (_err) {
      threw = true;
    }
    assert(threw, "expected an error for empty samples");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeStockTrainingDataset rejects samples with wrong feature length", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_data_wrongsize_" });
  try {
    let threw = false;
    try {
      writeStockTrainingDataset(
        [{ index: 0, date: "x", features: [1, 2], label: 1, return: 0.01, close: 100 }],
        tmp,
        5,
      );
    } catch (_err) {
      threw = true;
    }
    assert(threw, "expected an error when features.length !== windowSize");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("predictionFromOutput thresholds at 0.5", () => {
  assertEquals(predictionFromOutput(0.49), 0);
  assertEquals(predictionFromOutput(0.5), 1);
  assertEquals(predictionFromOutput(0.99), 1);
  assertEquals(predictionFromOutput(0.0), 0);
});

Deno.test("directionalAccuracy returns the fraction of correct predictions", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(42, 3));
  creature.clearState();
  const probe = creature.activate(Float32Array.from([0.1, -0.2, 0.05]));
  const predicted: 0 | 1 = predictionFromOutput(probe[0]);
  const flipped: 0 | 1 = predicted === 1 ? 0 : 1;
  const features = [0.1, -0.2, 0.05];
  const samples = [
    { index: 0, date: "a", features, label: predicted, return: 0.1, close: 1 },
    { index: 1, date: "b", features, label: predicted, return: 0.1, close: 1 },
    { index: 2, date: "c", features, label: predicted, return: 0.1, close: 1 },
    { index: 3, date: "d", features, label: flipped, return: 0.1, close: 1 },
  ];
  const acc = directionalAccuracy(creature, samples);
  assertAlmostEquals(acc, 0.75, 1e-6);
});

Deno.test("directionalAccuracy returns 0 on an empty sample list", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(1, 2));
  assertEquals(directionalAccuracy(creature, []), 0);
});

Deno.test("balancedDirectionalAccuracy scores 0.5 for a constant predictor on biased data", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(42, 3));
  creature.clearState();
  const probe = creature.activate(Float32Array.from([0, 0, 0]));
  const constantPrediction: 0 | 1 = predictionFromOutput(probe[0]);
  const features = [0, 0, 0];
  const samples = [];
  for (let i = 0; i < 8; i++) {
    samples.push({
      index: i,
      date: `2020-01-${String(i + 1).padStart(2, "0")}`,
      features,
      label: constantPrediction,
      return: 0.01,
      close: 1,
    });
  }
  for (let i = 0; i < 2; i++) {
    samples.push({
      index: 8 + i,
      date: `2020-02-${String(i + 1).padStart(2, "0")}`,
      features,
      label: (constantPrediction === 1 ? 0 : 1) as 0 | 1,
      return: -0.01,
      close: 1,
    });
  }
  const balanced = balancedDirectionalAccuracy(creature, samples);
  assertAlmostEquals(balanced, 0.5, 1e-6);
});

Deno.test("balancedDirectionalAccuracy returns 0 on an empty sample list", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(1, 2));
  assertEquals(balancedDirectionalAccuracy(creature, []), 0);
});

Deno.test("DEFAULT_EVOLVE_OPTIONS has the audit-mandated stop conditions", () => {
  assertGreater(DEFAULT_EVOLVE_OPTIONS.errorThreshold, 0);
  assertGreater(1, DEFAULT_EVOLVE_OPTIONS.errorThreshold);
  assertEquals(
    DEFAULT_EVOLVE_OPTIONS.timeoutMinutes,
    5,
    "timeoutMinutes must default to the issue #218 backstop",
  );
  assertGreater(DEFAULT_EVOLVE_OPTIONS.maxGenerations, 0);
  assert(Number.isFinite(DEFAULT_EVOLVE_OPTIONS.maxGenerations));
  assertEquals(DEFAULT_EVOLVE_OPTIONS.windowSize, WINDOW_SIZE);
});

Deno.test(
  "evolveStockController returns finite seed and wall-clock fields on the result",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "stock_evolve_" });
    try {
      const prices = syntheticPrices(200, 5);
      const samples = buildSamples(prices, { windowSize: 5 });
      const split = splitChronologically(samples, {
        trainFraction: 0.7,
        validationFraction: 0.15,
      });
      writeStockTrainingDataset(split.train, tmp, 5);
      const result = await evolveStockController({
        ...DEFAULT_EVOLVE_OPTIONS,
        windowSize: 5,
        seed: 1,
        populationSize: 6,
        maxGenerations: 3,
        errorThreshold: 0,
        timeoutMinutes: 0,
        dataDir: tmp,
      });
      assert(Number.isFinite(result.bestError));
      assert(Number.isFinite(result.bestFitness));
      assert(Number.isFinite(result.wallClockMs));
      assertGreaterOrEqual(result.wallClockMs, 0);
      assert(Number.isInteger(result.generations));
      assertGreaterOrEqual(result.generations, 1);
      assertGreater(result.seedNeurons, 0);
      assertGreaterOrEqual(result.seedSynapses, 0);
      assertGreater(result.champion.neurons.length, 0);
      assertGreaterOrEqual(result.champion.synapses.length, 0);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveStockController honours the hard generation cap when the threshold is unreachable",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "stock_evolve_cap_" });
    try {
      const prices = syntheticPrices(120, 99);
      const samples = buildSamples(prices, { windowSize: 5 });
      const split = splitChronologically(samples, {
        trainFraction: 0.7,
        validationFraction: 0.15,
      });
      writeStockTrainingDataset(split.train, tmp, 5);
      const result = await evolveStockController({
        ...DEFAULT_EVOLVE_OPTIONS,
        windowSize: 5,
        seed: 999,
        populationSize: 4,
        maxGenerations: 2,
        errorThreshold: 0, // unreachable
        timeoutMinutes: 0,
        dataDir: tmp,
      });
      assertEquals(result.solved, false);
      assertGreaterOrEqual(result.generations, 1);
      assertGreaterOrEqual(20, result.generations);
      creatureActivatesFinite(result.champion);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveStockController throws when dataDir is missing",
  async () => {
    let threw = false;
    try {
      await evolveStockController({
        ...DEFAULT_EVOLVE_OPTIONS,
        windowSize: 5,
        seed: 1,
        populationSize: 4,
        maxGenerations: 2,
        errorThreshold: 0,
        timeoutMinutes: 0,
        dataDir: "",
      });
    } catch (_err) {
      threw = true;
    }
    assert(threw, "expected an error when dataDir is empty");
  },
);

Deno.test(
  "evolveResultToMultiRunSample carries error/score/topology onto the milestone shape",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "stock_sample_" });
    try {
      const prices = syntheticPrices(200, 5);
      const samples = buildSamples(prices, { windowSize: 5 });
      const split = splitChronologically(samples, {
        trainFraction: 0.7,
        validationFraction: 0.15,
      });
      writeStockTrainingDataset(split.train, tmp, 5);
      const result = await evolveStockController({
        ...DEFAULT_EVOLVE_OPTIONS,
        windowSize: 5,
        seed: 7,
        populationSize: 4,
        maxGenerations: 2,
        errorThreshold: 0,
        timeoutMinutes: 0,
        dataDir: tmp,
      });
      const sample = evolveResultToMultiRunSample(result);
      assertEquals(sample.runGen, result.generations);
      assertGreaterOrEqual(sample.error, 0);
      assertGreaterOrEqual(1, sample.error);
      assertEquals(sample.bestScore, result.bestFitness);
      assertEquals(sample.neurons, result.champion.neurons.length);
      assertEquals(sample.synapses, result.champion.synapses.length);
      assertEquals(sample.generationWallClockMs, result.wallClockMs);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test("replayController emits one record per sample with a derived `correct` flag", () => {
  const prices = syntheticPrices(60, 3);
  const samples = buildSamples(prices, { windowSize: 4 });
  const creature = Creature.fromJSON(buildRandomSeedCreature(7, 4));
  const records = replayController(creature, samples);
  assertEquals(records.length, samples.length);
  for (let i = 0; i < records.length; i++) {
    assertEquals(records[i].date, samples[i].date);
    assertEquals(records[i].close, samples[i].close);
    assertEquals(records[i].outcome, samples[i].label);
    assertEquals(records[i].correct, records[i].prediction === records[i].outcome);
  }
});

Deno.test("cumulativeStrategyReturn sums returns when prediction is up", () => {
  const records = [
    {
      date: "a",
      close: 1,
      return: 0.1,
      prediction: 1 as const,
      outcome: 1 as const,
      correct: true,
    },
    {
      date: "b",
      close: 1,
      return: -0.05,
      prediction: 0 as const,
      outcome: 0 as const,
      correct: true,
    },
    {
      date: "c",
      close: 1,
      return: 0.02,
      prediction: 1 as const,
      outcome: 1 as const,
      correct: true,
    },
    {
      date: "d",
      close: 1,
      return: -0.07,
      prediction: 1 as const,
      outcome: 0 as const,
      correct: false,
    },
  ];
  assertAlmostEquals(cumulativeStrategyReturn(records), 0.05, 1e-9);
});

Deno.test("classifyGlyph maps each prediction × outcome pair to a unique glyph", () => {
  assertEquals(classifyGlyph({ prediction: 1, outcome: 1 }), "up_hit");
  assertEquals(classifyGlyph({ prediction: 1, outcome: 0 }), "up_miss");
  assertEquals(classifyGlyph({ prediction: 0, outcome: 0 }), "down_hit");
  assertEquals(classifyGlyph({ prediction: 0, outcome: 1 }), "down_miss");
});

/**
 * Write a dataset CSV into a fresh temp dir and hand the path to `fn`,
 * cleaning up afterwards. Keeps the `loadPrices` cases below focused on
 * the observable contract (issue #742).
 */
async function withDatasetFile(
  csv: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "stock_load_prices_" });
  try {
    const path = join(dir, "prices.csv");
    await Deno.writeTextFile(path, csv);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadPrices reads a dataset file into ordered PricePoint records", async () => {
  await withDatasetFile(
    "Date,SP500\n2020-01-01,101.5\n2020-01-02,102.25\n2020-01-03,99.75\n",
    async (path) => {
      const prices = await loadPrices(path);
      assertEquals(prices.length, 3);
      assertEquals(prices.map((p) => p.date), ["2020-01-01", "2020-01-02", "2020-01-03"]);
      assertEquals(prices.map((p) => p.close), [101.5, 102.25, 99.75]);
    },
  );
});

Deno.test("loadPrices locates columns by name, not position", async () => {
  await withDatasetFile(
    "SP500,Other,Date\n101.5,x,2020-01-01\n102.25,y,2020-01-02\n",
    async (path) => {
      const prices = await loadPrices(path);
      assertEquals(prices, [
        { date: "2020-01-01", close: 101.5 },
        { date: "2020-01-02", close: 102.25 },
      ]);
    },
  );
});

Deno.test("loadPrices drops blank and unusable rows", async () => {
  await withDatasetFile(
    "Date,SP500\n2020-01-01,101.5\n\n2020-01-02,.\n2020-01-03,0\n,102.25\n2020-01-04,103\n",
    async (path) => {
      const prices = await loadPrices(path);
      assertEquals(prices, [
        { date: "2020-01-01", close: 101.5 },
        { date: "2020-01-04", close: 103 },
      ]);
    },
  );
});

Deno.test("loadPrices returns no points for a header-only or empty file", async () => {
  await withDatasetFile("Date,SP500\n", async (path) => {
    assertEquals(await loadPrices(path), []);
  });
  await withDatasetFile("", async (path) => {
    assertEquals(await loadPrices(path), []);
  });
});

Deno.test("loadPrices throws when the header lacks the required columns", async () => {
  await withDatasetFile("Date,Close\n2020-01-01,101.5\n", async (path) => {
    const error = await assertRejects(() => loadPrices(path), Error);
    assert(
      error.message.includes("SP500"),
      `expected the failure to name the missing column, got: ${error.message}`,
    );
  });
});

Deno.test("loadPrices rejects when the dataset file is missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "stock_load_prices_missing_" });
  try {
    await assertRejects(
      () => loadPrices(join(dir, "does-not-exist.csv")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderChartSVG emits an animated SVG with prediction markers in multiple colours", () => {
  const records = [
    {
      date: "2020-01-01",
      close: 100,
      prediction: 1 as const,
      outcome: 1 as const,
      correct: true,
    },
    {
      date: "2020-02-01",
      close: 110,
      prediction: 0 as const,
      outcome: 1 as const,
      correct: false,
    },
    {
      date: "2020-03-01",
      close: 105,
      prediction: 0 as const,
      outcome: 0 as const,
      correct: true,
    },
    {
      date: "2020-04-01",
      close: 95,
      prediction: 1 as const,
      outcome: 0 as const,
      correct: false,
    },
  ];
  const svg = renderChartSVG({
    records,
    glyphFor: classifyGlyph,
    validationAccuracy: 0.6,
    testAccuracy: 0.5,
    cumulativeStrategyReturn: 0.03,
  });
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 1);
  assert(svg.includes('class="price"'));
  assert(svg.includes("up_hit"));
  assert(svg.includes("down_hit"));
  assert(svg.includes("Validation accuracy"));
  assert(svg.includes("Cumulative strategy return"));
  assert(svg.includes("not investment advice"));
});

Deno.test("renderChartSVG throws on an empty record list", () => {
  let thrown: unknown = null;
  try {
    renderChartSVG({
      records: [],
      glyphFor: classifyGlyph,
      validationAccuracy: 0,
      testAccuracy: 0,
      cumulativeStrategyReturn: 0,
    });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error);
  assert((thrown as Error).message.includes("must not be empty"));
});

/* ------------------------------------------------------------------ */
/*  Local test helpers                                                 */
/* ------------------------------------------------------------------ */

function creatureActivatesFinite(creature: Creature): void {
  creature.clearState();
  const out = creature.activate(Float32Array.from(new Array(creature.input).fill(0)));
  assert(Number.isFinite(out[0]));
}

/* ------------------------------------------------------------------ */
/*  Multi-run wiring (issue #328)                                     */
/* ------------------------------------------------------------------ */

/**
 * Build a tiny synthetic stock-market binary `.bin` data directory the
 * runner can hand straight to `evolveDir`. Returns the directory path
 * so callers can pass it as `dataDir`.
 */
function buildSyntheticStockBinDir(seed = 1, count = 200): string {
  const prices = syntheticPrices(count, seed);
  const samples = buildSamples(prices, { windowSize: WINDOW_SIZE });
  const split = splitChronologically(samples, {
    trainFraction: 0.7,
    validationFraction: 0.15,
  });
  const dir = Deno.makeTempDirSync({ prefix: "stock_test_bin_" });
  writeStockTrainingDataset(split.train, dir, WINDOW_SIZE);
  return dir;
}

Deno.test({
  name:
    "runMultiRunStock resume flow loads prior creature, appends a milestone, and renders both charts",
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stock_resume_" });
    const dataDir = buildSyntheticStockBinDir(11);
    try {
      const slug = EXAMPLE_SLUG;

      // Pre-seed multi-run state with a synthetic prior champion + a
      // synthetic milestone so `loadMultiRunState` reports nextRunIndex=2.
      const priorCreatureExport = Creature.fromJSON(
        buildRandomSeedCreature(123, WINDOW_SIZE),
      ).exportJSON();
      await appendMultiRunRun(slug, {
        creatureExport: priorCreatureExport,
        newSamples: [{
          runGen: 1,
          error: 0.5,
          bestScore: 0.5,
          neurons: WINDOW_SIZE + OUTPUT_COUNT,
          synapses: WINDOW_SIZE * OUTPUT_COUNT,
          generationWallClockMs: 100,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      const outcome = await runMultiRunStock({
        dataDir,
        argv: [],
        baseDir: tmp,
        evolveOverrides: {
          maxGenerations: 2,
          populationSize: 4,
          timeoutMinutes: 0,
        },
      });

      // Prior champion must have been reloaded as the evolveDir seed.
      assertEquals(outcome.resumed, true);
      assertEquals(outcome.runIndex, 2);

      // Persisted history now contains both the pre-seeded milestone and
      // the new run's milestone, all with monotonic cumulativeGen.
      const state = await loadMultiRunState(slug, tmp);
      assertGreater(state.milestones.length, 1);
      assertEquals(state.nextRunIndex, 3);
      assertEquals(state.creatureExport !== undefined, true);
      const newRunMilestones = state.milestones.filter((m) => m.runIndex === 2);
      assertGreater(newRunMilestones.length, 0);
      for (let i = 1; i < state.milestones.length; i++) {
        const prev = state.milestones[i - 1].cumulativeGen;
        const curr = state.milestones[i].cumulativeGen;
        assert(curr >= prev, `cumulativeGen must be monotonic (${prev} → ${curr})`);
      }

      // Both chart SVGs were written under the baseDir override.
      const errorSvg = join(tmp, "screenshots", slug, "milestones.svg");
      const complexitySvg = join(tmp, "screenshots", slug, "complexity.svg");
      assertEquals(existsSync(errorSvg), true, "error chart SVG should exist");
      assertEquals(existsSync(complexitySvg), true, "complexity chart SVG should exist");
      const errorText = await Deno.readTextFile(errorSvg);
      const complexityText = await Deno.readTextFile(complexitySvg);
      assert(errorText.startsWith("<svg"), "error chart must be an SVG");
      assert(complexityText.startsWith("<svg"), "complexity chart must be an SVG");
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runMultiRunStock --fresh wipes prior artefacts before running",
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stock_fresh_" });
    const dataDir = buildSyntheticStockBinDir(13);
    try {
      const slug = EXAMPLE_SLUG;
      // Pre-seed with a prior run's state.
      await appendMultiRunRun(slug, {
        creatureExport: Creature.fromJSON(
          buildRandomSeedCreature(456, WINDOW_SIZE),
        ).exportJSON(),
        newSamples: [{
          runGen: 1,
          error: 0.5,
          bestScore: 0.5,
          neurons: WINDOW_SIZE + OUTPUT_COUNT,
          synapses: WINDOW_SIZE * OUTPUT_COUNT,
          generationWallClockMs: 100,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      const outcome = await runMultiRunStock({
        dataDir,
        argv: ["--fresh"],
        baseDir: tmp,
        evolveOverrides: {
          maxGenerations: 2,
          populationSize: 4,
          timeoutMinutes: 0,
        },
      });

      // `--fresh` wiped the prior state, so this is run 1 and there was
      // no prior champion to resume from.
      assertEquals(outcome.resumed, false);
      assertEquals(outcome.runIndex, 1);

      const state = await loadMultiRunState(slug, tmp);
      assertEquals(state.nextRunIndex, 2);
      for (const m of state.milestones) {
        assertEquals(m.runIndex, 1);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runMultiRunStock honours --target-error and --timeout overrides",
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stock_overrides_" });
    const dataDir = buildSyntheticStockBinDir(17);
    try {
      const outcome = await runMultiRunStock({
        dataDir,
        argv: ["--target-error=0.9", "--timeout=7"],
        baseDir: tmp,
        evolveOverrides: {
          maxGenerations: 2,
          populationSize: 4,
          // Tests skip the actual backstop because NEAT-AI's FFI cleanup
          // trips the Deno sanitizer.
          timeoutMinutes: 0,
        },
      });
      assertEquals(outcome.targetError, 0.9);
      assertEquals(outcome.timeoutMinutes, 7);
      // The persisted milestone exists for this run, and the chart
      // artefacts were rendered.
      const state = await loadMultiRunState(EXAMPLE_SLUG, tmp);
      assertEquals(state.milestones.length, 1);
      assertEquals(state.milestones[0].runIndex, 1);
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});

Deno.test("README embeds the multi-run charts and drops the legacy evolution_summary path", () => {
  const readme = Deno.readTextFileSync("stock_market/README.md");
  assert(
    readme.includes("../docs/screenshots/stock_market/milestones.svg"),
    "README must embed the multi-run error-curve chart (milestones.svg)",
  );
  assert(
    readme.includes("../docs/screenshots/stock_market/complexity.svg"),
    "README must embed the multi-run complexity chart (complexity.svg)",
  );
  // The legacy single-run evolution_summary chart is retired under #328.
  assert(
    !readme.includes("evolution_summary.svg"),
    "README must no longer reference the retired evolution_summary.svg",
  );
});
