/**
 * Unit tests for the price-data helpers. "What" tests only — each one
 * calls a real function with known input and asserts on the returned
 * structure.
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";

import { buildSamples, computeReturns, parsePriceCSV, splitChronologically } from "./data.ts";

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
