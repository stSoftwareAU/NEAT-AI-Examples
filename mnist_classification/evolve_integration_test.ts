/**
 * Serial-only evolveDir integration tests for the MNIST example.
 *
 * These call `Creature.evolveDir` via `evolveMnistClassifier` / `runMultiRunMnist`
 * and mutate NEAT-AI global WASM state. `quality.sh` and CI run this file
 * in isolated processes after the parallel unit-test pass.
 *
 * Tests set `testCaps`, which forces `discoverySampleRate: -1` so evolveDir
 * never schedules structural Discovery — Discovery's FFI cleanup machinery
 * trips Deno's `--allow-ffi` leak sanitiser inside `deno test` (issue #516).
 * They separately pass `timeoutMinutes: 0` to skip the wall-clock backstop
 * (also an FFI-sanitiser concern); the two are independent — only `testCaps`
 * disables Discovery, so real runs keep it on.
 *
 * "What" tests only — each case calls the public API and asserts on returned
 * values, persisted state, and written artefacts. Evolution is stochastic, so
 * assertions use ranges and structural checks, never particular fitness scores.
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

import { appendMultiRunRun, loadMultiRunState } from "../common/multi_run_state.ts";
import {
  buildDigitSamples,
  CLASS_COUNT,
  FEATURE_COUNT,
  IMAGE_SIZE,
  parseIdxImages,
  parseIdxLabels,
} from "./data.ts";
import {
  DEFAULT_MULTI_RUN_TARGET_ERROR,
  evolveMnistClassifier,
  evolveResultToMultiRunSample,
  EXAMPLE_SLUG,
  runMultiRunMnist,
  writeMnistTrainingBin,
} from "./mnist_classification.ts";
import { Creature, setMaxCachedWasmCreatureActivations } from "@stsoftware/neat-ai";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

/** Trim WASM caches between serial integration cases in one Deno process. */
function resetEvolveIntegrationWasmState(): void {
  setMaxCachedWasmCreatureActivations(1);
}

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

/** Placeholder milestone row so resume tests start from persisted state. */
function placeholderMilestone(
  creature: Creature,
  runGen = 1,
) {
  return {
    runGen,
    error: 0.5,
    bestScore: 0.5,
    neurons: creature.neurons.length,
    synapses: creature.synapses.length,
    generationWallClockMs: 1,
  };
}

const EVOLVE_DIR_TEST_CAPS = {
  maxGenerations: 2,
  // Reduced from 30 — limits WASM compilation overhead in CI so the
  // MemoryMonitor never reaches Critical level mid-evolution (#502).
  populationSize: 8,
  disableGenerationLog: true,
} as const;

/**
 * Caps for the resume-flow test.
 *
 * Resume passes `previousFittest` into NEAT-AI. Seed run-1 via a real
 * `evolveMnistClassifier` pass so the persisted champion has finite
 * CATEGORICAL_ERROR scores after JSON round-trip (a hand-built export alone
 * can yield falsy elitist scores on tiny synthetic data — #509).
 */
const EVOLVE_DIR_RESUME_CAPS = {
  ...EVOLVE_DIR_TEST_CAPS,
  populationSize: 6,
  maxGenerations: 2,
} as const;

const EVOLVE_DIR_RESUME_MAX_ATTEMPTS = 5;

const EVOLVE_DIR_TEST_SAMPLES_PER_CLASS = 5;
const EVOLVE_DIR_MAX_ATTEMPTS = 5;
const EVOLVE_DIR_BASE_SEED = 424242;

/**
 * Unit-test fresh seed (issue #518). Tests substitute a minimal
 * `new Creature(784, 10)` for the factory's data-scan seed so the
 * synthetic IDX fixture does not need to satisfy the factory's hidden-
 * capacity heuristics, and so memory stays low on CPU-only GitHub
 * Actions runners (#502). The factory itself is covered by the unit
 * tests in `mnist_classification_test.ts`.
 */
