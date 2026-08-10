/**
 * Unit tests for the shared chart axis renderers.
 *
 * The SVG escaping and number-formatting helpers they build on are
 * covered by `./svg_text_test.ts` (issue #778).
 *
 * These are "what" tests — each case renders a real axis fragment and
 * asserts on the emitted structure (tick positions, label text,
 * semantic class hooks), never on how the fragment is assembled.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { makeScale, makeXScale } from "./chart_scale.ts";
import { renderLeftAxis, renderRightAxis, renderXAxis } from "./chart_axis.ts";

/** Collect the `x` attribute of every `<text>` element in a fragment. */
function textXs(svg: string): number[] {
  return [...svg.matchAll(/<text x="([-\d.]+)"/g)].map((m) => Number(m[1]));
}

/** Collect the body of every `<text>` element in a fragment. */
function textBodies(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

Deno.test("renderXAxis: places one tick at each scaled generation", () => {
  const scale = makeXScale(0, 40, 70, 470, false);
  const svg = renderXAxis({
    min: 0,
    max: 40,
    scale,
    baseY: 300,
    logX: false,
    label: "generation",
  });

  assertStringIncludes(svg, `<g class="x-axis"`);
  // Tick marks sit on the axis baseline and drop 4 units below it.
  const tickLines = [...svg.matchAll(/<line x1="([-\d.]+)" y1="300"/g)];
  assert(tickLines.length >= 2, `expected multiple ticks, got ${tickLines.length}`);
  const firstX = Number(tickLines[0][1]);
  assertEquals(firstX, scale(0), "first tick sits at the scaled minimum");
  assertStringIncludes(svg, `y2="304"`);
  // Axis title is centred between the domain endpoints, below the ticks.
  assertStringIncludes(svg, `>generation</text>`);
  assertStringIncludes(svg, `y="336"`);
});

Deno.test("renderXAxis: log mode uses decade ticks and annotates the label", () => {
  const scale = makeXScale(1, 1000, 0, 300, true);
  const svg = renderXAxis({
    min: 1,
    max: 1000,
    scale,
    baseY: 100,
    logX: true,
    label: "cumulative generation",
  });

  const bodies = textBodies(svg);
  assertEquals(bodies.includes("1"), true, "decade tick 1 is labelled");
  assertEquals(bodies.includes("10"), true, "decade tick 10 is labelled");
  assertEquals(bodies.includes("100"), true, "decade tick 100 is labelled");
  assertEquals(bodies.includes("1000"), true, "decade tick 1000 is labelled");
  assertStringIncludes(svg, "cumulative generation (log scale)");
});

Deno.test("renderXAxis: the axis label is XML-escaped", () => {
  const svg = renderXAxis({
    min: 1,
    max: 10,
    scale: makeScale(1, 10, 0, 100),
    baseY: 50,
    logX: false,
    label: "gens <&>",
  });
  assertStringIncludes(svg, "gens &lt;&amp;&gt;");
  assert(!svg.includes("gens <&>"), "raw metacharacters must not reach the output");
});

Deno.test("renderLeftAxis: ticks and label sit left of the plot edge", () => {
  const scale = makeScale(0, 1, 340, 40);
  const svg = renderLeftAxis({
    min: 0,
    max: 1,
    scale,
    baseX: 70,
    label: "error",
    integerTicks: false,
  });

  assertStringIncludes(svg, `<g class="left-axis"`);
  assertStringIncludes(svg, `x1="66" y1="340" x2="70" y2="340"`);
  for (const x of textXs(svg)) {
    assert(x < 70, `left-axis text at x=${x} must sit left of the plot edge`);
  }
  assertStringIncludes(svg, `text-anchor="end"`);
  assertStringIncludes(svg, `transform="rotate(-90 22 190)">error</text>`);
});

Deno.test("renderLeftAxis: the group class is caller-selectable", () => {
  const svg = renderLeftAxis({
    min: 0,
    max: 1,
    scale: makeScale(0, 1, 340, 40),
    baseX: 70,
    label: "error",
    integerTicks: false,
    groupClass: "y-axis",
  });
  assertStringIncludes(svg, `<g class="y-axis"`);
});

Deno.test("renderLeftAxis: integer ticks are labelled as whole numbers", () => {
  const svg = renderLeftAxis({
    min: 0,
    max: 12,
    scale: makeScale(0, 12, 340, 40),
    baseX: 70,
    label: "neurons",
    integerTicks: true,
  });
  const values = textBodies(svg).filter((b) => b !== "neurons");
  assert(values.length > 1, "expected several tick labels");
  for (const v of values) {
    assertEquals(Number.isInteger(Number(v)), true, `tick label ${v} must be whole`);
  }
  assertEquals(values[values.length - 1], "12", "the upper bound is labelled");
});

Deno.test("renderRightAxis: ticks and label sit right of the plot edge", () => {
  const scale = makeScale(0, 100, 340, 40);
  const svg = renderRightAxis({
    min: 0,
    max: 100,
    scale,
    baseX: 730,
    label: "synapses",
    integerTicks: true,
  });

  assertStringIncludes(svg, `<g class="right-axis"`);
  assertStringIncludes(svg, `x1="730" y1="340" x2="734" y2="340"`);
  for (const x of textXs(svg)) {
    assert(x > 730, `right-axis text at x=${x} must sit right of the plot edge`);
  }
  assertStringIncludes(svg, `text-anchor="start"`);
  assertStringIncludes(svg, `transform="rotate(90 778 190)">synapses</text>`);
});

Deno.test("renderLeftAxis: a degenerate range still renders one tick and the label", () => {
  const svg = renderLeftAxis({
    min: 7,
    max: 7,
    scale: makeScale(7, 7, 340, 40),
    baseX: 70,
    label: "score",
    integerTicks: true,
  });
  const bodies = textBodies(svg);
  assertEquals(bodies, ["7", "score"]);
});
