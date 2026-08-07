/**
 * Unit tests for the MNIST exploration campaign.
 *
 * "What" tests only — deterministic inputs, observable outputs.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
} from "@std/assert";
import { Creature } from "@stsoftware/neat-ai";

import { CLASS_COUNT, type DigitSample, FEATURE_COUNT } from "./data.ts";
import {
  buildExplorationLoopPhases,
  buildSingleSampleRatePhases,
  DEFAULT_EXPLORATION_LOOP_MINUTES,
  DEFAULT_EXPLORATION_LOOP_REPEATS,
  DEFAULT_EXPLORATION_PHASES,
  evaluateOnHoldout,
  EXPLORATION_ROOT,
  explorationPaths,
  type ExplorationPhaseRecord,
  POLISH_MAX_GENERATIONS,
  POLISH_TIMEOUT_MINUTES,
  randomStructureSampleRate,
  structureSampleRatesForCalibration,
  TARGET_MS_PER_GENERATION,
} from "./exploration_campaign.ts";

Deno.test("structureSampleRatesForCalibration keeps the ladder when full data is fast enough", () => {
  const { rates, scale } = structureSampleRatesForCalibration(800, TARGET_MS_PER_GENERATION);
  assertEquals(scale, 1);
  assertEquals(rates, [0.01, 0.05, 0.15, 0.15]);
});

Deno.test("structureSampleRatesForCalibration scales ladder when full data is slow", () => {
  const { rates, scale } = structureSampleRatesForCalibration(30_000, TARGET_MS_PER_GENERATION);
  assertAlmostEquals(scale, 0.05, 1e-9);
  assertAlmostEquals(rates[0], 0.05 * 0.01 / 0.15, 1e-9);
  assertAlmostEquals(rates[3], 0.05, 1e-9);
});

Deno.test("randomStructureSampleRate stays within the 10–50% band", () => {
  assertAlmostEquals(randomStructureSampleRate(() => 0), 0.10, 1e-9);
  assertAlmostEquals(randomStructureSampleRate(() => 0.999), 0.50, 1e-9);
});

function syntheticSample(label: number, index: number): DigitSample {
  const features: number[] = [];
  for (let i = 0; i < FEATURE_COUNT; i++) {
    features.push((i + label) / FEATURE_COUNT);
  }
  const pixels = new Array<number>(FEATURE_COUNT).fill(label * 20);
  return { index, label, features, pixels };
}

Deno.test("buildSingleSampleRatePhases builds one long structure phase", () => {
  const phases = buildSingleSampleRatePhases({
    trainingSampleRate: 0.01,
    loopMinutes: 60,
  });
  assertEquals(phases.length, 1);
  assertEquals(phases[0]?.trainingSampleRate, 0.01);
  assertEquals(phases[0]?.timeoutMinutes, 60);
  assertEquals(phases[0]?.maxGenerations, undefined);
});

Deno.test("buildExplorationLoopPhases repeats the five-loop sampler cadence", () => {
  const phases = buildExplorationLoopPhases({ loopMinutes: 60, repeats: 2 });
  assertEquals(phases.length, 10);
  assertEquals(phases.filter((p) => p.name.startsWith("loop-5")).length, 2);
  assertEquals(phases.at(-1)?.name, "loop-5-r2");
});

Deno.test("buildExplorationLoopPhases targets ~60 min with structure and loop-5 slots", () => {
  const phases = buildExplorationLoopPhases({
    loopMinutes: DEFAULT_EXPLORATION_LOOP_MINUTES,
    repeats: DEFAULT_EXPLORATION_LOOP_REPEATS,
  });
  const structureMinutes = phases
    .filter((p) => p.trainingSampleRate < 1)
    .reduce((sum, p) => sum + p.timeoutMinutes, 0);
  const polishMinutes = phases
    .filter((p) => p.trainingSampleRate >= 1)
    .reduce((sum, p) => sum + p.timeoutMinutes, 0);
  assertEquals(structureMinutes, 48);
  assertEquals(polishMinutes, DEFAULT_EXPLORATION_LOOP_REPEATS * POLISH_TIMEOUT_MINUTES);
  assertEquals(structureMinutes + polishMinutes, 58);
});

Deno.test("loop 5 caps generations; earlier loops do not", () => {
  for (const phase of DEFAULT_EXPLORATION_PHASES) {
    if (phase.name.startsWith("loop-5")) {
      assertEquals(phase.maxGenerations, POLISH_MAX_GENERATIONS);
      assertEquals(phase.trainingSampleRate, 1);
      assertEquals(phase.costOfGrowth, 0);
    } else {
      assertEquals(phase.maxGenerations, undefined);
      assertGreater(phase.trainingSampleRate, 0);
      assertGreater(1, phase.trainingSampleRate);
      assertGreater(phase.costOfGrowth, 0);
      assertGreater(1e-6, phase.costOfGrowth);
    }
  }
});

Deno.test("evaluateOnHoldout returns finite fractions in [0, 1]", () => {
  const creature = new Creature(FEATURE_COUNT, CLASS_COUNT);
  const split = {
    train: [syntheticSample(0, 0), syntheticSample(1, 1)],
    validation: [syntheticSample(2, 2), syntheticSample(3, 3)],
    test: [syntheticSample(4, 4), syntheticSample(5, 5), syntheticSample(6, 6)],
  };
  const scores = evaluateOnHoldout(creature, split);
  assertGreaterOrEqual(scores.validationAccuracy, 0);
  assertGreaterOrEqual(scores.testAccuracy, 0);
  assertGreaterOrEqual(1, scores.validationAccuracy);
  assertGreaterOrEqual(1, scores.testAccuracy);
});

Deno.test("EXPLORATION_ROOT is under the hidden MNIST working directory", () => {
  assert(EXPLORATION_ROOT.startsWith(".synthetic-mnist/"));
  assert(EXPLORATION_ROOT.includes("exploration"));
});

Deno.test("phase-log path comes from explorationPaths(), not a module-level alias", async () => {
  const paths = explorationPaths(EXPLORATION_ROOT);
  assertEquals(paths.phaseLog, `${EXPLORATION_ROOT}/phases.jsonl`);

  // Regression guard for #763: the unused `EXPLORATION_PHASE_LOG_PATH` alias is gone.
  const surface = await import("./exploration_campaign.ts");
  assert(!("EXPLORATION_PHASE_LOG_PATH" in surface));
});

Deno.test("summary path comes from explorationPaths(), not a module-level alias", async () => {
  const paths = explorationPaths(EXPLORATION_ROOT);
  assertEquals(paths.summary, `${EXPLORATION_ROOT}/campaign_summary.json`);

  // Regression guard for #764: the unused `EXPLORATION_SUMMARY_PATH` alias is gone.
  const surface = await import("./exploration_campaign.ts");
  assert(!("EXPLORATION_SUMMARY_PATH" in surface));
});

Deno.test("ExplorationPhaseRecord shape is JSON-serialisable", () => {
  const record: ExplorationPhaseRecord = {
    phase: "loop-1-r1",
    trainingSampleRate: 0.01,
    costOfGrowth: 5e-10,
    generations: 3,
    evolveDirError: 0.8,
    evolveDirScore: 0.2,
    validationAccuracy: 0.21,
    testAccuracy: 0.2,
    neurons: 100,
    synapses: 200,
    wallClockMs: 900_000,
    timestamp: "2026-05-24T00:00:00.000Z",
  };
  const roundTrip = JSON.parse(JSON.stringify(record)) as ExplorationPhaseRecord;
  assertEquals(roundTrip.phase, "loop-1-r1");
  assertAlmostEquals(roundTrip.testAccuracy, 0.2, 1e-9);
});
