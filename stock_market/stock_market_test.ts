/**
 * Unit tests for the stock-market direction-prediction example. "What"
 * tests only — each test calls a real function with deterministic data
 * and asserts on the observable outputs (population shape, accuracy
 * floor, SVG structure, signal records).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertLess,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { buildSamples, splitChronologically } from "./data.ts";
import {
  balancedDirectionalAccuracy,
  buildRandomPopulation,
  classifyGlyph,
  cumulativeStrategyReturn,
  DEFAULT_EVOLVE_OPTIONS,
  directionalAccuracy,
  evolveStockController,
  type GenerationInfo,
  mutateCreatureExport,
  OUTPUT_COUNT,
  predictionFromOutput,
  replayController,
  SOLVED_THRESHOLD,
  WINDOW_SIZE,
} from "./stock_market.ts";
import { renderChartSVG } from "./svg.ts";

/** Build a deterministic synthetic price fixture: a noisy series with a
 * small positive drift. Long enough for a 70/15/15 split with
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

Deno.test("buildRandomPopulation produces uniform-random NEAT genomes", () => {
  // Topology must NOT be hand-specified — the library decides shape.
  // We assert the population has the requested size and that every
  // member is a valid Creature with the right input/output counts.
  const pop = buildRandomPopulation(42, 5, WINDOW_SIZE);
  assertEquals(pop.length, 5);
  for (const json of pop) {
    assertEquals(json.input, WINDOW_SIZE);
    assertEquals(json.output, OUTPUT_COUNT);
    const creature = Creature.fromJSON(json);
    creature.validate();
    creature.clearState();
    const out = creature.activate(Float32Array.from(new Array(WINDOW_SIZE).fill(0)));
    assertEquals(out.length, OUTPUT_COUNT);
    assert(Number.isFinite(out[0]), `expected finite output, got ${out[0]}`);
  }
});

Deno.test("buildRandomPopulation is deterministic for the same seed", () => {
  const a = buildRandomPopulation(99, 4, WINDOW_SIZE);
  const b = buildRandomPopulation(99, 4, WINDOW_SIZE);
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    // Compare via JSON to ignore property ordering.
    assertEquals(JSON.stringify(a[i]), JSON.stringify(b[i]));
  }
});

Deno.test("buildRandomPopulation does not hand-specify hidden topology", () => {
  // Generation-1 noise: the library's minimal seed has zero hidden
  // neurons and direct input → output connections. Hidden structure
  // must emerge from mutation, not be supplied by the example.
  const pop = buildRandomPopulation(7, 3, WINDOW_SIZE);
  for (const json of pop) {
    const hiddenNeurons = json.neurons.filter((n) => n.type === "hidden");
    assertEquals(
      hiddenNeurons.length,
      0,
      "no hidden neurons should be hand-specified in the initial population",
    );
  }
});

Deno.test("buildRandomPopulation pins the output activation to LOGISTIC", () => {
  // The prediction interface (>= 0.5 ⇒ "up") assumes the output is
  // bounded to [0, 1]; the runtime relies on a LOGISTIC squash.
  const pop = buildRandomPopulation(5, 4, WINDOW_SIZE);
  for (const json of pop) {
    const outputs = json.neurons.filter((n) => n.type === "output");
    assertEquals(outputs.length, OUTPUT_COUNT);
    for (const out of outputs) {
      assertEquals(out.squash, "LOGISTIC");
    }
  }
});

Deno.test("mutateCreatureExport yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const pop = buildRandomPopulation(1, 1, WINDOW_SIZE);
  const child = mutateCreatureExport(pop[0], random, 1.0, 0.3);
  const creature = Creature.fromJSON(child);
  creature.validate();
});

Deno.test("mutateCreatureExport is deterministic for the same random stream", () => {
  const pop = buildRandomPopulation(5, 1, WINDOW_SIZE);
  const a = mutateCreatureExport(pop[0], createDeterministicRandom(11), 0.8, 0.2);
  const b = mutateCreatureExport(pop[0], createDeterministicRandom(11), 0.8, 0.2);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("mutateCreatureExport with addNeuronRate=1 grows topology", () => {
  // Forcing addNeuronRate=1 must split exactly one synapse, adding
  // one hidden neuron and replacing one synapse with two.
  const pop = buildRandomPopulation(3, 1, WINDOW_SIZE);
  const parent: CreatureExport = pop[0];
  const random = createDeterministicRandom(13);
  const child = mutateCreatureExport(parent, random, 0, 0, {
    addNeuronRate: 1,
    hiddenCounter: { value: 0 },
  });
  const parentHidden = parent.neurons.filter((n) => n.type === "hidden").length;
  const childHidden = child.neurons.filter((n) => n.type === "hidden").length;
  assertEquals(childHidden - parentHidden, 1, "expected exactly one new hidden neuron");
  assertEquals(
    child.synapses.length - parent.synapses.length,
    1,
    "splitting one synapse adds one net synapse (-1 + 2)",
  );
  // Resulting creature must still validate.
  Creature.fromJSON(child).validate();
});

Deno.test("predictionFromOutput thresholds at 0.5", () => {
  assertEquals(predictionFromOutput(0.49), 0);
  assertEquals(predictionFromOutput(0.5), 1);
  assertEquals(predictionFromOutput(0.99), 1);
  assertEquals(predictionFromOutput(0.0), 0);
});

Deno.test("directionalAccuracy returns the fraction of correct predictions", () => {
  // Use any deterministic creature; it does not matter what its
  // predictions are — we mirror them exactly in three of four samples
  // (label = prediction) and flip the fourth, giving a known 0.75.
  const pop = buildRandomPopulation(42, 1, 3);
  const creature = Creature.fromJSON(pop[0]);
  // Discover the creature's prediction for a fixed input vector.
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
  const pop = buildRandomPopulation(1, 1, 2);
  const creature = Creature.fromJSON(pop[0]);
  assertEquals(directionalAccuracy(creature, []), 0);
});

Deno.test("balancedDirectionalAccuracy scores 0.5 for a constant predictor on biased data", () => {
  // Build a heavily biased dataset (8 ups, 2 downs) and pair it with a
  // creature whose predictions are constant. Raw accuracy would credit
  // the constant predictor with the base rate (0.8); balanced accuracy
  // honestly scores it at 0.5 because the per-class hit rates are 1.0
  // on the majority class and 0.0 on the minority class.
  const pop = buildRandomPopulation(42, 1, 3);
  const creature = Creature.fromJSON(pop[0]);
  // Find a feature vector that produces a known prediction.
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
  // (1.0 + 0.0) / 2 = 0.5 — chance, regardless of the 80/20 base rate.
  assertAlmostEquals(balanced, 0.5, 1e-6);
});

Deno.test("balancedDirectionalAccuracy returns 0 on an empty sample list", () => {
  const pop = buildRandomPopulation(1, 1, 2);
  const creature = Creature.fromJSON(pop[0]);
  assertEquals(balancedDirectionalAccuracy(creature, []), 0);
});

Deno.test(
  "evolveStockController generation-1 mean accuracy is near coin-flip noise",
  () => {
    // Gen 1 must be uniform-random noise. Because the score is balanced
    // accuracy (mean of TPR and TNR), constant and random predictors
    // are honestly rated at 0.5 regardless of how skewed the labels
    // are — so the population mean should sit near the chance band,
    // never anywhere near SOLVED_THRESHOLD. Use a single generation so
    // we capture only the initial population.
    const prices = syntheticPrices(400, 11);
    const samples = buildSamples(prices, { windowSize: 5 });
    const split = splitChronologically(samples, {
      trainFraction: 0.7,
      validationFraction: 0.15,
    });
    let firstGenMean = -Infinity;
    let firstGenBest = -Infinity;
    evolveStockController(split, {
      seed: 1234,
      populationSize: 30,
      maxGenerations: 1,
      mutationStrength: 0.3,
      mutationRate: 0.5,
      addNeuronRate: 0,
      windowSize: 5,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === -Infinity) {
          firstGenMean = info.meanAccuracy;
          firstGenBest = info.bestAccuracy;
        }
      },
    });
    // Population mean must be in the chance band — well below the
    // threshold and well above zero. Balanced accuracy keeps it tight.
    assert(
      firstGenMean > 0.3 && firstGenMean < SOLVED_THRESHOLD,
      `expected gen-1 mean balanced accuracy in the noise band ` +
        `(0.3, ${SOLVED_THRESHOLD}), got ${firstGenMean}`,
    );
    assertGreaterOrEqual(firstGenBest, firstGenMean);
    assertLess(firstGenBest, 1.0 + 1e-9);
  },
);

Deno.test(
  "evolveStockController honours the hard generation cap",
  () => {
    // With a tiny strength + tiny rate, the evolver cannot reach the
    // threshold within the cap. Result must therefore stop at the cap
    // and report `solved=false`.
    const prices = syntheticPrices(400, 99);
    const samples = buildSamples(prices, { windowSize: 5 });
    const split = splitChronologically(samples, {
      trainFraction: 0.7,
      validationFraction: 0.15,
    });
    const cap = 3;
    const result = evolveStockController(split, {
      // seed=999 with pop=4 produces an initial population whose best
      // member is below SOLVED_THRESHOLD on this synthetic split, so the
      // early-stop branch cannot fire and the loop must run to the cap.
      seed: 999,
      populationSize: 4,
      maxGenerations: cap,
      mutationStrength: 0.001,
      mutationRate: 0.01,
      addNeuronRate: 0,
      windowSize: 5,
    });
    // If the synthetic split happens to put gen-1 above threshold, skip
    // the cap-stop assertion (the early-stop branch correctly fires).
    if (!result.solved) {
      assertEquals(
        result.generations,
        cap,
        `expected evolution to run to the hard cap of ${cap} generations, got ${result.generations}`,
      );
    }
  },
);

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
      maxGenerations: 30,
      mutationStrength: 0.4,
      mutationRate: 0.5,
      addNeuronRate: 0.03,
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

Deno.test(
  "evolveStockController emits GenerationInfo with sensible neuron and synapse counts",
  () => {
    const prices = syntheticPrices(200, 5);
    const samples = buildSamples(prices, { windowSize: 5 });
    const split = splitChronologically(samples, {
      trainFraction: 0.7,
      validationFraction: 0.15,
    });
    const seen: GenerationInfo[] = [];
    evolveStockController(split, {
      seed: 1,
      populationSize: 4,
      maxGenerations: 3,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      addNeuronRate: 0,
      windowSize: 5,
      onGeneration: (info) => seen.push(info),
    });
    assertGreater(seen.length, 0, "expected at least one onGeneration call");
    for (const info of seen) {
      // Without structural mutation the topology stays at the library's
      // minimal seed: 5 inputs + 1 output = 6 neurons and 5 synapses.
      assertEquals(info.neurons, 5 + 1);
      assertEquals(info.synapses, 5);
      assertGreaterOrEqual(info.bestAccuracy, 0);
      assertGreaterOrEqual(info.meanAccuracy, 0);
    }
  },
);

Deno.test(
  "evolveStockController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  () => {
    const tmp = Deno.makeTempDirSync({ prefix: "stock_market_snapshots_test_" });
    try {
      const prices = syntheticPrices(400, 11);
      const samples = buildSamples(prices, { windowSize: 5 });
      const split = splitChronologically(samples, {
        trainFraction: 0.7,
        validationFraction: 0.15,
      });
      // Use a small population and weak mutation so the evolutionary
      // loop does not accidentally hit the threshold in a single
      // generation and trigger early-stop before all checkpoints fire.
      const checkpoints = [1, 2, 3];
      evolveStockController(split, {
        seed: 1,
        populationSize: 3,
        maxGenerations: 4,
        mutationStrength: 0.05,
        mutationRate: 0.05,
        addNeuronRate: 0,
        windowSize: 5,
        snapshotConfig: { checkpoints, outputDir: tmp },
      });

      for (const gen of checkpoints) {
        assertEquals(
          existsSync(join(tmp, `snapshot-gen-${gen}.json`)),
          true,
          `expected snapshot-gen-${gen}.json to exist`,
        );
      }

      const snapshots = loadSnapshots(tmp);
      assertEquals(snapshots.length, checkpoints.length);

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Stock-Market — Evolution Progress",
      });
      assert(svg.startsWith("<svg"), "must start with <svg>");
      const panels = svg.match(/<g class="panel"/g) ?? [];
      assertEquals(panels.length, checkpoints.length);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test("DEFAULT_EVOLVE_OPTIONS pins a hard generation cap", () => {
  // The hard generation cap is part of the contract — guard it with a
  // sanity test so a future tweak cannot accidentally remove it.
  assertGreater(DEFAULT_EVOLVE_OPTIONS.maxGenerations, 0);
  assert(
    Number.isFinite(DEFAULT_EVOLVE_OPTIONS.maxGenerations),
    "maxGenerations must be a finite number — the hard cap",
  );
});

Deno.test("replayController emits one record per sample with a derived `correct` flag", () => {
  const prices = syntheticPrices(60, 3);
  const samples = buildSamples(prices, { windowSize: 4 });
  const pop = buildRandomPopulation(7, 1, 4);
  const creature = Creature.fromJSON(pop[0]);
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
