/**
 * Unit tests for the shared fitness-chart renderer. "What" tests only —
 * each test calls `renderFitnessChartSVG` with known input and asserts on
 * structural elements of the returned SVG string.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import { type FitnessSample, renderFitnessChartSVG } from "./fitness_chart.ts";

function makeSeries(count: number): FitnessSample[] {
  const out: FitnessSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      generation: i,
      bestFitness: i * 0.5,
      avgFitness: i * 0.2 - 1,
    });
  }
  return out;
}

Deno.test("renderFitnessChartSVG: empty input throws a clear error", () => {
  assertThrows(
    () => renderFitnessChartSVG([]),
    Error,
    "at least one sample",
  );
});

Deno.test("renderFitnessChartSVG: emits a well-formed <svg> root", () => {
  const svg = renderFitnessChartSVG(makeSeries(5));
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assertStringIncludes(svg, "</svg>");
  assertStringIncludes(svg, 'xmlns="http://www.w3.org/2000/svg"');
});

Deno.test("renderFitnessChartSVG: renders two polylines (best + avg)", () => {
  const svg = renderFitnessChartSVG(makeSeries(8));
  const polylines = svg.match(/<polyline /g) ?? [];
  assertEquals(polylines.length, 2, `expected exactly 2 polylines, got ${polylines.length}`);
  assertStringIncludes(svg, "best-line");
  assertStringIncludes(svg, "avg-line");
});

Deno.test("renderFitnessChartSVG: legend renders both labels", () => {
  const svg = renderFitnessChartSVG(makeSeries(4), {
    bestLabel: "best fitness",
    avgLabel: "avg fitness",
  });
  assertStringIncludes(svg, "legend");
  assertStringIncludes(svg, "best fitness");
  assertStringIncludes(svg, "avg fitness");
});

Deno.test("renderFitnessChartSVG: deterministic for identical input", () => {
  const samples = makeSeries(20);
  const a = renderFitnessChartSVG(samples, { title: "Run", width: 800, height: 400 });
  const b = renderFitnessChartSVG(samples, { title: "Run", width: 800, height: 400 });
  assertEquals(a, b);
});

Deno.test("renderFitnessChartSVG: single sample renders an annotated point", () => {
  const samples: FitnessSample[] = [{ generation: 0, bestFitness: 0.42, avgFitness: -1.2 }];
  const svg = renderFitnessChartSVG(samples);
  assertStringIncludes(svg, "final-annotation");
  assertStringIncludes(svg, "gen 0");
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
});

Deno.test("renderFitnessChartSVG: down-samples large series but keeps first and last", () => {
  const samples = makeSeries(5_000);
  const maxSamples = 100;
  const svg = renderFitnessChartSVG(samples, { maxSamples });
  const points = svg.match(/class="best-point"/g) ?? [];
  assert(
    points.length <= maxSamples + 2,
    `expected <= ${maxSamples + 2} plotted best points, got ${points.length}`,
  );
  assert(points.length >= 2, "should plot at least the first and last samples");
  assertStringIncludes(svg, `gen ${samples[samples.length - 1].generation}`);
});

Deno.test("renderFitnessChartSVG: all-equal values render without NaN", () => {
  const samples: FitnessSample[] = Array.from({ length: 5 }, (_, i) => ({
    generation: i,
    bestFitness: 1.0,
    avgFitness: 0.5,
  }));
  const svg = renderFitnessChartSVG(samples);
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});
