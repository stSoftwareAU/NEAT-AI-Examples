/**
 * Serial-only evolveDir integration tests for the MNIST example.
 *
 * These call `Creature.evolveDir` via `evolveMnistClassifier` / `runMultiRunMnist`
 * and mutate NEAT-AI global WASM state. `quality.sh` and CI run this file
 * without `--parallel` after the parallel unit-test pass.
 */

import {
  assert,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertRejects,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import { wipeCampaignRecord } from "../common/campaign_record.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import {
  buildDigitSamples,
  CLASS_COUNT,
  FEATURE_COUNT,
  IMAGE_SIZE,
  parseIdxImages,
  parseIdxLabels,
} from "./data.ts";
import {
  buildMnistHiddenReluSeed,
  DEFAULT_MULTI_RUN_TARGET_ERROR,
  evolveMnistClassifier,
  evolveResultToMultiRunSample,
  EXAMPLE_SLUG,
  runMultiRunMnist,
  writeMnistTrainingBin,
} from "./mnist_classification.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

function buildSyntheticIdx(
  seed: number,
  perClass: number,
): { images: Uint8Array; labels: Uint8Array } {
  const rng = createDeterministicRandom(seed);
  const total = CLASS_COUNT * perClass;
  const stride = IMAGE_SIZE * IMAGE_SIZE;

  const imageBuf = new Uint8Array(16 + total * stride);
  const imageView = new DataView(imageBuf.buffer);
  imageView.setUint32(0, 0x00000803);
  imageView.setUint32(4, total);
  imageView.setUint32(8, IMAGE_SIZE);
  imageView.setUint32(12, IMAGE_SIZE);

  const labelBuf = new Uint8Array(8 + total);
  const labelView = new DataView(labelBuf.buffer);
  labelView.setUint32(0, 0x00000801);
  labelView.setUint32(4, total);

  for (let i = 0; i < total; i++) {
    const label = i % CLASS_COUNT;
    labelBuf[8 + i] = label;
    const offset = 16 + i * stride;
    const labelRow = label;
    for (let y = 0; y < IMAGE_SIZE; y++) {
      const blockY = Math.floor(y / (IMAGE_SIZE / CLASS_COUNT));
      const baseValue = blockY === labelRow ? 220 : 20;
      for (let x = 0; x < IMAGE_SIZE; x++) {
        const noise = Math.floor(rng() * 8);
        imageBuf[offset + y * IMAGE_SIZE + x] = Math.min(255, baseValue + noise);
      }
    }
  }
  return { images: imageBuf, labels: labelBuf };
}

function buildSyntheticBinDir(perClass: number): string {
  const { images, labels } = buildSyntheticIdx(7, perClass);
  const samples = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
  const dir = Deno.makeTempDirSync({ prefix: "mnist_test_bin_" });
  writeMnistTrainingBin(samples, join(dir, "mnist_train.bin"));
  return dir;
}

const EVOLVE_DIR_TEST_CAPS = {
  maxGenerations: 2,
  populationSize: 30,
  disableGenerationLog: true,
} as const;
const EVOLVE_DIR_TEST_SAMPLES_PER_CLASS = 5;
const EVOLVE_DIR_TEST_OPTIONS = {
  testCaps: EVOLVE_DIR_TEST_CAPS,
  timeoutMinutes: 0,
  hiddenReluSeed: true,
} as const;

Deno.test(
  "evolveResultToMultiRunSample carries error/score/topology onto the milestone shape",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const result = await evolveMnistClassifier({
        dataDir,
        ...EVOLVE_DIR_TEST_OPTIONS,
      });
      const sample = evolveResultToMultiRunSample(result);
      assertEquals(sample.runGen, result.generations);
      assertGreaterOrEqual(sample.error, 0);
      assertGreaterOrEqual(1, sample.error);
      assertEquals(sample.bestScore, result.bestScore);
      assertEquals(sample.neurons, result.champion.neurons.length);
      assertEquals(sample.synapses, result.champion.synapses.length);
      assertEquals(sample.generationWallClockMs, result.wallClockMs);
    } finally {
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
);