const TEST_FRESH_SEED_EXPORT = new Creature(FEATURE_COUNT, CLASS_COUNT).exportJSON();

const EVOLVE_DIR_TEST_OVERRIDES = {
  testCaps: { ...EVOLVE_DIR_TEST_CAPS, seed: EVOLVE_DIR_BASE_SEED },
  timeoutMinutes: 0,
  freshSeedExport: TEST_FRESH_SEED_EXPORT,
} as const;

const EVOLVE_DIR_FRESH_OPTIONS = {
  ...EVOLVE_DIR_TEST_OVERRIDES,
} as const;

function testCapsForAttempt(attempt: number) {
  return {
    ...EVOLVE_DIR_TEST_CAPS,
    seed: EVOLVE_DIR_BASE_SEED + attempt,
  };
}

function resumeTestCapsForAttempt(attempt: number) {
  return {
    ...EVOLVE_DIR_RESUME_CAPS,
    seed: EVOLVE_DIR_BASE_SEED + attempt,
  };
}

/** Retry stochastic evolveDir calls with a fresh PRNG seed each attempt. */
async function evolveMnistClassifierWithRetry(
  options: Parameters<typeof evolveMnistClassifier>[0],
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < EVOLVE_DIR_MAX_ATTEMPTS; attempt++) {
    try {
      return await evolveMnistClassifier({
        ...options,
        testCaps: testCapsForAttempt(attempt),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Retry stochastic evolveDir calls; optional hook resets persisted state between attempts. */
async function runMultiRunMnistWithRetry(
  options: Parameters<typeof runMultiRunMnist>[0],
  prepareState?: () => Promise<void>,
  capsForAttempt: (
    attempt: number,
  ) => {
    maxGenerations?: number;
    populationSize?: number;
    disableGenerationLog?: boolean;
    seed?: number;
  } = testCapsForAttempt,
  maxAttempts = EVOLVE_DIR_MAX_ATTEMPTS,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (prepareState !== undefined) {
        await prepareState();
      }
      return await runMultiRunMnist({
        ...options,
        evolveOverrides: {
          ...options.evolveOverrides,
          testCaps: capsForAttempt(attempt),
        },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function assertValidEvolveResult(
  result: Awaited<ReturnType<typeof evolveMnistClassifier>>,
): void {
  assert(Number.isFinite(result.bestError));
  assert(Number.isFinite(result.bestScore));
  assertGreaterOrEqual(result.bestError, 0);
  assertGreaterOrEqual(1, result.bestError);
  assert(Number.isFinite(result.wallClockMs));
  assertGreaterOrEqual(result.wallClockMs, 0);
  assertGreater(result.seedNeurons, 0);
  assertGreaterOrEqual(result.seedSynapses, 0);
  assert(Number.isInteger(result.generations));
  assertGreaterOrEqual(result.generations, 1);
  assertEquals(result.champion.input, FEATURE_COUNT);
  assertEquals(result.champion.output, CLASS_COUNT);
  assertGreaterOrEqual(result.champion.neurons.length, FEATURE_COUNT + CLASS_COUNT);
}

Deno.test(
  "evolveResultToMultiRunSample carries error/score/topology onto the milestone shape",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    resetEvolveIntegrationWasmState();
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const result = await evolveMnistClassifierWithRetry({
        dataDir,
        ...EVOLVE_DIR_FRESH_OPTIONS,
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
  "evolveMnistClassifier returns finite scores, generations, and a champion with MNIST I/O shape",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    resetEvolveIntegrationWasmState();
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const result = await evolveMnistClassifierWithRetry({
        dataDir,
        ...EVOLVE_DIR_FRESH_OPTIONS,
      });
      assertValidEvolveResult(result);
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
    resetEvolveIntegrationWasmState();
    const tmp = await Deno.makeTempDir({ prefix: "mnist_resume_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const slug = EXAMPLE_SLUG;

      const seedResumeState = async (attempt: number) => {
        await Deno.remove(tmp, { recursive: true });
        await Deno.mkdir(tmp, { recursive: true });
        const firstRun = await evolveMnistClassifier({
          dataDir,
          ...EVOLVE_DIR_FRESH_OPTIONS,
          testCaps: testCapsForAttempt(attempt),
        });
        await appendMultiRunRun(slug, {
          creatureExport: firstRun.champion.exportJSON(),
          newSamples: [evolveResultToMultiRunSample(firstRun)],
          runIndex: 1,
          baseCumulativeGen: 0,
        }, tmp);
      };

      let resumeAttempt = 0;
      const prepareResumeState = async () => {
        await seedResumeState(resumeAttempt);
      };

      const outcome = await runMultiRunMnistWithRetry(
        {
          dataDir,
          argv: [],
          baseDir: tmp,
          evolveOverrides: {
            ...EVOLVE_DIR_TEST_OVERRIDES,
            elitism: 2,
            testCaps: { ...EVOLVE_DIR_RESUME_CAPS, seed: EVOLVE_DIR_BASE_SEED },
          },
        },
        async () => {
          await prepareResumeState();
          resumeAttempt++;
        },
        resumeTestCapsForAttempt,
        EVOLVE_DIR_RESUME_MAX_ATTEMPTS,
      );

      assertEquals(outcome.resumed, true);
      assertEquals(outcome.runIndex, 2);
      assertValidEvolveResult(outcome.evolveResult);

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
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetEvolveIntegrationWasmState();
    const tmp = await Deno.makeTempDir({ prefix: "mnist_fresh_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const slug = EXAMPLE_SLUG;
      const prior = new Creature(FEATURE_COUNT, CLASS_COUNT);
      await appendMultiRunRun(slug, {
        creatureExport: prior.exportJSON(),
        newSamples: [placeholderMilestone(prior)],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      const outcome = await runMultiRunMnistWithRetry({
        dataDir,
        argv: ["--fresh"],
        baseDir: tmp,
        evolveOverrides: EVOLVE_DIR_FRESH_OPTIONS,
      });

      assertEquals(outcome.resumed, false);
      assertEquals(outcome.runIndex, 1);
      assertValidEvolveResult(outcome.evolveResult);

      const state = await loadMultiRunState(slug, tmp);
      assertEquals(state.nextRunIndex, 2);
      for (const milestone of state.milestones) {
        assertEquals(milestone.runIndex, 1);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
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
            evolveOverrides: EVOLVE_DIR_TEST_OVERRIDES,
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
  name: "runMultiRunMnist reports DEFAULT_MULTI_RUN_TARGET_ERROR on the outcome",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetEvolveIntegrationWasmState();
    const tmp = await Deno.makeTempDir({ prefix: "mnist_fixed_target_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const outcome = await runMultiRunMnistWithRetry({
        dataDir,
        argv: [],
        baseDir: tmp,
        evolveOverrides: EVOLVE_DIR_FRESH_OPTIONS,
      });
      assertEquals(outcome.targetError, DEFAULT_MULTI_RUN_TARGET_ERROR);
      assertValidEvolveResult(outcome.evolveResult);
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runMultiRunMnist reports argv --timeout on the outcome",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetEvolveIntegrationWasmState();
    const tmp = await Deno.makeTempDir({ prefix: "mnist_timeout_" });
    const dataDir = buildSyntheticBinDir(EVOLVE_DIR_TEST_SAMPLES_PER_CLASS);
    try {
      const outcome = await runMultiRunMnistWithRetry({
        dataDir,
        argv: ["--timeout=7"],
        baseDir: tmp,
        evolveOverrides: {
          ...EVOLVE_DIR_FRESH_OPTIONS,
          timeoutMinutes: 0,
        },
      });
      assertEquals(outcome.timeoutMinutes, 7);
      assertValidEvolveResult(outcome.evolveResult);
    } finally {
      await Deno.remove(tmp, { recursive: true });
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});
