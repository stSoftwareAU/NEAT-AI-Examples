/**
 * Unit tests for the MNIST recorded-evolution persistence helpers
 * (issue #727). These are the artefact-writing half of the exploration
 * campaign — every case points `baseDir` at a temp directory so no test
 * touches the committed `docs/` tree.
 *
 * "What" tests only: call the helper, then assert on the milestone
 * history, the campaign record, and the files actually written.
 */

import { assert, assertAlmostEquals, assertEquals, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import { loadMultiRunState } from "../common/multi_run_state.ts";
import { CLASS_COUNT, type DigitSample, type DigitSplit, FEATURE_COUNT } from "./data.ts";
import {
  EXAMPLE_SLUG,
  type MnistEvolveResult,
  mnistRunSummaryDocsPath,
  mnistScreenshotPath,
} from "./mnist_classification.ts";
import {
  persistMnistRecordedPhase,
  phaseResultToMultiRunSample,
  renderMnistRecordedCharts,
  wipeRecordedEvolution,
} from "./recorded_evolution.ts";

function syntheticSample(label: number, index: number): DigitSample {
  const features: number[] = [];
  const pixels: number[] = [];
  for (let i = 0; i < FEATURE_COUNT; i++) {
    const value = ((i + label * 7) % 256) / 255;
    features.push(value);
    pixels.push(Math.round(value * 255));
  }
  return { index, label, features, pixels };
}

function tinySplit(): DigitSplit {
  const samples = Array.from(
    { length: CLASS_COUNT * 2 },
    (_, i) => syntheticSample(i % CLASS_COUNT, i),
  );
  return {
    train: samples,
    validation: samples.slice(0, CLASS_COUNT),
    test: samples.slice(CLASS_COUNT),
  };
}

function fakeEvolveResult(generations: number, wallClockMs: number): MnistEvolveResult {
  const champion = new Creature(FEATURE_COUNT, CLASS_COUNT);
  return {
    champion,
    bestError: 0.4,
    bestScore: 0.6,
    generations,
    wallClockMs,
    seedNeurons: champion.neurons.length,
    seedSynapses: champion.synapses.length,
  };
}

Deno.test("phaseResultToMultiRunSample carries generations, error, and topology", () => {
  const evolveResult = fakeEvolveResult(4, 1234);
  const sample = phaseResultToMultiRunSample(
    evolveResult,
    { validationAccuracy: 0.5, testAccuracy: 0.75 },
    "loop-1",
  );
  assertEquals(sample.runGen, 4);
  assertAlmostEquals(sample.error, 0.25, 1e-9);
  assertEquals(sample.bestScore, 0.75);
  assertEquals(sample.holdoutScore, 0.75);
  assertEquals(sample.neurons, evolveResult.champion.neurons.length);
  assertEquals(sample.synapses, evolveResult.champion.synapses.length);
  assertEquals(sample.generationWallClockMs, 1234);
});

Deno.test("renderMnistRecordedCharts writes no charts when there is no history", async () => {
  const base = Deno.makeTempDirSync({ prefix: "mnist_charts_empty_" });
  try {
    await renderMnistRecordedCharts(base);
    assertEquals(existsSync(join(base, "screenshots", EXAMPLE_SLUG)), false);
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("persistMnistRecordedPhase writes milestones, charts, grid SVG, and run summary", async () => {
  const base = Deno.makeTempDirSync({ prefix: "mnist_persist_phase_" });
  try {
    const record = await persistMnistRecordedPhase({
      evolveResult: fakeEvolveResult(3, 5000),
      holdout: { validationAccuracy: 0.4, testAccuracy: 0.45 },
      split: tinySplit(),
      phaseName: "loop-1",
      runIndex: 1,
      baseCumulativeGen: 0,
      campaignFresh: true,
      trainingRecords: 20,
      baseDir: base,
    });

    assertEquals(record.phaseCount, 1);
    assertGreaterOrEqual(record.totalWallClockMs, 5000);

    const state = await loadMultiRunState(EXAMPLE_SLUG, base);
    assertEquals(state.milestones.length, 1);
    assertEquals(state.milestones[0].runIndex, 1);
    assertEquals(state.creatureExport !== undefined, true);

    for (const chart of ["milestones.svg", "complexity.svg", "timeline.svg"]) {
      const path = join(base, "screenshots", EXAMPLE_SLUG, chart);
      assert(existsSync(path), `${chart} should be written under the base dir`);
      assert((await Deno.readTextFile(path)).startsWith("<svg"), `${chart} must be an SVG`);
    }

    const gridPath = mnistScreenshotPath(base);
    assert(existsSync(gridPath), "prediction grid SVG should be written under the base dir");
    assert((await Deno.readTextFile(gridPath)).startsWith("<svg"));

    const summary = JSON.parse(await Deno.readTextFile(mnistRunSummaryDocsPath(base)));
    assertEquals(summary.lastPhaseName, "loop-1");
    assertEquals(summary.trainingRecords, 20);
    assertAlmostEquals(summary.testAccuracy, 0.45, 1e-9);
    assertEquals(summary.campaignPhaseCount, 1);
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("persistMnistRecordedPhase appends a second phase with monotonic cumulative generations", async () => {
  const base = Deno.makeTempDirSync({ prefix: "mnist_persist_two_" });
  const split = tinySplit();
  try {
    await persistMnistRecordedPhase({
      evolveResult: fakeEvolveResult(3, 1000),
      holdout: { validationAccuracy: 0.4, testAccuracy: 0.4 },
      split,
      phaseName: "loop-1",
      runIndex: 1,
      baseCumulativeGen: 0,
      campaignFresh: true,
      trainingRecords: 20,
      baseDir: base,
    });
    const second = await persistMnistRecordedPhase({
      evolveResult: fakeEvolveResult(2, 2000),
      holdout: { validationAccuracy: 0.5, testAccuracy: 0.55 },
      split,
      phaseName: "loop-2",
      runIndex: 2,
      baseCumulativeGen: 3,
      campaignFresh: false,
      trainingRecords: 20,
      baseDir: base,
    });

    assertEquals(second.phaseCount, 2);
    const state = await loadMultiRunState(EXAMPLE_SLUG, base);
    assertEquals(state.milestones.length, 2);
    assertEquals(state.nextRunIndex, 3);
    for (let i = 1; i < state.milestones.length; i++) {
      assertGreaterOrEqual(
        state.milestones[i].cumulativeGen,
        state.milestones[i - 1].cumulativeGen,
      );
    }
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("wipeRecordedEvolution removes the artefacts it was given a base dir for", async () => {
  const base = Deno.makeTempDirSync({ prefix: "mnist_persist_wipe_" });
  try {
    await persistMnistRecordedPhase({
      evolveResult: fakeEvolveResult(3, 1000),
      holdout: { validationAccuracy: 0.4, testAccuracy: 0.4 },
      split: tinySplit(),
      phaseName: "loop-1",
      runIndex: 1,
      baseCumulativeGen: 0,
      campaignFresh: true,
      trainingRecords: 20,
      baseDir: base,
    });
    assert(existsSync(mnistScreenshotPath(base)));

    await wipeRecordedEvolution(base);

    assertEquals(existsSync(mnistScreenshotPath(base)), false);
    assertEquals(existsSync(mnistRunSummaryDocsPath(base)), false);
    const state = await loadMultiRunState(EXAMPLE_SLUG, base);
    assertEquals(state.milestones.length, 0);
    assertEquals(state.creatureExport, undefined);
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});
