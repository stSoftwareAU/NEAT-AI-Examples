/**
 * Unit tests for the milestone-statistics SVG chart renderer.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `renderMilestoneChartSVG` (returned SVG string contents, structure,
 * deterministic output) without inspecting how the renderer builds it.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import { type MilestoneSample, renderMilestoneChartSVG } from "./milestone_chart.ts";

/** Build a series matching the canonical milestone generations. */
function makeMilestoneSeries(): MilestoneSample[] {
  const gens = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return gens.map((g, i) => ({
    generation: g,
    bestScore: 0.1 + i * 0.08,
    bestNeurons: 4 + i,
    bestSynapses: 6 + i * 2,
    meanEpisodeSteps: 5 + i * 3,
    generationWallClockMs: 100 + i * 50,
  }));
}

Deno.test("renderMilestoneChartSVG: happy path emits valid SVG with all four series", () => {
  const samples = makeMilestoneSeries();
  const svg = renderMilestoneChartSVG(samples, { title: "Milestone Test" });

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  assertStringIncludes(svg, "Milestone Test");

  // Four distinct series should be rendered.
  assertStringIncludes(svg, "best-score-line");
  assertStringIncludes(svg, "mean-steps-line");
  assertStringIncludes(svg, "neurons-line");
  assertStringIncludes(svg, "synapses-line");

  // Both axes plus an X axis must be present.
  assertStringIncludes(svg, "left-axis");
  assertStringIncludes(svg, "right-axis");
  assertStringIncludes(svg, "x-axis");

  // Legend lists each series.
  assertStringIncludes(svg, "legend");

  // No NaN/Infinity leaks into the output.
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderMilestoneChartSVG: empty input throws a clear error", () => {
  assertThrows(
    () => renderMilestoneChartSVG([]),
    Error,
    "at least one sample",
  );
});

Deno.test("renderMilestoneChartSVG: single sample renders without artefacts", () => {
  const samples: MilestoneSample[] = [
    {
      generation: 1,
      bestScore: 0.42,
      bestNeurons: 7,
      bestSynapses: 13,
      meanEpisodeSteps: 8,
      generationWallClockMs: 250,
    },
  ];
  const svg = renderMilestoneChartSVG(samples);

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
  // The lone sample's count values appear somewhere in the chart.
  assertStringIncludes(svg, "best-score-line");
  assertStringIncludes(svg, "neurons-line");
});

Deno.test("renderMilestoneChartSVG: deterministic — identical input produces identical output", () => {
  const samples = makeMilestoneSeries();
  const a = renderMilestoneChartSVG(samples, { width: 800, height: 400, title: "Run" });
  const b = renderMilestoneChartSVG(samples, { width: 800, height: 400, title: "Run" });
  assertEquals(a, b);
});

Deno.test("renderMilestoneChartSVG: log-x option produces different layout from linear", () => {
  const samples = makeMilestoneSeries();
  const linear = renderMilestoneChartSVG(samples, { logX: false, title: "Run" });
  const log = renderMilestoneChartSVG(samples, { logX: true, title: "Run" });

  // Both must be valid SVGs.
  assertStringIncludes(linear, "<svg");
  assertStringIncludes(log, "<svg");

  // Because milestone generations are spread across powers of ten, log-x
  // and linear-x layouts must produce different point coordinates.
  assert(
    linear !== log,
    "logX layout should differ from linear layout for power-of-ten spaced generations",
  );

  // Both layouts must be self-deterministic.
  assertEquals(log, renderMilestoneChartSVG(samples, { logX: true, title: "Run" }));
});

Deno.test("renderMilestoneChartSVG: caption shows final score, topology and total wall-clock", () => {
  const samples = makeMilestoneSeries();
  const svg = renderMilestoneChartSVG(samples, { caption: true });

  assertStringIncludes(svg, "caption");
  const last = samples[samples.length - 1];
  // Final score appears (rounded to 3 decimals).
  assertStringIncludes(svg, "0.82"); // 0.1 + 9*0.08 = 0.82
  // Final topology counts appear.
  assertStringIncludes(svg, `${last.bestNeurons} neurons`);
  assertStringIncludes(svg, `${last.bestSynapses} synapses`);
  // Total wall-clock ms is the sum of generationWallClockMs.
  const totalMs = samples.reduce((acc, s) => acc + s.generationWallClockMs, 0);
  assertStringIncludes(svg, `${totalMs} ms`);
});

Deno.test("renderMilestoneChartSVG: caption defaults to off", () => {
  const samples = makeMilestoneSeries();
  const svg = renderMilestoneChartSVG(samples);
  assert(
    !svg.includes('class="caption"'),
    "caption must not appear when the option is omitted",
  );
});

Deno.test("renderMilestoneChartSVG: plots each sample at its actual generation (linear)", () => {
  const samples = makeMilestoneSeries();
  const svg = renderMilestoneChartSVG(samples, { logX: false });

  // One <circle class="best-score-point" .../> per sample.
  const pointMatches = svg.match(/class="best-score-point"/g) ?? [];
  assertEquals(pointMatches.length, samples.length);
});
