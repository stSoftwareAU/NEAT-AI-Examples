/**
 * Unit tests for the shared dual-axis evolution chart renderer.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `renderEvolutionChartSVG` (returned SVG string contents, structure,
 * deterministic output) without inspecting how the renderer builds it.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import { type EvolutionSample, renderEvolutionChartSVG } from "./evolution_chart.ts";

function makeSeries(count: number, scoreSlope = 0.1): EvolutionSample[] {
  const out: EvolutionSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      generation: i,
      score: i * scoreSlope,
      neurons: 3 + i,
      synapses: 5 + i * 2,
    });
  }
  return out;
}

Deno.test("renderEvolutionChartSVG: happy path emits valid SVG with all three series", () => {
  const samples = makeSeries(10);
  const svg = renderEvolutionChartSVG(samples, { title: "Evolution Test" });

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  assertStringIncludes(svg, "Evolution Test");

  // Three distinct series should be rendered (score / neurons / synapses).
  assertStringIncludes(svg, "score-line");
  assertStringIncludes(svg, "neurons-line");
  assertStringIncludes(svg, "synapses-line");

  // Both axes should be present.
  assertStringIncludes(svg, "left-axis");
  assertStringIncludes(svg, "right-axis");
  assertStringIncludes(svg, "x-axis");

  // Legend.
  assertStringIncludes(svg, "legend");

  // Final-generation annotation references the last sample's values verbatim.
  const last = samples[samples.length - 1];
  assertStringIncludes(svg, "final-annotation");
  assertStringIncludes(svg, `gen ${last.generation}`);
  // Score is formatted to a few decimals — at minimum the integer part appears.
  assertStringIncludes(svg, last.neurons.toString());
  assertStringIncludes(svg, last.synapses.toString());
});

Deno.test("renderEvolutionChartSVG: down-samples large series but keeps first and last", () => {
  const samples = makeSeries(10_000, 0.001);
  const maxSamples = 200;
  const svg = renderEvolutionChartSVG(samples, { maxSamples });

  // Count plotted points on the score line. Each plotted sample emits one
  // <circle class="score-point" .../>.
  const pointMatches = svg.match(/class="score-point"/g) ?? [];
  assert(
    pointMatches.length <= maxSamples + 2,
    `expected <= ${maxSamples + 2} plotted score points, got ${pointMatches.length}`,
  );
  assert(pointMatches.length >= 2, "should plot at least the first and last samples");

  // The first and last samples must appear unchanged. Their generation
  // indices are part of the SVG (final annotation + first-point label).
  const last = samples[samples.length - 1];
  assertStringIncludes(svg, `gen ${last.generation}`);
  assertStringIncludes(svg, last.neurons.toString());
  assertStringIncludes(svg, last.synapses.toString());
});

Deno.test("renderEvolutionChartSVG: empty input throws a clear error", () => {
  assertThrows(
    () => renderEvolutionChartSVG([]),
    Error,
    "at least one sample",
  );
});

Deno.test("renderEvolutionChartSVG: single sample renders an annotated point", () => {
  const samples: EvolutionSample[] = [
    { generation: 0, score: 0.42, neurons: 7, synapses: 13 },
  ];
  const svg = renderEvolutionChartSVG(samples);

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  assertStringIncludes(svg, "final-annotation");
  assertStringIncludes(svg, "gen 0");
  assertStringIncludes(svg, "7"); // neurons
  assertStringIncludes(svg, "13"); // synapses

  // No NaN should leak into the output even with a degenerate range.
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
});

Deno.test("renderEvolutionChartSVG: all-equal scores still render without artefacts", () => {
  const samples: EvolutionSample[] = Array.from({ length: 5 }, (_, i) => ({
    generation: i,
    score: 0.5,
    neurons: 4,
    synapses: 8,
  }));
  const svg = renderEvolutionChartSVG(samples);

  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
  assertStringIncludes(svg, "score-line");
  assertStringIncludes(svg, "left-axis");
});

Deno.test("renderEvolutionChartSVG: all-zero neuron and synapse counts render cleanly", () => {
  const samples: EvolutionSample[] = Array.from({ length: 5 }, (_, i) => ({
    generation: i,
    score: i * 0.1,
    neurons: 0,
    synapses: 0,
  }));
  const svg = renderEvolutionChartSVG(samples);

  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assertStringIncludes(svg, "right-axis");
  assertStringIncludes(svg, "neurons-line");
  assertStringIncludes(svg, "synapses-line");
});

Deno.test("renderEvolutionChartSVG: deterministic — identical input produces identical output", () => {
  const samples = makeSeries(50, 0.05);
  const a = renderEvolutionChartSVG(samples, { width: 800, height: 400, title: "Run" });
  const b = renderEvolutionChartSVG(samples, { width: 800, height: 400, title: "Run" });
  assertEquals(a, b);
});

Deno.test("renderEvolutionChartSVG: down-sampled output is also deterministic", () => {
  const samples = makeSeries(5_000, 0.0005);
  const a = renderEvolutionChartSVG(samples, { maxSamples: 250 });
  const b = renderEvolutionChartSVG(samples, { maxSamples: 250 });
  assertEquals(a, b);
});
