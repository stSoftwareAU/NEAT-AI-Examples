/**
 * Unit tests for the stock-market direction-prediction example
 * (audit issue #218). "What" tests only — each test calls a real
 * function with deterministic data and asserts on the observable
 * outputs (file contents, telemetry rows, accuracy floor, SVG
 * structure, signal records).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
} from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { buildSamples, splitChronologically } from "./data.ts";
import {
  balancedDirectionalAccuracy,
  buildRandomSeedCreature,
  classifyGlyph,
  cumulativeStrategyReturn,
  DEFAULT_EVOLVE_OPTIONS,
  directionalAccuracy,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveStockController,
  formatEvolutionCsv,
  type GenerationInfo,
  INPUT_COUNT,
  OUTPUT_COUNT,
  planSegments,
  predictionFromOutput,
  renderFitnessChartSvg,
  renderTopologyChartSvg,
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
  // Random seed must have zero hidden neurons — NEAT-AI must invent
  // them via structural mutation during `evolveDir`.
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(hidden.length, 0, "random seed must have zero hidden neurons");
});

Deno.test("buildRandomSeedCreature pins the output activation to LOGISTIC", () => {
  // The prediction interface (>= 0.5 ⇒ "up") assumes the output is
  // bounded to [0, 1]; the runtime relies on a LOGISTIC squash.
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
        // Float32 round-trip — compare with a small tolerance.
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

Deno.test("planSegments inserts every in-budget checkpoint and ends at maxGenerations", () => {
  assertEquals(planSegments([1, 10, 100, 1000, 10000], 50), [1, 10, 50]);
  assertEquals(planSegments([1, 5], 5), [1, 5]);
  assertEquals(planSegments([], 7), [7]);
  assertEquals(planSegments([1000], 10), [10]);
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
  // Issue #218 mandates a per-example targetError plus the 5-minute
  // timeoutMinutes safety backstop. Plus a hard generation cap so a
  // stuck run never blocks the example forever.
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
  "evolveStockController emits GenerationInfo with finite fields and grows from the minimal seed",
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
      const seen: GenerationInfo[] = [];
      await evolveStockController({
        ...DEFAULT_EVOLVE_OPTIONS,
        windowSize: 5,
        seed: 1,
        populationSize: 6,
        maxGenerations: 3,
        errorThreshold: 0,
        timeoutMinutes: 0,
        dataDir: tmp,
        onGeneration: (info) => seen.push(info),
      });
      assertGreater(seen.length, 0, "expected at least one onGeneration call");
      for (const info of seen) {
        assertEquals(typeof info.neurons, "number");
        assertEquals(typeof info.synapses, "number");
        assertEquals(Number.isInteger(info.neurons), true);
        assertEquals(Number.isInteger(info.synapses), true);
        assertGreater(info.neurons, 0);
        assertGreaterOrEqual(info.synapses, 0);
        assert(Number.isFinite(info.bestFitness));
        assert(Number.isFinite(info.bestError));
      }
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
      // Cap is honoured at the segment-loop level so the run cannot
      // wedge indefinitely.
      assertGreaterOrEqual(20, result.generations);
      // Champion is a real Creature that activates without throwing.
      creatureActivatesFinite(result.champion);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveStockController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "stock_snapshots_" });
    const dataDir = join(tmp, "data");
    const snapshotsDir = join(tmp, "snapshots");
    ensureDirSync(dataDir);
    ensureDirSync(snapshotsDir);
    try {
      const prices = syntheticPrices(120, 11);
      const samples = buildSamples(prices, { windowSize: 5 });
      const split = splitChronologically(samples, {
        trainFraction: 0.7,
        validationFraction: 0.15,
      });
      writeStockTrainingDataset(split.train, dataDir, 5);
      const checkpoints = [1, 2, 3];
      await evolveStockController({
        ...DEFAULT_EVOLVE_OPTIONS,
        windowSize: 5,
        seed: 1,
        populationSize: 4,
        maxGenerations: 4,
        errorThreshold: 0,
        timeoutMinutes: 0,
        dataDir,
        snapshotConfig: { checkpoints, outputDir: snapshotsDir },
      });

      for (const gen of checkpoints) {
        assertEquals(
          existsSync(join(snapshotsDir, `snapshot-gen-${gen}.json`)),
          true,
          `expected snapshot-gen-${gen}.json to exist`,
        );
      }

      const snapshots = loadSnapshots(snapshotsDir);
      assertEquals(snapshots.length, checkpoints.length);

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Stock-Market — Evolution Progress",
      });
      assert(svg.startsWith("<svg"));
      const panels = svg.match(/<g class="panel"/g) ?? [];
      assertEquals(panels.length, checkpoints.length);
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

Deno.test("formatEvolutionCsv emits the canonical header and one row per sample", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: 0.5, meanFitness: 0.25, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: 0.75, meanFitness: 0.4, neuronCount: 4, synapseCount: 3 },
  ];
  const csv = formatEvolutionCsv(rows);
  const lines = csv.trim().split("\n");
  assertEquals(lines.length, 1 + rows.length);
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines[1], "1,0.5,0.25,3,2");
  assertEquals(lines[2], "2,0.75,0.4,4,3");
});

Deno.test("formatEvolutionCsv handles empty input and trailing newline", () => {
  const empty = formatEvolutionCsv([]);
  assertEquals(empty, EVOLUTION_CSV_HEADER + "\n");
  const single = formatEvolutionCsv([
    { generation: 7, bestFitness: 0.123456789, meanFitness: NaN, neuronCount: 5, synapseCount: 6 },
  ]);
  assert(single.endsWith("\n"));
  const lines = single.trim().split("\n");
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines[1], "7,0.123457,0,5,6");
});

Deno.test("renderFitnessChartSvg produces a well-formed SVG referencing both fitness lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: 0.6, meanFitness: 0.3, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: 0.8, meanFitness: 0.5, neuronCount: 4, synapseCount: 3 },
  ];
  const svg = renderFitnessChartSvg(rows);
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assert(svg.includes('class="best-fitness"'));
  assert(svg.includes('class="mean-fitness"'));
  assert(svg.includes("Best vs Mean Fitness"));
});

Deno.test("renderFitnessChartSvg rejects empty input", () => {
  let threw = false;
  try {
    renderFitnessChartSvg([]);
  } catch (_err) {
    threw = true;
  }
  assert(threw);
});

Deno.test("renderTopologyChartSvg produces a well-formed SVG referencing both count lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: 0.6, meanFitness: 0.3, neuronCount: 3, synapseCount: 2 },
    { generation: 5, bestFitness: 0.8, meanFitness: 0.5, neuronCount: 6, synapseCount: 9 },
  ];
  const svg = renderTopologyChartSvg(rows);
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assert(svg.includes('class="neuron-count"'));
  assert(svg.includes('class="synapse-count"'));
  assert(svg.includes("Topology Growth"));
});

Deno.test("renderTopologyChartSvg rejects empty input", () => {
  let threw = false;
  try {
    renderTopologyChartSvg([]);
  } catch (_err) {
    threw = true;
  }
  assert(threw);
});

/* ------------------------------------------------------------------ */
/*  Local test helpers                                                 */
/* ------------------------------------------------------------------ */

function creatureActivatesFinite(creature: Creature): void {
  creature.clearState();
  const out = creature.activate(Float32Array.from(new Array(creature.input).fill(0)));
  assert(Number.isFinite(out[0]));
}
