/**
 * Unit tests for the multi-run error-curve SVG chart renderer.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `renderMultiRunErrorChartSVG` (returned SVG string contents, structure,
 * deterministic output, run-boundary markers) without inspecting how the
 * renderer builds it.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import type { MultiRunMilestone } from "./multi_run_state.ts";
import { renderMultiRunErrorChartSVG } from "./multi_run_error_chart.ts";

/** Build a two-run milestone series across the canonical generation schedule. */
function makeMultiRunSeries(): MultiRunMilestone[] {
  const gensPerRun = [1, 10, 100, 1000];
  const samples: MultiRunMilestone[] = [];

  // Run 1 — error drops from 0.9 to 0.3 over the run.
  gensPerRun.forEach((g, i) => {
    samples.push({
      runIndex: 1,
      runGen: g,
      cumulativeGen: g,
      error: 0.9 - i * 0.2,
      bestScore: 0.1 + i * 0.2,
      neurons: 4 + i,
      synapses: 6 + i * 2,
      generationWallClockMs: 100 + i * 50,
    });
  });

  // Run 2 — continues the cumulative arc and keeps improving.
  const base = 1000;
  gensPerRun.forEach((g, i) => {
    samples.push({
      runIndex: 2,
      runGen: g,
      cumulativeGen: base + g,
      error: 0.25 - i * 0.05,
      bestScore: 0.7 + i * 0.05,
      neurons: 8 + i,
      synapses: 14 + i * 2,
      generationWallClockMs: 200 + i * 60,
    });
  });

  return samples;
}

Deno.test("renderMultiRunErrorChartSVG: happy path emits valid SVG with error polyline and axes", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunErrorChartSVG(samples, { title: "Multi-run Test" });

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  assertStringIncludes(svg, "Multi-run Test");

  // Error series must be plotted.
  assertStringIncludes(svg, "error-line");

  // Both axes present.
  assertStringIncludes(svg, "x-axis");
  assertStringIncludes(svg, "y-axis");

  // No NaN/Infinity leaks into the output.
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderMultiRunErrorChartSVG: run-boundary markers render at each runIndex transition", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunErrorChartSVG(samples);

  // Two distinct runs → one boundary transition → one marker.
  const markers = svg.match(/class="run-boundary"/g) ?? [];
  assertEquals(markers.length, 1);

  // Boundary label naming the second run.
  assertStringIncludes(svg, "run 2");
});

Deno.test("renderMultiRunErrorChartSVG: three runs produce two boundary markers", () => {
  const samples = makeMultiRunSeries();
  // Append a third run.
  samples.push(
    {
      runIndex: 3,
      runGen: 1,
      cumulativeGen: 2001,
      error: 0.05,
      bestScore: 0.95,
      neurons: 13,
      synapses: 24,
      generationWallClockMs: 300,
    },
    {
      runIndex: 3,
      runGen: 10,
      cumulativeGen: 2010,
      error: 0.02,
      bestScore: 0.98,
      neurons: 14,
      synapses: 26,
      generationWallClockMs: 320,
    },
  );

  const svg = renderMultiRunErrorChartSVG(samples);
  const markers = svg.match(/class="run-boundary"/g) ?? [];
  assertEquals(markers.length, 2);
  assertStringIncludes(svg, "run 2");
  assertStringIncludes(svg, "run 3");
});

Deno.test("renderMultiRunErrorChartSVG: single run produces no boundary markers", () => {
  const samples: MultiRunMilestone[] = [
    {
      runIndex: 1,
      runGen: 1,
      cumulativeGen: 1,
      error: 0.9,
      bestScore: 0.1,
      neurons: 4,
      synapses: 6,
      generationWallClockMs: 100,
    },
    {
      runIndex: 1,
      runGen: 10,
      cumulativeGen: 10,
      error: 0.5,
      bestScore: 0.5,
      neurons: 5,
      synapses: 8,
      generationWallClockMs: 150,
    },
  ];

  const svg = renderMultiRunErrorChartSVG(samples);
  const markers = svg.match(/class="run-boundary"/g) ?? [];
  assertEquals(markers.length, 0);
});

Deno.test("renderMultiRunErrorChartSVG: empty input throws a clear error", () => {
  assertThrows(
    () => renderMultiRunErrorChartSVG([]),
    Error,
    "at least one sample",
  );
});

Deno.test("renderMultiRunErrorChartSVG: deterministic — identical input produces identical output", () => {
  const samples = makeMultiRunSeries();
  const a = renderMultiRunErrorChartSVG(samples, { width: 800, height: 400, title: "Run" });
  const b = renderMultiRunErrorChartSVG(samples, { width: 800, height: 400, title: "Run" });
  assertEquals(a, b);
});

Deno.test("renderMultiRunErrorChartSVG: zero / near-zero error values do not leak NaN or Infinity", () => {
  const samples: MultiRunMilestone[] = [
    {
      runIndex: 1,
      runGen: 1,
      cumulativeGen: 1,
      error: 0,
      bestScore: 1,
      neurons: 4,
      synapses: 6,
      generationWallClockMs: 100,
    },
    {
      runIndex: 1,
      runGen: 10,
      cumulativeGen: 10,
      error: 1e-12,
      bestScore: 1,
      neurons: 5,
      synapses: 8,
      generationWallClockMs: 120,
    },
  ];

  const svg = renderMultiRunErrorChartSVG(samples);
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderMultiRunErrorChartSVG: caption summarises final error, runs, cumulative generations and total wall-clock", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunErrorChartSVG(samples, { caption: true });

  assertStringIncludes(svg, "caption");

  // Total runs = 2.
  assertStringIncludes(svg, "2 runs");

  // Cumulative generation maximum = 2000 (1000 + 1000).
  assertStringIncludes(svg, "2000");

  // Total wall-clock = sum of generationWallClockMs across all samples.
  const totalMs = samples.reduce((acc, s) => acc + s.generationWallClockMs, 0);
  assertStringIncludes(svg, `${totalMs} ms`);
});

Deno.test("renderMultiRunErrorChartSVG: caption defaults to off", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunErrorChartSVG(samples);
  assert(
    !svg.includes('class="caption"'),
    "caption must not appear when the option is omitted",
  );
});

Deno.test("renderMultiRunErrorChartSVG: log-x layout differs from linear", () => {
  const samples = makeMultiRunSeries();
  const linear = renderMultiRunErrorChartSVG(samples, { logX: false, title: "Run" });
  const log = renderMultiRunErrorChartSVG(samples, { logX: true, title: "Run" });

  assertStringIncludes(linear, "<svg");
  assertStringIncludes(log, "<svg");
  assert(
    linear !== log,
    "logX layout should differ from linear layout for power-of-ten spaced generations",
  );
});

Deno.test("renderMultiRunErrorChartSVG: unsorted input is sorted by cumulativeGen", () => {
  const samples = makeMultiRunSeries();
  // Reverse the array — the renderer must produce the same SVG regardless.
  const reversed = [...samples].reverse();

  const ordered = renderMultiRunErrorChartSVG(samples);
  const shuffled = renderMultiRunErrorChartSVG(reversed);
  assertEquals(ordered, shuffled);
});
