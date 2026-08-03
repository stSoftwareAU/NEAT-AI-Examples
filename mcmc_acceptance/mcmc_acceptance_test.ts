/**
 * Unit tests for the MCMC mutation-acceptance demo (issues #89, #215,
 * telemetry rewire #303).
 *
 * "What" tests only — each test calls a real function and asserts on
 * observable outputs (record structure, summary statistics, SVG
 * structure, milestone summary contract). No greps over source files.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
} from "@std/assert";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  createOracleCreature,
  DEFAULT_MCMC_EVOLUTION_CONFIG,
  DEFAULT_MCMC_OPTIONS,
  INPUT_COUNT,
  movingAverage,
  OPTIMAL_ACCEPTANCE_RATE,
  OUTPUT_COUNT,
  type ProposalRecord,
  runMCMCAcceptance,
  runMinimalSeedEvolution,
  windowedAcceptanceRates,
} from "./mcmc_acceptance.ts";
import { renderAcceptanceSVG, TARGET_LINE_CLASS } from "./svg.ts";
import { assertChampionContract } from "../common/champion_contract.ts";
import { renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { generateSyntheticData } from "../common/synthetic_data.ts";
import { asCreatureExport } from "../common/legacy_types.ts";

Deno.test("OPTIMAL_ACCEPTANCE_RATE is the canonical 0.234 target", () => {
  assertEquals(OPTIMAL_ACCEPTANCE_RATE, 0.234);
});

Deno.test("runMCMCAcceptance produces one record per iteration", () => {
  const result = runMCMCAcceptance({
    ...DEFAULT_MCMC_OPTIONS,
    iterations: 200,
  });
  assertEquals(result.proposals.length, 200);
  for (const r of result.proposals) {
    assert(Number.isFinite(r.deltaFitness), `deltaFitness must be finite, got ${r.deltaFitness}`);
    assertGreater(r.temperature, 0);
    assert(typeof r.accepted === "boolean");
  }
});

Deno.test("runMCMCAcceptance is deterministic for the same seed", () => {
  const a = runMCMCAcceptance({ ...DEFAULT_MCMC_OPTIONS, seed: 42, iterations: 150 });
  const b = runMCMCAcceptance({ ...DEFAULT_MCMC_OPTIONS, seed: 42, iterations: 150 });
  assertEquals(a.proposals.length, b.proposals.length);
  for (let i = 0; i < a.proposals.length; i++) {
    assertEquals(a.proposals[i].accepted, b.proposals[i].accepted);
    assertEquals(a.proposals[i].temperature, b.proposals[i].temperature);
    assertEquals(a.proposals[i].deltaFitness, b.proposals[i].deltaFitness);
  }
});

Deno.test("runMCMCAcceptance acceptance rate stays inside [0, 1]", () => {
  const result = runMCMCAcceptance({
    ...DEFAULT_MCMC_OPTIONS,
    iterations: 500,
  });
  for (const rate of result.movingAcceptance) {
    assert(Number.isFinite(rate), `acceptance rate must be finite, got ${rate}`);
    assertGreaterOrEqual(rate, 0);
    assertGreaterOrEqual(1, rate);
  }
  assertGreaterOrEqual(result.finalAcceptance, 0);
  assertGreaterOrEqual(1, result.finalAcceptance);
});

Deno.test("runMCMCAcceptance later windows are closer to 23.4% than early ones", () => {
  // Long enough run that the adaptive cooling has time to settle.
  const result = runMCMCAcceptance({
    ...DEFAULT_MCMC_OPTIONS,
    iterations: 4000,
  });
  const rates = windowedAcceptanceRates(result.proposals, 200);
  assertGreater(rates.length, 4);
  const earlyMean = mean(rates.slice(0, 3));
  const lateMean = mean(rates.slice(-3));
  const earlyDistance = Math.abs(earlyMean - OPTIMAL_ACCEPTANCE_RATE);
  const lateDistance = Math.abs(lateMean - OPTIMAL_ACCEPTANCE_RATE);
  assertGreater(
    earlyDistance,
    lateDistance,
    `expected late windows (${lateMean.toFixed(3)}) closer to 0.234 than ` +
      `early windows (${earlyMean.toFixed(3)})`,
  );
  // And the late mean must actually be near the target.
  assertAlmostEquals(lateMean, OPTIMAL_ACCEPTANCE_RATE, 0.1);
});

Deno.test("movingAverage produces a finite series of the input length", () => {
  const series = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
  const out = movingAverage(series, 4);
  assertEquals(out.length, series.length);
  for (const v of out) {
    assert(Number.isFinite(v));
    assertGreaterOrEqual(v, 0);
    assertGreaterOrEqual(1, v);
  }
  // Last few entries should sit near 0.5 since the input alternates.
  assertAlmostEquals(out[out.length - 1], 0.5, 0.05);
});

Deno.test("movingAverage throws when window <= 0", () => {
  let threw = false;
  try {
    movingAverage([0, 1], 0);
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for non-positive window");
});

Deno.test("windowedAcceptanceRates rejects window <= 0", () => {
  let threw = false;
  try {
    windowedAcceptanceRates([], 0);
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for non-positive window");
});

Deno.test("renderAcceptanceSVG produces a well-formed SVG with the target line", () => {
  const records: ProposalRecord[] = [];
  for (let i = 0; i < 50; i++) {
    records.push({
      iteration: i,
      accepted: i % 4 === 0,
      temperature: 1 - i / 100,
      deltaFitness: -0.1,
    });
  }
  const movingAcceptance = movingAverage(
    records.map((r) => (r.accepted ? 1 : 0)),
    10,
  );
  const svg = renderAcceptanceSVG({
    proposals: records,
    movingAcceptance,
    target: OPTIMAL_ACCEPTANCE_RATE,
  });
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes(TARGET_LINE_CLASS), "must include the 23.4% target line element");
  // Width and height attributes must be positive integers.
  const widthMatch = svg.match(/width="(\d+)"/);
  const heightMatch = svg.match(/height="(\d+)"/);
  assert(widthMatch);
  assert(heightMatch);
  assertGreater(Number.parseInt(widthMatch![1], 10), 0);
  assertGreater(Number.parseInt(heightMatch![1], 10), 0);
  // Both series must be embedded as polylines.
  const polylines = svg.match(/<polyline /g) ?? [];
  assertGreaterOrEqual(polylines.length, 2);
  // Target value text must be rendered.
  assert(svg.includes("23.4"), "SVG should label the 23.4% target");
});

Deno.test("renderAcceptanceSVG throws when the input series are empty", () => {
  let threw = false;
  try {
    renderAcceptanceSVG({
      proposals: [],
      movingAcceptance: [],
      target: 0.234,
    });
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for empty input");
});

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/* ------------------------------------------------------------------ */
/*  Audit #215 — minimal-seed evolution (milestone summary path)       */
/* ------------------------------------------------------------------ */

