/**
 * Unit tests for the stock-market direction-prediction example
 * (audit issue #218, telemetry rewired under #301). "What" tests only —
 * each test calls a real function with deterministic data and asserts
 * on the observable outputs (file contents, milestone summary fields,
 * accuracy floor, SVG structure, signal records).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertThrows,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { Creature } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { buildSamples, splitChronologically } from "./data.ts";
import {
  balancedDirectionalAccuracy,
  buildRandomSeedCreature,
  classifyGlyph,
  cumulativeStrategyReturn,
  DEFAULT_EVOLVE_OPTIONS,
  directionalAccuracy,
  evolveStockController,
  INPUT_COUNT,
  OUTPUT_COUNT,
  predictionFromOutput,
  replayController,
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
  "evolveStockController returns a milestone EvolveDirSummary with finite fields",
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
      const s = result.summary;
      assert(Number.isFinite(s.finalError));
      assert(Number.isFinite(s.finalScore));
      assert(Number.isFinite(s.wallClockMs));
      assert(Number.isInteger(s.generations));
      assertGreaterOrEqual(s.generations, 1);
      assertGreater(s.seedNeurons, 0);
      assertGreaterOrEqual(s.seedSynapses, 0);
      assertGreater(s.finalNeurons, 0);
      assertGreaterOrEqual(s.finalSynapses, 0);
      // tests pass timeoutMinutes=0 so the field must be omitted from
      // the summary caption.
      assertEquals(s.timeoutMinutes, undefined);
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
  "evolveStockController milestone summary renders an SVG containing each numeric callout",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "stock_summary_" });
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
      const svg = renderEvolveDirSummarySvg(result.summary, {
        title: "Stock Market — evolveDir Run Summary",
      });
      assert(svg.startsWith("<svg"));
      assert(svg.includes("</svg>"));
      assert(svg.includes(String(result.summary.generations)));
      assert(svg.includes(String(result.summary.seedNeurons)));
      assert(svg.includes(String(result.summary.seedSynapses)));
      assert(svg.includes(String(result.summary.finalNeurons)));
      assert(svg.includes(String(result.summary.finalSynapses)));
      assert(svg.includes("final error"));
      assert(svg.includes("final score"));
      assert(svg.includes("wall clock"));
      assert(!svg.includes("NaN"));
      assert(!svg.includes("Infinity"));
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "renderEvolveDirSummarySvg rejects a summary with missing numeric fields",
  () => {
    const badSummary = {
      finalError: 0.1,
      finalScore: 0.5,
      wallClockMs: Number.NaN,
      generations: 10,
      seedNeurons: 3,
      seedSynapses: 2,
      finalNeurons: 5,
      finalSynapses: 6,
    } as EvolveDirSummary;
    assertThrows(
      () => renderEvolveDirSummarySvg(badSummary),
      Error,
      "wallClockMs",
    );
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
