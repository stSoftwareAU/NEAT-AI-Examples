/**
 * Driver-level tests for the MNIST exploration campaign (issue #727).
 *
 * `runExplorationCampaign` calls `Creature.evolveDir`, which mutates
 * NEAT-AI global WASM state, so — like `evolve_integration_test.ts` —
 * `quality.sh` and CI run this file in isolated processes after the
 * parallel unit-test pass. Tests set `testCaps`, which forces
 * `discoverySampleRate: -1` so evolveDir never schedules structural
 * Discovery (its FFI cleanup machinery trips Deno's `--allow-ffi` leak
 * sanitiser inside `deno test`, issue #516), and pass `timeoutMinutes: 0`
 * to skip the wall-clock backstop.
 *
 * Both the gitignored working root (`explorationRoot`) and the recorded
 * artefact root (`baseDir`) point at temp directories, so a campaign run
 * under test never touches `.synthetic-mnist/` or the committed `docs/`.
 *
 * "What" tests only — evolution is stochastic, so every assertion is on
 * structure, counts, and persisted artefacts, never a particular score.
 */

import { assert, assertEquals, assertGreaterOrEqual, assertRejects } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, setMaxCachedWasmCreatureActivations } from "@stsoftware/neat-ai";

import { assertChampionContract } from "../common/champion_contract.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadMultiRunState } from "../common/multi_run_state.ts";
import { CLASS_COUNT, type DigitSample, type DigitSplit, FEATURE_COUNT } from "./data.ts";
import {
  EXAMPLE_SLUG,
  mnistRunSummaryDocsPath,
  mnistScreenshotPath,
  writeMnistTrainingBin,
} from "./mnist_classification.ts";
import {
  calibrateTrainingSampleRate,
  explorationPaths,
  type ExplorationPhase,
  type ExplorationPhaseRecord,
  loadExplorationCalibration,
  runExplorationCampaign,
  TARGET_MS_PER_GENERATION,
} from "./exploration_campaign.ts";
import { phaseChampionPath } from "./phase_champions.ts";
import { samplerLoopPath } from "./population_pool.ts";

/** Trim WASM caches between serial cases in one Deno process. */
function resetWasmState(): void {
  setMaxCachedWasmCreatureActivations(1);
}

const SAMPLES_PER_CLASS = 4;
const MAX_ATTEMPTS = 5;
const BASE_SEED = 424242;

/** Deterministic digit samples — one bright band per class plus noise. */
function syntheticSamples(perClass: number, seed = 7): DigitSample[] {
  const rng = createDeterministicRandom(seed);
  const samples: DigitSample[] = [];
  for (let i = 0; i < CLASS_COUNT * perClass; i++) {
    const label = i % CLASS_COUNT;
    const band = Math.floor(FEATURE_COUNT / CLASS_COUNT);
    const pixels: number[] = [];
    const features: number[] = [];
    for (let p = 0; p < FEATURE_COUNT; p++) {
      const bright = Math.floor(p / band) === label;
      const value = Math.min(255, (bright ? 220 : 20) + Math.floor(rng() * 8));
      pixels.push(value);
      features.push(value / 255);
    }
    samples.push({ index: i, label, features, pixels });
  }
  return samples;
}

function tinySplit(samples: readonly DigitSample[]): DigitSplit {
  return {
    train: [...samples],
    validation: samples.slice(0, CLASS_COUNT),
    test: samples.slice(CLASS_COUNT, CLASS_COUNT * 2),
  };
}

function syntheticBinDir(samples: readonly DigitSample[]): string {
  const dir = Deno.makeTempDirSync({ prefix: "mnist_campaign_bin_" });
  writeMnistTrainingBin(samples, join(dir, "mnist_train.bin"));
  return dir;
}

const TINY_PHASES: readonly ExplorationPhase[] = [
  {
    name: "loop-1",
    trainingSampleRate: 0.5,
    costOfGrowth: 5e-10,
    timeoutMinutes: 0,
    populationSize: 4,
    maxGenerations: 1,
  },
  {
    name: "loop-5",
    trainingSampleRate: 1,
    costOfGrowth: 0,
    timeoutMinutes: 0,
    populationSize: 4,
    maxGenerations: 1,
  },
];

/** Seed export used in place of the data-derived factory seed (see #518). */
function testSeedExport() {
  return new Creature(FEATURE_COUNT, CLASS_COUNT).exportJSON();
}

function testCapsForAttempt(attempt: number) {
  return {
    maxGenerations: 1,
    populationSize: 4,
    disableGenerationLog: true,
    seed: BASE_SEED + attempt,
  };
}

