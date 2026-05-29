/**
 * Unit tests for the multi-run complexity-curve SVG chart renderer.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `renderMultiRunComplexityChartSVG` (returned SVG string contents,
 * structure, deterministic output, run-boundary markers) without
 * inspecting how the renderer builds it.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import type { MultiRunMilestone } from "./multi_run_state.ts";
import { renderMultiRunComplexityChartSVG } from "./multi_run_complexity_chart.ts";

/** Build a two-run milestone series across the canonical generation schedule. */
function makeMultiRunSeries(): MultiRunMilestone[] {
  const gensPerRun = [1, 10, 100, 1000];
  const samples: MultiRunMilestone[] = [];

  // Run 1 — neurons and synapses grow as topology complexifies.
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

  // Run 2 — topology continues to grow.
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

Deno.test("renderMultiRunComplexityChartSVG: happy path emits valid SVG with both polylines and dual axes", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunComplexityChartSVG(samples, { title: "Multi-run Complexity Test" });

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  assertStringIncludes(svg, "Multi-run Complexity Test");

  // Both series must be plotted (one polyline segment per run each).
  assertStringIncludes(svg, "neurons-line");
  assertStringIncludes(svg, "synapses-line");
  assertEquals(
    (svg.match(/<polyline fill="none" stroke="#2ca02c"/g) ?? []).length,
    2,
  );
  assertEquals(
    (svg.match(/<polyline fill="none" stroke="#d62728"/g) ?? []).length,
    2,
  );

  // Dual axes plus shared x axis present.
  assertStringIncludes(svg, "x-axis");
  assertStringIncludes(svg, "left-axis");
  assertStringIncludes(svg, "right-axis");

  // Legend names both series.
  assertStringIncludes(svg, "neurons");
  assertStringIncludes(svg, "synapses");

  // No NaN/Infinity leaks into the output.
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderMultiRunComplexityChartSVG: run-boundary markers render at each runIndex transition", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunComplexityChartSVG(samples);

  // Two distinct runs → one boundary transition → one marker.
  const markers = svg.match(/class="run-boundary"/g) ?? [];
  assertEquals(markers.length, 1);

  // Boundary label naming the second run.
  assertStringIncludes(svg, "run 2");
});

Deno.test("renderMultiRunComplexityChartSVG: three runs produce two boundary markers", () => {
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

  const svg = renderMultiRunComplexityChartSVG(samples);
  const markers = svg.match(/class="run-boundary"/g) ?? [];
  assertEquals(markers.length, 2);
  assertStringIncludes(svg, "run 2");
  assertStringIncludes(svg, "run 3");
});

Deno.test("renderMultiRunComplexityChartSVG: single run produces no boundary markers", () => {
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

  const svg = renderMultiRunComplexityChartSVG(samples);
  const markers = svg.match(/class="run-boundary"/g) ?? [];
  assertEquals(markers.length, 0);
});

Deno.test("renderMultiRunComplexityChartSVG: empty input throws a clear error", () => {
  assertThrows(
    () => renderMultiRunComplexityChartSVG([]),
    Error,
    "at least one sample",
  );
});

Deno.test("renderMultiRunComplexityChartSVG: deterministic — identical input produces identical output", () => {
  const samples = makeMultiRunSeries();
  const a = renderMultiRunComplexityChartSVG(samples, { width: 800, height: 400, title: "Run" });
  const b = renderMultiRunComplexityChartSVG(samples, { width: 800, height: 400, title: "Run" });
  assertEquals(a, b);
});

Deno.test("renderMultiRunComplexityChartSVG: identical neuron + synapse counts do not leak NaN or Infinity", () => {
  const samples: MultiRunMilestone[] = [
    {
      runIndex: 1,
      runGen: 1,
      cumulativeGen: 1,
      error: 0.5,
      bestScore: 0.5,
      neurons: 4,
      synapses: 6,
      generationWallClockMs: 100,
    },
    {
      runIndex: 1,
      runGen: 10,
      cumulativeGen: 10,
      error: 0.4,
      bestScore: 0.6,
      neurons: 4,
      synapses: 6,
      generationWallClockMs: 120,
    },
  ];

  const svg = renderMultiRunComplexityChartSVG(samples);
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderMultiRunComplexityChartSVG: caption summarises final neuron + synapse counts and total runs", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunComplexityChartSVG(samples, { caption: true });

  assertStringIncludes(svg, "caption");

  // Total runs = 2.
  assertStringIncludes(svg, "2 runs");

  // Final neurons + synapses from the last sample.
  const last = samples[samples.length - 1];
  assertStringIncludes(svg, `${last.neurons} neurons`);
  assertStringIncludes(svg, `${last.synapses} synapses`);
});

Deno.test("renderMultiRunComplexityChartSVG: caption defaults to off", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunComplexityChartSVG(samples);
  assert(
    !svg.includes('class="caption"'),
    "caption must not appear when the option is omitted",
  );
});

Deno.test("renderMultiRunComplexityChartSVG: log-x layout differs from linear", () => {
  const samples = makeMultiRunSeries();
  const linear = renderMultiRunComplexityChartSVG(samples, { logX: false, title: "Run" });
  const log = renderMultiRunComplexityChartSVG(samples, { logX: true, title: "Run" });

  assertStringIncludes(linear, "<svg");
  assertStringIncludes(log, "<svg");
  assert(
    linear !== log,
    "logX layout should differ from linear layout for power-of-ten spaced generations",
  );
});

