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

  // Error series: a single best-error-so-far envelope polyline across all
  // runs (issue #431 — the evolution-progress line is monotonically
  // non-increasing, so per-run segmentation is no longer needed).
  assertStringIncludes(svg, "error-line");
  assertEquals(
    (svg.match(/<polyline fill="none" stroke="#d62728"/g) ?? []).length,
    1,
  );

  // Both axes present.
  assertStringIncludes(svg, "x-axis");
  assertStringIncludes(svg, "y-axis");

  // Default log-X layout documents linear Y in a footnote.
  assertStringIncludes(svg, 'class="axis-footnote"');

  // No NaN/Infinity leaks into the output.
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test(
  "renderMultiRunErrorChartSVG: envelope polyline is monotonically non-increasing even when raw error spikes between runs (issue #431)",
  () => {
    // Reproduce the cart_pole regression: a resumed champion is
    // re-evaluated against fresh random episodes and scores worse than
    // the previous run's last milestone. The raw measurement goes UP
    // (0.567 → 0.7058), but the evolution-progress envelope must not.
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
        error: 0.6,
        bestScore: 0.4,
        neurons: 4,
        synapses: 6,
        generationWallClockMs: 100,
      },
      // Run boundary: re-evaluated champion measures worse.
      {
        runIndex: 2,
        runGen: 1,
        cumulativeGen: 11,
        error: 0.8,
        bestScore: 0.2,
        neurons: 4,
        synapses: 6,
        generationWallClockMs: 100,
      },
      {
        runIndex: 2,
        runGen: 10,
        cumulativeGen: 20,
        error: 0.3,
        bestScore: 0.7,
        neurons: 4,
        synapses: 6,
        generationWallClockMs: 100,
      },
    ];

    const svg = renderMultiRunErrorChartSVG(samples);

    // Extract the envelope polyline's points and confirm Y never
    // decreases-from-top → it must be non-decreasing in SVG Y space
    // (SVG Y grows downward, lower error → larger Y). Equivalently: the
    // Y coordinates must be non-decreasing as we walk left → right.
    const polyMatch = svg.match(
      /<polyline fill="none" stroke="#d62728"[^>]*points="([^"]+)"/,
    );
    assert(polyMatch, "envelope polyline must be present in SVG");
    const ys = polyMatch[1]
      .trim()
      .split(/\s+/)
      .map((pt) => Number(pt.split(",")[1]));
    for (let i = 1; i < ys.length; i++) {
      assert(
        ys[i] >= ys[i - 1] - 1e-6,
        `envelope must be monotonically non-increasing in error (Y not non-decreasing) ` +
          `at index ${i}: ys[${i - 1}]=${ys[i - 1]} ys[${i}]=${ys[i]}`,
      );
    }

    // Raw measurement circles must still expose the actual error values
    // (including the spike) — circles use the same red as the envelope.
    const circleCount = (svg.match(/<circle class="error-point"/g) ?? []).length;
    assertEquals(circleCount, samples.length);
  },
);

Deno.test(
  "renderMultiRunErrorChartSVG: footnote documents the best-error-so-far envelope (issue #431)",
  () => {
    const samples = makeMultiRunSeries();
    const svg = renderMultiRunErrorChartSVG(samples, { logX: true });
    // The footnote text must explain that the line is best-so-far so
    // viewers do not misread the raw circle dots as regressions.
    assertStringIncludes(svg, "best error so far");
  },
);

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

Deno.test(
  "renderMultiRunErrorChartSVG: caption surfaces generations per minute (issue #344)",
  () => {
    // Build a deterministic two-sample series so the gen/min arithmetic
    // is easy to verify by hand: 60 cumulative generations over 60 seconds
    // (60_000 ms) → exactly 60 gen/min.
    const samples: MultiRunMilestone[] = [
      {
        runIndex: 1,
        runGen: 1,
        cumulativeGen: 1,
        error: 0.9,
        bestScore: 0.1,
        neurons: 4,
        synapses: 6,
        generationWallClockMs: 30_000,
      },
      {
        runIndex: 1,
        runGen: 60,
        cumulativeGen: 60,
        error: 0.1,
        bestScore: 0.9,
        neurons: 7,
        synapses: 10,
        generationWallClockMs: 30_000,
      },
    ];
    const svg = renderMultiRunErrorChartSVG(samples, { caption: true });

    // 60 gens / 60_000 ms * 60_000 = 60 gen/min.
    assertStringIncludes(svg, "60 gen/min");
  },
);

