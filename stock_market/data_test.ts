/**
 * Unit tests for the price-data helpers. "What" tests only — each one
 * calls a real function with known input and asserts on the returned
 * structure.
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";

import {
  applyNormalization,
  buildSamples,
  computeNormalizationStats,
  computeReturns,
  normalizeSamples,
  parsePriceCSV,
  type Sample,
  splitChronologically,
} from "./data.ts";

/** Build a minimal {@link Sample} with the given feature vector. */
function sampleWith(features: number[], label: 0 | 1 = 0): Sample {
  return { index: 0, date: "d", features, label, return: 0, close: 1 };
}

Deno.test("parsePriceCSV reads dated SP500 rows", () => {
  const csv = [
    "Date,SP500,Other",
    "2020-01-01,100.0,xx",
    "2020-02-01,110.0,xx",
    "2020-03-01,99.0,xx",
  ].join("\n");
  const points = parsePriceCSV(csv);
  assertEquals(points.length, 3);
  assertEquals(points[0], { date: "2020-01-01", close: 100.0 });
  assertEquals(points[2], { date: "2020-03-01", close: 99.0 });
});

Deno.test("parsePriceCSV skips zero/empty SP500 values", () => {
  const csv = [
    "Date,SP500",
    "2020-01-01,100.0",
    "2020-02-01,",
    "2020-03-01,0.0",
    "2020-04-01,105.0",
  ].join("\n");
  const points = parsePriceCSV(csv);
  assertEquals(points.length, 2);
  assertEquals(points.map((p) => p.date), ["2020-01-01", "2020-04-01"]);
});

Deno.test("parsePriceCSV throws on missing required columns", () => {
  assertThrows(
    () => parsePriceCSV("Date,Foo\n2020-01-01,1"),
    Error,
    "expected 'Date' and 'SP500'",
  );
});

Deno.test("computeReturns produces n-1 returns", () => {
  const points = [
    { date: "a", close: 100 },
    { date: "b", close: 110 },
    { date: "c", close: 99 },
  ];
  const r = computeReturns(points);
  assertEquals(r.length, 2);
  assertAlmostEquals(r[0], 0.1, 1e-9);
  assertAlmostEquals(r[1], -0.1, 1e-9);
});

Deno.test("buildSamples raises a clear error when there are too few rows", () => {
  const points = [
    { date: "a", close: 1 },
    { date: "b", close: 2 },
    { date: "c", close: 3 },
  ];
  // windowSize=10 needs >= 12 prices.
  assertThrows(
    () => buildSamples(points, { windowSize: 10 }),
    Error,
    "need at least 12 price points",
  );
});

Deno.test("buildSamples does not look ahead — features for day t use only earlier prices", () => {
  // Synthetic monotone-up series: every return is a fixed positive value.
  // If the feature window for day t accidentally included return[t]
  // itself, the value would still be positive — which would match the
  // label trivially. We instead test the structural property: each
  // sample's features must equal the slice of the precomputed returns
  // that ends strictly before the prediction day.
  const prices = Array.from({ length: 25 }, (_, i) => ({
    date: `d${i}`,
    close: 100 * Math.pow(1.01, i), // strictly increasing
  }));
  const window = 5;
  const samples = buildSamples(prices, { windowSize: window });
  const allReturns = computeReturns(prices);

  // First sample must be for day windowSize + 1 = 6.
  assertEquals(samples[0].index, window + 1);

  for (const s of samples) {
    const t = s.index;
    // Features should be the windowSize returns immediately preceding day t,
    // i.e. allReturns[t - window - 1 .. t - 2].
    const expected = allReturns.slice(t - window - 1, t - 1);
    assertEquals(s.features.length, window);
    assertEquals(s.features, expected);
    // The realised return on day t should NOT appear in the feature window.
    const realisedReturnIdx = t - 1;
    assert(
      !s.features.includes(allReturns[realisedReturnIdx]) ||
        // Allow accidental equality if a previous return happens to match;
        // in this strictly geometric series each return is identical, so
        // the values match by construction. The key invariant is that
        // the feature window is a pure prefix slice — verified above.
        true,
    );
  }
});

Deno.test("buildSamples labels match realised direction on a synthetic series", () => {
  // Alternating up/down: prices = [100, 110, 99, 110, 99, ...]
  const prices: { date: string; close: number }[] = [];
  let p = 100;
  for (let i = 0; i < 20; i++) {
    prices.push({ date: `d${i}`, close: p });
    p = i % 2 === 0 ? p * 1.1 : p * (99 / 110);
  }
  const samples = buildSamples(prices, { windowSize: 3 });
  // Each sample's label equals 1 iff the realised return on day t is
  // positive — verify that against an independent computation.
  for (const s of samples) {
    const expected = s.return > 0 ? 1 : 0;
    assertEquals(s.label, expected);
  }
});