/** Retry the stochastic campaign with a fresh PRNG seed per attempt. */
async function runCampaignWithRetry(
  options: Omit<Parameters<typeof runExplorationCampaign>[0], "evolveOverrides">,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await runExplorationCampaign({
        ...options,
        evolveOverrides: {
          testCaps: testCapsForAttempt(attempt),
          timeoutMinutes: 0,
        },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

Deno.test({
  name: "runExplorationCampaign records one phase per schedule entry and persists the campaign",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetWasmState();
    const samples = syntheticSamples(SAMPLES_PER_CLASS);
    const dataDir = syntheticBinDir(samples);
    const explorationRoot = Deno.makeTempDirSync({ prefix: "mnist_campaign_root_" });
    const baseDir = Deno.makeTempDirSync({ prefix: "mnist_campaign_docs_" });
    try {
      const result = await runCampaignWithRetry({
        dataDir,
        split: tinySplit(samples),
        trainingRecords: samples.length,
        phases: TINY_PHASES,
        seedCreatureExport: testSeedExport(),
        skipCalibrate: true,
        randomizedIntelligentDesign: false,
        explorationRoot,
        baseDir,
      });

      // 1. One phase record per configured phase, carrying that phase's settings.
      assertEquals(result.phaseRecords.length, TINY_PHASES.length);
      for (let i = 0; i < TINY_PHASES.length; i++) {
        assertEquals(result.phaseRecords[i].phase, TINY_PHASES[i].name);
        assertEquals(
          result.phaseRecords[i].trainingSampleRate,
          TINY_PHASES[i].trainingSampleRate,
        );
        assertEquals(result.phaseRecords[i].costOfGrowth, TINY_PHASES[i].costOfGrowth);
        assertGreaterOrEqual(result.phaseRecords[i].generations, 1);
        assertGreaterOrEqual(result.phaseRecords[i].wallClockMs, 0);
      }
      assertEquals(result.squashImproved, false);

      // 2. The champion is a usable creature of MNIST arity.
      assertChampionContract(result.champion, { input: FEATURE_COUNT, output: CLASS_COUNT });
      for (const accuracy of [result.holdout.validationAccuracy, result.holdout.testAccuracy]) {
        assertGreaterOrEqual(accuracy, 0);
        assertGreaterOrEqual(1, accuracy);
      }

      // 3. Working-root artefacts: appended phase log, champion, summary.
      const paths = explorationPaths(explorationRoot);
      const logged = (await Deno.readTextFile(paths.phaseLog))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as ExplorationPhaseRecord);
      assertEquals(logged.map((r) => r.phase), TINY_PHASES.map((p) => p.name));

      assert(existsSync(paths.champion), "champion.json should be written");
      const summary = JSON.parse(await Deno.readTextFile(paths.summary));
      assertEquals(summary.phasesCompleted, TINY_PHASES.length);
      assertEquals(summary.testAccuracy, result.holdout.testAccuracy);
      assertEquals(summary.neurons, result.champion.neurons.length);

      // 4. Per-loop champion archives for population seeding.
      assert(existsSync(samplerLoopPath(1, explorationRoot)), "sampler loop-1 archive");
      assert(existsSync(phaseChampionPath("loop-1", explorationRoot)), "loop-1 phase champion");

      // 5. Recorded artefacts under the docs base dir.
      const state = await loadMultiRunState(EXAMPLE_SLUG, baseDir);
      assertEquals(state.milestones.length, TINY_PHASES.length);
      for (const chart of ["milestones.svg", "complexity.svg", "timeline.svg"]) {
        assert(
          existsSync(join(baseDir, "screenshots", EXAMPLE_SLUG, chart)),
          `${chart} should be refreshed`,
        );
      }
      assert(existsSync(mnistScreenshotPath(baseDir)), "prediction grid SVG");
      const runSummary = JSON.parse(await Deno.readTextFile(mnistRunSummaryDocsPath(baseDir)));
      assertEquals(runSummary.lastPhaseName, TINY_PHASES.at(-1)?.name);
      assertEquals(runSummary.campaignPhaseCount, TINY_PHASES.length);

      // 6. Nothing leaked into the repository working tree.
      assertEquals(existsSync(".synthetic-mnist/exploration/campaign_summary.json"), false);
    } finally {
      Deno.removeSync(dataDir, { recursive: true });
      Deno.removeSync(explorationRoot, { recursive: true });
      Deno.removeSync(baseDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runExplorationCampaign resumes from the persisted champion on a second invocation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetWasmState();
    const samples = syntheticSamples(SAMPLES_PER_CLASS);
    const dataDir = syntheticBinDir(samples);
    const explorationRoot = Deno.makeTempDirSync({ prefix: "mnist_campaign_resume_root_" });
    const baseDir = Deno.makeTempDirSync({ prefix: "mnist_campaign_resume_docs_" });
    const split = tinySplit(samples);
    const shared = {
      dataDir,
      split,
      trainingRecords: samples.length,
      phases: [TINY_PHASES[0]],
      skipCalibrate: true,
      randomizedIntelligentDesign: false,
      explorationRoot,
      baseDir,
    };
    try {
      await runCampaignWithRetry({ ...shared, seedCreatureExport: testSeedExport() });
      // No seed export this time: the campaign must pick the saved champion up.
      const second = await runCampaignWithRetry(shared);

      assertEquals(second.phaseRecords.length, 1);
      assertChampionContract(second.champion, { input: FEATURE_COUNT, output: CLASS_COUNT });

      const state = await loadMultiRunState(EXAMPLE_SLUG, baseDir);
      assertEquals(state.milestones.length, 2);
      assertEquals(state.nextRunIndex, 3);

      const logged = (await Deno.readTextFile(explorationPaths(explorationRoot).phaseLog))
        .split("\n")
        .filter((line) => line.length > 0);
      assertEquals(logged.length, 2);
    } finally {
      Deno.removeSync(dataDir, { recursive: true });
      Deno.removeSync(explorationRoot, { recursive: true });
      Deno.removeSync(baseDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runExplorationCampaign rejects when there is no saved champion and no --fresh",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const samples = syntheticSamples(1);
    const dataDir = syntheticBinDir(samples);
    const explorationRoot = Deno.makeTempDirSync({ prefix: "mnist_campaign_noseed_root_" });
    const baseDir = Deno.makeTempDirSync({ prefix: "mnist_campaign_noseed_docs_" });
    try {
      await assertRejects(
        () =>
          runExplorationCampaign({
            dataDir,
            split: tinySplit(samples),
            trainingRecords: samples.length,
            phases: TINY_PHASES,
            skipCalibrate: true,
            randomizedIntelligentDesign: false,
            explorationRoot,
            baseDir,
          }),
        Error,
        "No saved champion",
      );
    } finally {
      Deno.removeSync(dataDir, { recursive: true });
      Deno.removeSync(explorationRoot, { recursive: true });
      Deno.removeSync(baseDir, { recursive: true });
    }
  },
});

Deno.test("loadExplorationCalibration round-trips a persisted calibration record", async () => {
  const explorationRoot = Deno.makeTempDirSync({ prefix: "mnist_campaign_calib_" });
  try {
    assertEquals(await loadExplorationCalibration(explorationRoot), undefined);

    const record = {
      sampleRates: [0.01, 0.05, 0.15, 0.15] as [number, number, number, number],
      msPerGeneration: 900,
      scale: 1,
    };
    await Deno.writeTextFile(
      explorationPaths(explorationRoot).calibration,
      JSON.stringify(record),
    );
    const loaded = await loadExplorationCalibration(explorationRoot);
    assertEquals(loaded?.sampleRates, record.sampleRates);
    assertEquals(loaded?.msPerGeneration, 900);

    // A record with the wrong ladder length is rejected, not half-applied.
    await Deno.writeTextFile(
      explorationPaths(explorationRoot).calibration,
      JSON.stringify({ ...record, sampleRates: [0.01, 0.05] }),
    );
    assertEquals(await loadExplorationCalibration(explorationRoot), undefined);
  } finally {
    Deno.removeSync(explorationRoot, { recursive: true });
  }
});

Deno.test({
  name: "calibrateTrainingSampleRate derives a four-rung ladder from a probe run",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetWasmState();
    const samples = syntheticSamples(SAMPLES_PER_CLASS);
    const dataDir = syntheticBinDir(samples);
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const calibration = await calibrateTrainingSampleRate({
            dataDir,
            seedCreatureExport: testSeedExport(),
            evolveOverrides: {
              testCaps: testCapsForAttempt(attempt),
              timeoutMinutes: 0,
            },
          });
          assertEquals(calibration.sampleRates.length, 4);
          for (const rate of calibration.sampleRates) {
            assertGreaterOrEqual(rate, 0.001);
            assertGreaterOrEqual(1, rate);
          }
          assertGreaterOrEqual(calibration.scale, 0);
          assertGreaterOrEqual(1, calibration.scale);
          assertGreaterOrEqual(calibration.msPerGeneration, 0);
          assertGreaterOrEqual(calibration.probeGenerations, 1);
          assertEquals(calibration.seedNeurons, FEATURE_COUNT + CLASS_COUNT);
          assertChampionContract(
            Creature.fromJSON(calibration.championExport),
            { input: FEATURE_COUNT, output: CLASS_COUNT },
          );
          // A fast probe must leave the template ladder untouched.
          if (calibration.msPerGeneration <= TARGET_MS_PER_GENERATION) {
            assertEquals(calibration.scale, 1);
            assertEquals([...calibration.sampleRates], [0.01, 0.05, 0.15, 0.15]);
          }
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    } finally {
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});