Deno.test("createOracleCreature returns a valid 3-input / 1-output topology", () => {
  const json = createOracleCreature();
  assertEquals(json.input, 3);
  assertEquals(json.output, 1);

  const inputs = json.neurons.filter((n) => n.type === "input");
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  const outputs = json.neurons.filter((n) => n.type === "output");
  assertEquals(inputs.length, 3);
  assertGreater(hidden.length, 0, "oracle must have at least one hidden neuron");
  assertEquals(outputs.length, 1);

  // Round-trip via the library: must validate and produce a finite
  // output for any input vector.
  const oracle = Creature.fromJSON(asCreatureExport(json));
  oracle.validate();
  oracle.clearState();
  const out = oracle.activate(new Float32Array([0.2, -0.4, 0.7]));
  assertEquals(out.length, 1);
  assertEquals(Number.isFinite(out[0]), true);
});

Deno.test("DEFAULT_MCMC_EVOLUTION_CONFIG honours the audit's stop-condition rule", () => {
  // Issue #215 mandated a per-example targetError plus a 5-minute
  // timeoutMinutes safety backstop. Issue #381 grants +15 minutes of
  // additional evolution budget for the Refresh-2026-05 milestone, so
  // the backstop is now permitted to be >= 5 minutes (the upstream
  // contract: the audit's stop-condition rule must continue to hold,
  // but the example may carry a larger budget when refresh issues
  // require it).
  assertGreater(DEFAULT_MCMC_EVOLUTION_CONFIG.targetError, 0);
  assertGreaterOrEqual(
    DEFAULT_MCMC_EVOLUTION_CONFIG.timeoutMinutes,
    5,
    "timeoutMinutes must be at least the issue #215 backstop (issue #381 grants +15 min)",
  );
  assertGreater(DEFAULT_MCMC_EVOLUTION_CONFIG.populationSize, 0);
  assertGreater(DEFAULT_MCMC_EVOLUTION_CONFIG.maxIterations, 0);
});

