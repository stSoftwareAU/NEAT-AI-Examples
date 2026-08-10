/**
 * Unit tests for the shared run-boundary detection, segmentation and
 * rendering used by both multi-run chart renderers (issue #780).
 *
 * These are "what" tests — each case calls a real function with sample
 * data and asserts on the returned value or the emitted SVG structure
 * (semantic class hooks, coordinates, label text), never on how the
 * fragment is assembled.
 */

import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";

import { makeXScale } from "./chart_scale.ts";
import {
  detectRunBoundaries,
  renderRunBoundaries,
  segmentSamplesByRun,
} from "./chart_run_boundaries.ts";

/** Minimal sample shape the boundary helpers consume. */
function sample(runIndex: number, cumulativeGen: number) {
  return { runIndex, cumulativeGen };
}

Deno.test("detectRunBoundaries: reports one boundary per runIndex transition", () => {
  const boundaries = detectRunBoundaries([
    sample(1, 1),
    sample(1, 10),
    sample(2, 20),
    sample(2, 30),
    sample(3, 40),
  ]);

  assertEquals(boundaries, [
    { runIndex: 2, cumulativeGen: 20 },
    { runIndex: 3, cumulativeGen: 40 },
  ]);
});

Deno.test("detectRunBoundaries: a single run has no boundaries", () => {
  assertEquals(detectRunBoundaries([sample(1, 1), sample(1, 10)]), []);
  assertEquals(detectRunBoundaries([sample(4, 7)]), []);
  assertEquals(detectRunBoundaries([]), []);
});

Deno.test("detectRunBoundaries: de-duplicates repeated transitions to one pair per run", () => {
  // Two samples share the transition generation — only the transition
  // itself becomes a boundary, not every sample of the new run.
  const boundaries = detectRunBoundaries([
    sample(1, 1),
    sample(2, 5),
    sample(2, 5),
    sample(2, 9),
  ]);

  assertEquals(boundaries, [{ runIndex: 2, cumulativeGen: 5 }]);
});

Deno.test("segmentSamplesByRun: splits into contiguous runs preserving order", () => {
  const samples = [
    sample(1, 1),
    sample(1, 10),
    sample(2, 20),
    sample(3, 30),
    sample(3, 40),
  ];

  assertEquals(segmentSamplesByRun(samples), [
    [sample(1, 1), sample(1, 10)],
    [sample(2, 20)],
    [sample(3, 30), sample(3, 40)],
  ]);
});

Deno.test("segmentSamplesByRun: single run yields one segment, empty yields none", () => {
  assertEquals(segmentSamplesByRun([sample(1, 1), sample(1, 2)]), [
    [sample(1, 1), sample(1, 2)],
  ]);
  assertEquals(segmentSamplesByRun([]), []);
});

Deno.test("segmentSamplesByRun: keeps the caller's extra sample fields", () => {
  const samples = [
    { runIndex: 1, cumulativeGen: 1, neurons: 3 },
    { runIndex: 2, cumulativeGen: 2, neurons: 4 },
  ];
  const segments = segmentSamplesByRun(samples);

  assertEquals(segments.length, 2);
  assertEquals(segments[0][0].neurons, 3);
  assertEquals(segments[1][0].neurons, 4);
});

Deno.test("renderRunBoundaries: emits a guide line and label per boundary", () => {
  const scale = makeXScale(1, 100, 70, 470, false);
  const svg = renderRunBoundaries({
    samples: [sample(1, 1), sample(2, 50), sample(3, 100)],
    xScale: scale,
    plotTop: 50,
    plotH: 200,
    plotW: 400,
  });

  assertStringIncludes(svg, `<g class="run-boundaries"`);
  const lines = [...svg.matchAll(/<line class="run-boundary"[^>]*x1="([-\d.]+)"/g)];
  assertEquals(lines.length, 2, "one guide line per run transition");
  // Coordinates are rounded for deterministic output, so compare within
  // the rounding tolerance rather than exactly.
  assertAlmostEquals(Number(lines[0][1]), scale(50), 0.01);
  assertAlmostEquals(Number(lines[1][1]), scale(100), 0.01);
  // The guide line spans the full plot height.
  assertStringIncludes(svg, `y1="50"`);
  assertStringIncludes(svg, `y2="250"`);
  // Labels name the run that starts at the boundary, above the plot.
  assertStringIncludes(svg, `>run 2</text>`);
  assertStringIncludes(svg, `>run 3</text>`);
  assertStringIncludes(svg, `y="46"`);
});

Deno.test("renderRunBoundaries: a single-run series emits an empty group", () => {
  const svg = renderRunBoundaries({
    samples: [sample(1, 1), sample(1, 10)],
    xScale: makeXScale(1, 10, 70, 470, true),
    plotTop: 50,
    plotH: 200,
    plotW: 400,
  });

  assertStringIncludes(svg, `<g class="run-boundaries"`);
  assertEquals(svg.includes("<line"), false, "no guide lines without transitions");
  assertEquals(svg.includes("<text"), false, "no labels without transitions");
});

Deno.test("renderRunBoundaries: keeps every label at ten boundaries or fewer", () => {
  const samples = [sample(1, 1)];
  for (let run = 2; run <= 11; run++) samples.push(sample(run, run * 10));
  const svg = renderRunBoundaries({
    samples,
    xScale: makeXScale(1, 110, 70, 470, true),
    plotTop: 50,
    plotH: 200,
    plotW: 400,
  });

  const labels = [...svg.matchAll(/>run (\d+)<\/text>/g)].map((m) => m[1]);
  assertEquals(labels.length, 10, "ten transitions all keep their label");
  assertEquals(labels[0], "2");
  assertEquals(labels[labels.length - 1], "11");
});

Deno.test("renderRunBoundaries: thins labels past ten boundaries, anchoring both ends", () => {
  const samples = [sample(1, 1)];
  for (let run = 2; run <= 60; run++) samples.push(sample(run, run * 10));
  const svg = renderRunBoundaries({
    samples,
    xScale: makeXScale(1, 600, 70, 470, true),
    plotTop: 50,
    plotH: 200,
    plotW: 400,
  });

  const labels = [...svg.matchAll(/>run (\d+)<\/text>/g)].map((m) => m[1]);
  assert(
    labels.length < 59,
    `expected thinning of 59 boundaries, got ${labels.length} labels`,
  );
  assert(labels.length >= 2, "both anchors survive thinning");
  assertEquals(labels[0], "2", "first transition is anchored");
  assertEquals(labels[labels.length - 1], "60", "last transition is anchored");
  // Ticks follow labels — never a bare guide line.
  const lineCount = [...svg.matchAll(/<line class="run-boundary"/g)].length;
  assertEquals(lineCount, labels.length);
});