Deno.test(
  "renderMultiRunErrorChartSVG: caption gen/min handles zero total wall-clock",
  () => {
    // Defensive: if every milestone reports a 0 ms generation duration we
    // must not produce NaN or Infinity in the caption.
    const samples: MultiRunMilestone[] = [
      {
        runIndex: 1,
        runGen: 1,
        cumulativeGen: 1,
        error: 0.5,
        bestScore: 0.5,
        neurons: 4,
        synapses: 6,
        generationWallClockMs: 0,
      },
    ];
    const svg = renderMultiRunErrorChartSVG(samples, { caption: true });
    assertStringIncludes(svg, "0 gen/min");
    assert(!svg.includes("NaN"));
    assert(!svg.includes("Infinity"));
  },
);

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
  assert(
    !linear.includes('class="axis-footnote"'),
    "linear X must omit the log-X explanatory footnote",
  );
  assertStringIncludes(log, 'class="axis-footnote"');
});

Deno.test("renderMultiRunErrorChartSVG: unsorted input is sorted by cumulativeGen", () => {
  const samples = makeMultiRunSeries();
  // Reverse the array — the renderer must produce the same SVG regardless.
  const reversed = [...samples].reverse();

  const ordered = renderMultiRunErrorChartSVG(samples);
  const shuffled = renderMultiRunErrorChartSVG(reversed);
  assertEquals(ordered, shuffled);
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
      neurons: 4,
      synapses: 6,
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
  "renderMultiRunErrorChartSVG: ≤10 runs renders every boundary (issue #521)",
  () => {
    for (const runCount of [1, 2, 5, 10]) {
      const svg = renderMultiRunErrorChartSVG(makeNRunSeries(runCount));
      const expectedBoundaries = runCount - 1; // first run has no boundary.
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
  "renderMultiRunErrorChartSVG: 50 runs caps boundary labels at 10 (issue #521)",
  () => {
    const svg = renderMultiRunErrorChartSVG(makeNRunSeries(50));
    const labels = countBoundaryLabels(svg);
    assert(labels <= 10, `expected ≤10 labels, got ${labels}`);
    assertEquals(
      countBoundaryTicks(svg),
      labels,
      "tick count must match label count (ticks follow labels)",
    );
    // First boundary (run 2) and last boundary (run 50) must be labelled.
    assertStringIncludes(svg, ">run 2<");
    assertStringIncludes(svg, ">run 50<");
  },
);

Deno.test(
  "renderMultiRunErrorChartSVG: 115 runs caps labels at 10 and includes first + last (issue #521 / #514)",
  () => {
    const svg = renderMultiRunErrorChartSVG(makeNRunSeries(115));
    const labels = countBoundaryLabels(svg);
    assert(labels <= 10, `expected ≤10 labels, got ${labels}`);
    assertEquals(countBoundaryTicks(svg), labels);
    assertStringIncludes(svg, ">run 2<");
    assertStringIncludes(svg, ">run 115<");
  },
);

Deno.test(
  "renderMultiRunErrorChartSVG: boundary selection is deterministic across runs (issue #521)",
  () => {
    const samples = makeNRunSeries(60);
    const a = renderMultiRunErrorChartSVG(samples);
    const b = renderMultiRunErrorChartSVG(samples);
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
  "renderMultiRunErrorChartSVG: 10-run snapshot is byte-identical to pre-#521 baseline",
  async () => {
    const expected = await Deno.readTextFile(
      new URL("./testdata/baseline_err_10runs.svg", import.meta.url),
    );
    const actual = renderMultiRunErrorChartSVG(makeBaselineSnapshotSeries());
    assertEquals(actual, expected);
  },
);
