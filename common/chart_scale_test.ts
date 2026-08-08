/**
 * Unit tests for the shared chart-geometry maths.
 *
 * These are "what" tests — every case calls a real helper with known
 * input and asserts on the returned scale value or tick list, never on
 * how the helper computes it.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import {
  logTicks,
  makeScale,
  makeXScale,
  maxBy,
  minBy,
  niceStep,
  niceTicks,
} from "./chart_scale.ts";

Deno.test("minBy / maxBy: report the extent of the accessed field", () => {
  const items = [{ v: 3 }, { v: -1 }, { v: 7.5 }];
  assertEquals(minBy(items, (i) => i.v), -1);
  assertEquals(maxBy(items, (i) => i.v), 7.5);
});

Deno.test("minBy / maxBy: empty input yields the identity extremes", () => {
  assertEquals(minBy([], (n: number) => n), Infinity);
  assertEquals(maxBy([], (n: number) => n), -Infinity);
});

Deno.test("makeScale: maps the domain linearly onto the range", () => {
  const scale = makeScale(0, 10, 100, 300);
  assertEquals(scale(0), 100);
  assertEquals(scale(10), 300);
  assertEquals(scale(5), 200);
  // Extrapolation past the domain stays linear.
  assertEquals(scale(20), 500);
});

Deno.test("makeScale: supports an inverted range (SVG y grows downward)", () => {
  const scale = makeScale(0, 1, 340, 40);
  assertEquals(scale(0), 340);
  assertEquals(scale(1), 40);
  assertEquals(scale(0.5), 190);
});

Deno.test("makeScale: degenerate domain collapses to the range centre", () => {
  const scale = makeScale(4, 4, 100, 300);
  assertEquals(scale(4), 200);
  assertEquals(scale(-99), 200);
  assertEquals(scale(1e6), 200);
});

Deno.test("makeXScale: linear mode matches a plain linear scale", () => {
  const linear = makeXScale(1, 100, 70, 730, false);
  const plain = makeScale(1, 100, 70, 730);
  for (const v of [1, 25, 50, 100]) {
    assertAlmostEquals(linear(v), plain(v), 1e-9);
  }
});

Deno.test("makeXScale: log mode spaces decades evenly", () => {
  const scale = makeXScale(1, 1000, 0, 300, true);
  assertAlmostEquals(scale(1), 0, 1e-9);
  assertAlmostEquals(scale(10), 100, 1e-9);
  assertAlmostEquals(scale(100), 200, 1e-9);
  assertAlmostEquals(scale(1000), 300, 1e-9);
});

Deno.test("makeXScale: log mode clamps values below 1 instead of diverging", () => {
  const scale = makeXScale(0, 1000, 0, 300, true);
  const atOne = scale(1);
  assert(Number.isFinite(atOne), "log scale must stay finite at 1");
  assertEquals(scale(0), atOne, "generation 0 is clamped onto generation 1");
  assertEquals(scale(-5), atOne, "negative input is clamped onto generation 1");
});

Deno.test("makeXScale: log mode over a single decade is degenerate but finite", () => {
  const scale = makeXScale(10, 10, 0, 300, true);
  assertEquals(scale(10), 150);
});

Deno.test("niceTicks: degenerate range yields the single value", () => {
  assertEquals(niceTicks(5, 5, 5, false), [5]);
  assertEquals(niceTicks(4.6, 4.6, 5, true), [5]);
});

Deno.test("niceTicks: integer mode returns whole, ascending, unique ticks", () => {
  const ticks = niceTicks(0, 37, 5, true);
  assert(ticks.length > 1, "expected multiple ticks");
  for (const t of ticks) {
    assertEquals(Number.isInteger(t), true, `tick ${t} must be an integer`);
  }
  assertEquals(new Set(ticks).size, ticks.length, "ticks must be unique");
  assertEquals(ticks[ticks.length - 1], 37, "the upper bound is always a tick");
  for (let i = 1; i < ticks.length; i++) {
    assert(ticks[i] > ticks[i - 1], "ticks must ascend");
  }
});

Deno.test("niceTicks: integer mode spans a tiny range without duplicates", () => {
  assertEquals(niceTicks(0, 2, 5, true), [0, 1, 2]);
});

Deno.test("niceTicks: continuous mode starts at min and ends at max", () => {
  const ticks = niceTicks(0, 0.05, 5, false);
  assertEquals(ticks[0], 0);
  assertEquals(ticks[ticks.length - 1], 0.05);
  assert(ticks.length >= 3, `expected several ticks, got ${ticks.length}`);
  for (const t of ticks) {
    assert(t >= 0 && t <= 0.05, `tick ${t} outside [0, 0.05]`);
  }
});

Deno.test("niceTicks: every tick lies inside the requested range", () => {
  for (const [min, max] of [[0, 1], [0, 1000], [-5, 5], [0.25, 0.75]]) {
    for (const integerOnly of [true, false]) {
      for (const t of niceTicks(min, max, 5, integerOnly)) {
        assert(
          t >= Math.floor(min) - 1e-9 && t <= Math.ceil(max) + 1e-9,
          `tick ${t} outside [${min}, ${max}] (integerOnly=${integerOnly})`,
        );
      }
    }
  }
});

Deno.test("logTicks: emits powers of ten plus the bounds", () => {
  assertEquals(logTicks(1, 1000), [1, 10, 100, 1000]);
  assertEquals(logTicks(1, 5000), [1, 10, 100, 1000, 5000]);
  assertEquals(logTicks(3, 300), [3, 10, 100, 300]);
});

Deno.test("logTicks: clamps a sub-1 lower bound and stays ascending + unique", () => {
  const ticks = logTicks(0, 250);
  assertEquals(ticks[0], 1, "lower bound is clamped to 1 (log(0) is undefined)");
  assertEquals(ticks[ticks.length - 1], 250);
  assertEquals(new Set(ticks).size, ticks.length, "ticks must be unique");
  for (let i = 1; i < ticks.length; i++) {
    assert(ticks[i] > ticks[i - 1], "ticks must ascend");
  }
});

Deno.test("logTicks: an inverted range collapses to a single tick", () => {
  assertEquals(logTicks(100, 10), [100]);
});

Deno.test("niceStep: follows the 1-2-5-10 progression", () => {
  assertEquals(niceStep(1), 1);
  assertEquals(niceStep(1.4), 1);
  assertEquals(niceStep(2.9), 2);
  assertEquals(niceStep(6.9), 5);
  assertEquals(niceStep(9), 10);
  assertEquals(niceStep(0.11), 0.1);
  assertEquals(niceStep(230), 200);
});

Deno.test("niceStep: a non-positive raw step falls back to 1", () => {
  assertEquals(niceStep(0), 1);
  assertEquals(niceStep(-3), 1);
});
