/**
 * Unit tests for the MCMC mutation-acceptance demo (issue #89).
 *
 * "What" tests only — each test calls a real function and asserts on
 * observable outputs (record structure, summary statistics, SVG
 * structure). No greps over source files.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
} from "@std/assert";

import {
  DEFAULT_MCMC_OPTIONS,
  movingAverage,
  OPTIMAL_ACCEPTANCE_RATE,
  type ProposalRecord,
  runMCMCAcceptance,
  windowedAcceptanceRates,
} from "./mcmc_acceptance.ts";
import { renderAcceptanceSVG, TARGET_LINE_CLASS } from "./svg.ts";

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