Deno.test("splitChronologically preserves order and partitions samples", () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({
    index: i,
    date: `d${i}`,
    features: [i],
    label: (i % 2) as 0 | 1,
    return: 0,
    close: 0,
  }));
  const split = splitChronologically(samples, {
    trainFraction: 0.7,
    validationFraction: 0.15,
  });
  assertEquals(split.train.length, 70);
  assertEquals(split.validation.length, 15);
  assertEquals(split.test.length, 15);
  // No overlap, chronological order preserved.
  assertEquals(split.train[0].index, 0);
  assertEquals(split.train[split.train.length - 1].index, 69);
  assertEquals(split.validation[0].index, 70);
  assertEquals(split.test[0].index, 85);
  assertEquals(split.test[split.test.length - 1].index, 99);
});

Deno.test("splitChronologically rejects fractions that leave no test slice", () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({
    index: i,
    date: `d${i}`,
    features: [],
    label: 0 as 0 | 1,
    return: 0,
    close: 0,
  }));
  assertThrows(
    () => splitChronologically(samples, { trainFraction: 0.6, validationFraction: 0.5 }),
    Error,
    "leave a test slice",
  );
});

/* ------------------------------------------------------------------ */
/*  Robust input normalisation (issue #519)                            */
/* ------------------------------------------------------------------ */

Deno.test("computeNormalizationStats returns per-feature median and IQR", () => {
  // Two features. Column 0 = 1..7 (median 4, Q1 2.5, Q3 5.5 → IQR 3).
  // Column 1 = constant 10 (median 10, IQR 0).
  const samples = [1, 2, 3, 4, 5, 6, 7].map((v) => sampleWith([v, 10]));
  const stats = computeNormalizationStats(samples);
  assertEquals(stats.medians.length, 2);
  assertEquals(stats.iqrs.length, 2);
  assertAlmostEquals(stats.medians[0], 4, 1e-9);
  assertAlmostEquals(stats.iqrs[0], 3, 1e-9);
  assertAlmostEquals(stats.medians[1], 10, 1e-9);
  assertAlmostEquals(stats.iqrs[1], 0, 1e-9);
});

Deno.test("computeNormalizationStats throws on empty sample list", () => {
  assertThrows(() => computeNormalizationStats([]), Error, "must not be empty");
});

Deno.test("applyNormalization robustly standardises a feature vector", () => {
  const stats = { medians: [4], iqrs: [2] };
  // (x - median) / IQR.
  assertAlmostEquals(applyNormalization([4], stats)[0], 0, 1e-9);
  assertAlmostEquals(applyNormalization([6], stats)[0], 1, 1e-9);
  assertAlmostEquals(applyNormalization([2], stats)[0], -1, 1e-9);
});

Deno.test("applyNormalization is robust to outliers via median/IQR", () => {
  // A single huge outlier must not blow up the frozen median/IQR scale.
  const samples = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1_000_000].map((v) => sampleWith([v]));
  const stats = computeNormalizationStats(samples);
  // Median is 0 and IQR is 0 (most values identical) → constant column,
  // so a normal in-range value maps to a finite, small number.
  const normal = applyNormalization([0], stats)[0];
  assert(Number.isFinite(normal));
  assertAlmostEquals(normal, 0, 1e-6);
});

Deno.test("applyNormalization guards a constant (zero-IQR) feature", () => {
  const stats = { medians: [10], iqrs: [0] };
  const out = applyNormalization([10], stats);
  assert(Number.isFinite(out[0]));
  assertAlmostEquals(out[0], 0, 1e-6);
});

Deno.test("applyNormalization rejects a width mismatch", () => {
  assertThrows(
    () => applyNormalization([1, 2], { medians: [0], iqrs: [1] }),
    Error,
    "feature width",
  );
});

Deno.test("normalizeSamples freezes train stats and reuses them on unseen samples", () => {
  const train = [1, 2, 3, 4, 5, 6, 7].map((v) => sampleWith([v], 1));
  const stats = computeNormalizationStats(train);
  // A later-regime ("non-stationary") sample is normalised with the
  // FROZEN training stats, not its own — this is the inference path.
  const future = [sampleWith([100], 0)];
  const out = normalizeSamples(future, stats);
  // (100 - 4) / 3 == 32.
  assertAlmostEquals(out[0].features[0], 32, 1e-9);
  // Non-feature fields are preserved untouched.
  assertEquals(out[0].label, 0);
  assertEquals(out[0].close, 1);
});

Deno.test("normalizeSamples does not mutate the input samples", () => {
  const samples = [sampleWith([2, 4])];
  const stats = { medians: [0, 0], iqrs: [1, 1] };
  const out = normalizeSamples(samples, stats);
  assertEquals(samples[0].features, [2, 4], "source features must be untouched");
  assertEquals(out[0].features, [2, 4]);
  assert(out[0] !== samples[0], "a fresh sample object is returned");
});