Deno.test("INPUT_COUNT and OUTPUT_COUNT match the oracle's I/O shape", () => {
  // Guards against the seed shape drifting away from the labelled set.
  const json = createOracleCreature();
  assertEquals(INPUT_COUNT, json.input);
  assertEquals(OUTPUT_COUNT, json.output);
});

Deno.test("runMinimalSeedEvolution rejects non-positive config values", async () => {
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const dataDir = Deno.makeTempDirSync({ prefix: "neat_test_" });
  try {
    let threw = false;
    try {
      await runMinimalSeedEvolution(seed, dataDir, {
        targetError: 0,
        timeoutMinutes: 1,
        populationSize: 4,
        maxIterations: 1,
        seed: 1,
      });
    } catch (err) {
      threw = true;
      assertEquals(err instanceof Error, true);
    }
    assertEquals(threw, true, "zero targetError must throw");
  } finally {
    Deno.removeSync(dataDir, { recursive: true });
  }
});

Deno.test(
  "runMinimalSeedEvolution evolves from new Creature(input, output) and returns a milestone summary",
  async () => {
    const tmpDir = Deno.makeTempDirSync({ prefix: "neat_test_" });
    const dataDir = join(tmpDir, "data");
    ensureDirSync(dataDir);
    try {
      const oracle = Creature.fromJSON(asCreatureExport(createOracleCreature()));
      oracle.validate();
      generateSyntheticData(oracle, dataDir, {
        totalRecords: 64,
        recordsPerFile: 64,
        seed: 42,
      });

      const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      const seedNeurons = seed.neurons.length;
      const seedSynapses = seed.synapses.length;

      const result = await runMinimalSeedEvolution(seed, dataDir, {
        targetError: 0.001,
        timeoutMinutes: 1,
        populationSize: 8,
        maxIterations: 5,
        seed: 215,
      });

      // Observable contract (#725): the champion validates, keeps the seed's
      // arity, and activates to finite output — regardless of whether NEAT-AI
      // mutates the seed in place or hands back a fresh creature.
      assertChampionContract(result.champion, { input: INPUT_COUNT, output: OUTPUT_COUNT });

      // Summary contract — all numeric fields finite, topology matches champion.
      assertEquals(Number.isFinite(result.summary.finalError), true);
      assertEquals(Number.isFinite(result.summary.finalScore), true);
      assertEquals(result.summary.seedNeurons, seedNeurons);
      assertEquals(result.summary.seedSynapses, seedSynapses);
      assertEquals(result.summary.finalNeurons, result.champion.neurons.length);
      assertEquals(result.summary.finalSynapses, result.champion.synapses.length);
      assertGreater(result.summary.generations, 0);
      assertEquals(result.seedNeuronCount, seedNeurons);
      assertEquals(result.seedSynapseCount, seedSynapses);
      assertGreaterOrEqual(result.wallClockMs, 0);
    } finally {
      Deno.removeSync(tmpDir, { recursive: true });
    }
  },
);

Deno.test("renderEvolveDirSummarySvg renders a summary derived from runMinimalSeedEvolution", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);
  try {
    const oracle = Creature.fromJSON(asCreatureExport(createOracleCreature()));
    oracle.validate();
    generateSyntheticData(oracle, dataDir, {
      totalRecords: 64,
      recordsPerFile: 64,
      seed: 42,
    });

    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const result = await runMinimalSeedEvolution(seed, dataDir, {
      targetError: 0.5,
      timeoutMinutes: 1,
      populationSize: 4,
      maxIterations: 3,
      seed: 7,
    });

    const svg = renderEvolveDirSummarySvg(result.summary, {
      title: "MCMC Acceptance — evolveDir Run Summary",
    });
    assert(svg.startsWith("<svg"));
    assert(svg.includes("</svg>"));
    // Numeric callouts for the four summary rows are present.
    assert(svg.includes("final error"));
    assert(svg.includes("final score"));
    assert(svg.includes("generations"));
    assert(svg.includes("wall clock"));
    // Topology counts appear as bar labels.
    assert(svg.includes(String(result.summary.seedNeurons)));
    assert(svg.includes(String(result.summary.finalNeurons)));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
