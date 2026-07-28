/**
 * Unit tests for the phased exploration campaign wired under issue
 * #476. Each test exercises {@link runExplorationCampaign} (or a CLI
 * helper) against a tiny synthetic price split with phase counts kept
 * small so the suite runs well inside the 120s budget.
 *
 * The campaign mirrors the phased sampler pattern: structure phases (random
 * training subsamples + low costOfGrowth so NEAT-AI grows topology
 * cheaply) followed by a polish phase (full training set, costOfGrowth
 * = 0) — and honest scoring of the evolved champion on the full train,
 * validation, and test windows after every phase.
 */
import { assert, assertEquals, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { buildSamples, type DataSplit, splitChronologically } from "./data.ts";
import {
  DEFAULT_EXPLORATION_PHASES,
  type ExplorationPhase,
  promoteExplorationArtefacts,
  runExplorationCampaign,
} from "./exploration_campaign.ts";

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

function buildTinySplit(windowSize = 5): DataSplit {
  const prices = syntheticPrices(220, 11);
  const samples = buildSamples(prices, { windowSize });
  return splitChronologically(samples, { trainFraction: 0.7, validationFraction: 0.15 });
}

const TINY_PHASES: ExplorationPhase[] = [
  {
    name: "structure",
    trainingSampleRate: 0.5,
    costOfGrowth: 0.000001,
    maxGenerations: 2,
    timeoutMinutes: 0,
  },
  {
    name: "polish",
    trainingSampleRate: 1,
    costOfGrowth: 0,
    maxGenerations: 2,
    timeoutMinutes: 0,
  },
];

Deno.test("DEFAULT_EXPLORATION_PHASES has structure phases before a polish phase", () => {
  assertGreaterOrEqual(DEFAULT_EXPLORATION_PHASES.length, 2);
  const polish = DEFAULT_EXPLORATION_PHASES.at(-1)!;
  assertEquals(polish.trainingSampleRate, 1);
  assertEquals(polish.costOfGrowth, 0);
  // Every preceding phase must subsample (rate < 1) and pay a positive
  // costOfGrowth — that is the whole point of the structure stage.
  for (const phase of DEFAULT_EXPLORATION_PHASES.slice(0, -1)) {
    assert(phase.trainingSampleRate < 1, `${phase.name} should subsample (rate < 1)`);
    assert(phase.costOfGrowth > 0, `${phase.name} should apply positive costOfGrowth`);
  }
});

Deno.test("runExplorationCampaign returns one phase record per configured phase", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_explore_phases_" });
  try {
    const result = await runExplorationCampaign({
      split: buildTinySplit(5),
      windowSize: 5,
      workingDir: tmp,
      seed: 42,
      populationSize: 4,
      phases: TINY_PHASES,
    });
    assertEquals(result.summary.phases.length, TINY_PHASES.length);
    for (let i = 0; i < TINY_PHASES.length; i++) {
      assertEquals(result.summary.phases[i].name, TINY_PHASES[i].name);
      assertEquals(
        result.summary.phases[i].trainingSampleRate,
        TINY_PHASES[i].trainingSampleRate,
      );
      assertEquals(result.summary.phases[i].costOfGrowth, TINY_PHASES[i].costOfGrowth);
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("runExplorationCampaign scores the champion on full train / val / test after every phase", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_explore_scores_" });
  try {
    const result = await runExplorationCampaign({
      split: buildTinySplit(5),
      windowSize: 5,
      workingDir: tmp,
      seed: 7,
      populationSize: 4,
      phases: TINY_PHASES,
    });
    for (const phase of result.summary.phases) {
      for (
        const metric of [
          phase.trainAccuracy,
          phase.trainBalanced,
          phase.validationAccuracy,
          phase.validationBalanced,
          phase.testAccuracy,
          phase.testBalanced,
        ]
      ) {
        assertGreaterOrEqual(metric, 0);
        assertGreaterOrEqual(1, metric);
      }
      assertGreaterOrEqual(phase.generations, 1);
      assertGreaterOrEqual(phase.wallClockMs, 0);
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("runExplorationCampaign writes champion + summary into the working dir", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_explore_artefacts_" });
  try {
    const result = await runExplorationCampaign({
      split: buildTinySplit(5),
      windowSize: 5,
      workingDir: tmp,
      seed: 99,
      populationSize: 4,
      phases: TINY_PHASES,
    });
    const championPath = join(tmp, "champion.json");
    const summaryPath = join(tmp, "summary.json");
    assert(existsSync(championPath), "champion.json should exist");
    assert(existsSync(summaryPath), "summary.json should exist");
    const persisted = JSON.parse(Deno.readTextFileSync(summaryPath));
    assertEquals(persisted.phases.length, TINY_PHASES.length);
    assertEquals(persisted.championNeurons, result.champion.neurons.length);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("runExplorationCampaign does not promote unless an explicit promote dir is provided", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_explore_no_promote_" });
  try {
    const result = await runExplorationCampaign({
      split: buildTinySplit(5),
      windowSize: 5,
      workingDir: tmp,
      seed: 1,
      populationSize: 4,
      phases: TINY_PHASES,
    });
    assertEquals(result.promoted, false);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("promoteExplorationArtefacts copies champion + summary from working dir to promote dir", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_explore_promote_" });
  const promoteDir = Deno.makeTempDirSync({ prefix: "stock_explore_promote_docs_" });
  try {
    await runExplorationCampaign({
      split: buildTinySplit(5),
      windowSize: 5,
      workingDir: tmp,
      seed: 5,
      populationSize: 4,
      phases: TINY_PHASES,
    });

    const promoted = await promoteExplorationArtefacts({
      workingDir: tmp,
      promoteDir,
    });
    assertEquals(promoted, true);
    assert(existsSync(join(promoteDir, "champion.json")));
    assert(existsSync(join(promoteDir, "summary.json")));
  } finally {
    Deno.removeSync(tmp, { recursive: true });
    Deno.removeSync(promoteDir, { recursive: true });
  }
});

Deno.test("runExplorationCampaign throws when phases is empty", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_explore_empty_" });
  let threw = false;
  try {
    await runExplorationCampaign({
      split: buildTinySplit(5),
      windowSize: 5,
      workingDir: tmp,
      seed: 1,
      populationSize: 4,
      phases: [],
    });
  } catch (_err) {
    threw = true;
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
  assert(threw, "expected an error when phases is empty");
});

Deno.test("runExplorationCampaign throws when trainingSampleRate is out of range", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "stock_explore_bad_rate_" });
  let threw = false;
  try {
    await runExplorationCampaign({
      split: buildTinySplit(5),
      windowSize: 5,
      workingDir: tmp,
      seed: 1,
      populationSize: 4,
      phases: [
        {
          name: "broken",
          trainingSampleRate: 1.5,
          costOfGrowth: 0,
          maxGenerations: 1,
          timeoutMinutes: 0,
        },
      ],
    });
  } catch (_err) {
    threw = true;
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
  assert(threw, "expected an error for trainingSampleRate > 1");
});
