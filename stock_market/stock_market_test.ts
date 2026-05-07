/**
 * Unit tests for the stock-market direction-prediction example. "What"
 * tests only — each test calls a real function with deterministic data
 * and asserts on the observable outputs (genome shape, accuracy floor,
 * SVG structure, signal records).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
} from "@std/assert";
import { Creature } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { buildSamples, splitChronologically } from "./data.ts";
import {
  buildInitialCreatureJSON,
  classifyGlyph,
  cumulativeStrategyReturn,
  directionalAccuracy,
  evolveStockController,
  genesFromCreatureJSON,
  mutateCreatureJSON,
  predictionFromOutput,
  randomCreatureJSON,
  replayController,
} from "./stock_market.ts";
import { renderChartSVG } from "./svg.ts";

/** Build a deterministic synthetic price fixture: an oscillating series
 * with a small positive drift. Long enough for a 70/15/15 split with
 * windowSize=5 and still yield a non-trivial number of samples. */
function syntheticPrices(n: number, seed = 1): { date: string; close: number }[] {
  const rng = createDeterministicRandom(seed);
  const points: { date: string; close: number }[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    points.push({ date: `2020-01-${(i + 1).toString().padStart(2, "0")}`, close: p });
    // Drifting random walk: small +ve drift plus uniform noise.
    const shock = (rng() - 0.45) * 0.04;
    p = Math.max(1, p * (1 + shock));
  }
  return points;
}

Deno.test("buildInitialCreatureJSON has windowSize inputs and one output", () => {
  const json = buildInitialCreatureJSON([0.1, 0.2, 0.3, 0.4, 0.5], 0.1);
  assertEquals(json.input, 5);
  assertEquals(json.output, 1);
  assertEquals(json.synapses.length, 5);
});

Deno.test("buildInitialCreatureJSON produces a creature that validates and activates", () => {
  const json = buildInitialCreatureJSON([0.1, 0.2, -0.1, 0.0, 0.05], 0.0);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
  const out = creature.activate(Float32Array.from([0.01, -0.02, 0.03, 0.0, 0.005]));
  assertEquals(out.length, 1);
  assert(Number.isFinite(out[0]));
});

Deno.test("genesFromCreatureJSON round-trips weights and bias for any windowSize", () => {
  const weights = [0.1, -0.2, 0.3, 0.4, -0.5, 0.0, 0.7];
  const bias = 0.42;
  const json = buildInitialCreatureJSON(weights, bias);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights, weights);
  assertEquals(genes.bias, bias);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const r1 = createDeterministicRandom(42);
  const r2 = createDeterministicRandom(42);
  assertEquals(randomCreatureJSON(r1, 8), randomCreatureJSON(r2, 8));
});

Deno.test("mutateCreatureJSON yields a creature of the same shape that still validates", () => {
  const random = createDeterministicRandom(7);
  const parent = buildInitialCreatureJSON([0, 0, 0, 0, 0, 0], 0);
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  assertEquals(child.input, 6);
  const creature = Creature.fromJSON(asCreatureExport(child));
  creature.validate();
});

Deno.test("predictionFromOutput thresholds at 0.5", () => {
  assertEquals(predictionFromOutput(0.49), 0);
  assertEquals(predictionFromOutput(0.5), 1);
  assertEquals(predictionFromOutput(0.99), 1);
  assertEquals(predictionFromOutput(0.0), 0);
});

Deno.test("directionalAccuracy returns the fraction of correct predictions", () => {
  // Two-input network whose first weight strongly drives the sigmoid,
  // so a negative first feature produces ~0 and positive produces ~1.
  const json = buildInitialCreatureJSON([10, 0], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
  // 4 samples: features tagged with their label.
  const samples = [
    { index: 0, date: "a", features: [1, 0], label: 1 as const, return: 0.1, close: 1 },
    { index: 1, date: "b", features: [-1, 0], label: 0 as const, return: -0.1, close: 1 },
    { index: 2, date: "c", features: [1, 0], label: 1 as const, return: 0.1, close: 1 },
    // This one is mislabelled relative to the network's view, so it counts wrong.
    { index: 3, date: "d", features: [-1, 0], label: 1 as const, return: 0.1, close: 1 },
  ];
  const acc = directionalAccuracy(creature, samples);
  assertAlmostEquals(acc, 0.75, 1e-6);
});

Deno.test("directionalAccuracy returns 0 on an empty sample list", () => {
  const json = buildInitialCreatureJSON([0, 0], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
  assertEquals(directionalAccuracy(creature, []), 0);
});

Deno.test(
  "evolveStockController — happy path: champion validation accuracy beats the 50% floor",
  () => {
    const prices = syntheticPrices(400, 11);
    const samples = buildSamples(prices, { windowSize: 5 });
    const split = splitChronologically(samples, {
      trainFraction: 0.7,
      validationFraction: 0.15,
    });
    const result = evolveStockController(split, {
      seed: 1234,
      populationSize: 30,
      maxGenerations: 15,
      mutationStrength: 0.3,
      mutationRate: 0.5,
      windowSize: 5,
    });
    // Documented floor: above naive 50%.
    assertGreater(
      result.validationAccuracy,
      0.5,
      `validation accuracy should be above 0.5, got ${result.validationAccuracy}`,
    );
    // Champion must serialise and re-load cleanly.
    const exportJson = result.champion.exportJSON();
    const reloaded = Creature.fromJSON(exportJson);
    reloaded.validate();
  },
);

Deno.test("replayController emits one record per sample with a derived `correct` flag", () => {
  const prices = syntheticPrices(60, 3);
  const samples = buildSamples(prices, { windowSize: 4 });
  const json = buildInitialCreatureJSON([1, 1, 1, 1], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
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
  // Up-predictions: 0.1 + 0.02 + (-0.07) = 0.05
  assertAlmostEquals(cumulativeStrategyReturn(records), 0.05, 1e-9);
});

Deno.test("classifyGlyph maps each prediction × outcome pair to a unique glyph", () => {
  assertEquals(classifyGlyph({ prediction: 1, outcome: 1 }), "up_hit");
  assertEquals(classifyGlyph({ prediction: 1, outcome: 0 }), "up_miss");
  assertEquals(classifyGlyph({ prediction: 0, outcome: 0 }), "down_hit");
  assertEquals(classifyGlyph({ prediction: 0, outcome: 1 }), "down_miss");
});

Deno.test("renderChartSVG emits an animated SVG with prediction markers in multiple colours", () => {
  // Mix of all four glyph categories to ensure the SVG carries multiple
  // colours and SMIL animation primitives.
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
  // SMIL animation present.
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 1);
  // Polyline for the price curve present.
  assert(svg.includes('class="price"'));
  // At least two distinct glyph categories rendered.
  assert(svg.includes("up_hit"));
  assert(svg.includes("down_hit"));
  // Caption mentions the metrics so static viewers can see them.
  assert(svg.includes("Validation accuracy"));
  assert(svg.includes("Cumulative strategy return"));
  // Disclaimer is rendered for safety.
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