Deno.test(
  "evolveMnistClassifier exposes finite seed and wall-clock fields on the result",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const result = await evolveMnistClassifier({
        dataDir,
        ...EVOLVE_DIR_TEST_OPTIONS,
      });
      assert(Number.isFinite(result.bestError));
      assert(Number.isFinite(result.bestScore));
      assert(Number.isFinite(result.wallClockMs));
      assertGreaterOrEqual(result.wallClockMs, 0);
      assertGreater(result.seedNeurons, 0);
      assertGreaterOrEqual(result.seedSynapses, 0);
      assert(Number.isInteger(result.generations));
      assertGreaterOrEqual(result.generations, 1);
    } finally {
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
);

Deno.test({
  name:
    "runMultiRunMnist resume flow loads prior creature, appends a milestone, and renders both charts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mnist_resume_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const slug = EXAMPLE_SLUG;

      // Bootstrap a champion with a truthy CATEGORICAL_ERROR score — a fresh
      // hidden ReLU seed can score 0 on the tiny synthetic set and stall evolveDir.
      const bootstrap = await evolveMnistClassifier({
        dataDir,
        ...EVOLVE_DIR_TEST_OPTIONS,
      });
      const priorCreatureExport = bootstrap.champion.exportJSON();
      await appendMultiRunRun(slug, {
        creatureExport: priorCreatureExport,
        newSamples: [evolveResultToMultiRunSample(bootstrap)],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      const outcome = await runMultiRunMnist({
        dataDir,
        argv: [],
        baseDir: tmp,
        evolveOverrides: EVOLVE_DIR_TEST_OPTIONS,
      });

      assertEquals(outcome.resumed, true);
      assertEquals(outcome.runIndex, 2);

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
  name: "runMultiRunMnist --fresh wipes prior artefacts before running",
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mnist_fresh_" });
    try {
      const slug = EXAMPLE_SLUG;
      await appendMultiRunRun(slug, {
        creatureExport: buildMnistHiddenReluSeed([8]).exportJSON(),
        newSamples: [{
          runGen: 1,
          error: 0.5,
          bestScore: 0.5,
          neurons: FEATURE_COUNT + CLASS_COUNT,
          synapses: FEATURE_COUNT * CLASS_COUNT,
          generationWallClockMs: 100,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      assertEquals(parseMultiRunFlags(["--fresh"]).fresh, true);

      await wipeMultiRunState(slug, tmp);
      await wipeCampaignRecord(slug, tmp);

      const state = await loadMultiRunState(slug, tmp);
      assertEquals(state.nextRunIndex, 1);
      assertEquals(state.creatureExport, undefined);
      assertEquals(state.milestones.length, 0);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "runMultiRunMnist rejects --target-error CLI override",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mnist_no_target_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      await assertRejects(
        () =>
          runMultiRunMnist({
            dataDir,
            argv: ["--target-error=0.1"],
            baseDir: tmp,
            evolveOverrides: EVOLVE_DIR_TEST_OPTIONS,
          }),
        Error,
        "does not accept --target-error",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runMultiRunMnist always uses the fixed DEFAULT_MULTI_RUN_TARGET_ERROR",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mnist_fixed_target_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const outcome = await runMultiRunMnist({
        dataDir,
        argv: [],
        baseDir: tmp,
        evolveOverrides: EVOLVE_DIR_TEST_OPTIONS,
      });
      assertEquals(outcome.targetError, DEFAULT_MULTI_RUN_TARGET_ERROR);
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runMultiRunMnist --timeout override flows through to the resolved options",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mnist_timeout_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const outcome = await runMultiRunMnist({
        dataDir,
        argv: ["--timeout=7"],
        baseDir: tmp,
        evolveOverrides: {
          ...EVOLVE_DIR_TEST_OPTIONS,
          timeoutMinutes: 0,
        },
      });
      assertEquals(outcome.timeoutMinutes, 7);
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});