Deno.test("renderMultiRunComplexityChartSVG: unsorted input is sorted by cumulativeGen", () => {
  const samples = makeMultiRunSeries();
  // Reverse the array — the renderer must produce the same SVG regardless.
  const reversed = [...samples].reverse();

  const ordered = renderMultiRunComplexityChartSVG(samples);
  const shuffled = renderMultiRunComplexityChartSVG(reversed);
  assertEquals(ordered, shuffled);
});

Deno.test("renderMultiRunComplexityChartSVG: default title mentions creature complexity", () => {
  const samples = makeMultiRunSeries();
  const svg = renderMultiRunComplexityChartSVG(samples);
  assertStringIncludes(svg, "complexity");
});

// ---------------------------------------------------------------------------
// Boundary thinning (issue #521)
// ---------------------------------------------------------------------------

/** Synthesise an N-run milestone series with one sample per run. */
function makeNRunSeries(runCount: number): MultiRunMilestone[] {
  const samples: MultiRunMilestone[] = [];
  for (let r = 1; r <= runCount; r++) {
    samples.push({
      runIndex: r,
      runGen: 10,
      cumulativeGen: r * 10,
      error: 0.5,
      bestScore: 0.5,
      neurons: 4 + r,
      synapses: 6 + r * 2,
      generationWallClockMs: 100,
    });
  }
  return samples;
}

function countBoundaryLabels(svg: string): number {
  const block = svg.match(
    /<g class="run-boundaries"[\s\S]*?<\/g>/,
  );
  if (!block) return 0;
  return (block[0].match(/<text[^>]*>run \d+<\/text>/g) ?? []).length;
}

function countBoundaryTicks(svg: string): number {
  return (svg.match(/<line class="run-boundary"/g) ?? []).length;
}

Deno.test(
  "renderMultiRunComplexityChartSVG: ≤10 runs renders every boundary (issue #521)",
  () => {
    for (const runCount of [1, 2, 5, 10]) {
      const svg = renderMultiRunComplexityChartSVG(makeNRunSeries(runCount));
      const expectedBoundaries = runCount - 1;
      assertEquals(
        countBoundaryLabels(svg),
        expectedBoundaries,
        `runCount=${runCount}: expected ${expectedBoundaries} labels`,
      );
      assertEquals(
        countBoundaryTicks(svg),
        expectedBoundaries,
        `runCount=${runCount}: tick count must match label count`,
      );
    }
  },
);

Deno.test(
  "renderMultiRunComplexityChartSVG: 50 runs caps boundary labels at 10 (issue #521)",
  () => {
    const svg = renderMultiRunComplexityChartSVG(makeNRunSeries(50));
    const labels = countBoundaryLabels(svg);
    assert(labels <= 10, `expected ≤10 labels, got ${labels}`);
    assertEquals(countBoundaryTicks(svg), labels);
    assertStringIncludes(svg, ">run 2<");
    assertStringIncludes(svg, ">run 50<");
  },
);

Deno.test(
  "renderMultiRunComplexityChartSVG: 115 runs caps labels at 10 and includes first + last (issue #521 / #514)",
  () => {
    const svg = renderMultiRunComplexityChartSVG(makeNRunSeries(115));
    const labels = countBoundaryLabels(svg);
    assert(labels <= 10, `expected ≤10 labels, got ${labels}`);
    assertEquals(countBoundaryTicks(svg), labels);
    assertStringIncludes(svg, ">run 2<");
    assertStringIncludes(svg, ">run 115<");
  },
);

Deno.test(
  "renderMultiRunComplexityChartSVG: boundary selection is deterministic across runs (issue #521)",
  () => {
    const samples = makeNRunSeries(60);
    const a = renderMultiRunComplexityChartSVG(samples);
    const b = renderMultiRunComplexityChartSVG(samples);
    assertEquals(a, b);
  },
);

/** Build the snapshot's 10-run fixture deterministically. */
function makeBaselineSnapshotSeries(): MultiRunMilestone[] {
  const samples: MultiRunMilestone[] = [];
  for (let r = 1; r <= 10; r++) {
    for (let i = 0; i < 3; i++) {
      const g = (r - 1) * 100 + Math.pow(10, i);
      samples.push({
        runIndex: r,
        runGen: Math.pow(10, i),
        cumulativeGen: g,
        error: 0.9 / r - 0.01 * i,
        bestScore: 0.1 * r,
        neurons: 4 + r,
        synapses: 6 + r * 2,
        generationWallClockMs: 100,
      });
    }
  }
  return samples;
}

Deno.test(
  "renderMultiRunComplexityChartSVG: 10-run snapshot is byte-identical to pre-#521 baseline",
  async () => {
    const expected = await Deno.readTextFile(
      new URL("./testdata/baseline_cx_10runs.svg", import.meta.url),
    );
    const actual = renderMultiRunComplexityChartSVG(
      makeBaselineSnapshotSeries(),
    );
    assertEquals(actual, expected);
  },
);
