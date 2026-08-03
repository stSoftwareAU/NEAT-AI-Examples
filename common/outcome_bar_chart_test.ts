/**
 * Unit tests for the per-validation-scenario outcome bar chart renderer.
 * "What" tests only — each test calls `renderOutcomeBarChartSVG` with
 * known input and asserts on structural elements of the returned SVG
 * string.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import {
  OUTCOME_ORDER,
  renderOutcomeBarChartSVG,
  type ScenarioOutcome,
} from "./outcome_bar_chart.ts";

/**
 * Read the `fill` attribute of the first element tagged with `className`.
 * Lets colour assertions name a semantic hook instead of a hex literal.
 */
function fillForClass(svg: string, className: string): string | undefined {
  const tag = svg.match(
    new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`),
  );
  return tag?.[0].match(/fill="([^"]+)"/)?.[1];
}

function makeOutcomes(): ScenarioOutcome[] {
  // A spread that exercises every outcome category at least once.
  return [
    { scenarioIndex: 0, outcome: "landed", score: 1000 },
    { scenarioIndex: 1, outcome: "landed", score: 950 },
    { scenarioIndex: 2, outcome: "crashed", score: -250 },
    { scenarioIndex: 3, outcome: "out_of_bounds", score: -1500 },
    { scenarioIndex: 4, outcome: "flying", score: -75 },
    { scenarioIndex: 5, outcome: "landed", score: 880 },
  ];
}

Deno.test("renderOutcomeBarChartSVG: empty input throws a clear error", () => {
  assertThrows(
    () => renderOutcomeBarChartSVG([]),
    Error,
    "at least one outcome",
  );
});

Deno.test("renderOutcomeBarChartSVG: emits a well-formed <svg> root", () => {
  const svg = renderOutcomeBarChartSVG(makeOutcomes());
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assertStringIncludes(svg, "</svg>");
  assertStringIncludes(svg, 'xmlns="http://www.w3.org/2000/svg"');
  assertStringIncludes(svg, "viewBox=");
});

Deno.test("renderOutcomeBarChartSVG: every outcome category renders a bar", () => {
  const svg = renderOutcomeBarChartSVG(makeOutcomes());
  for (const cat of OUTCOME_ORDER) {
    assertStringIncludes(svg, `count-bar-${cat}`);
  }
});

Deno.test("renderOutcomeBarChartSVG: per-scenario strip renders one cell per scenario", () => {
  const outcomes = makeOutcomes();
  const svg = renderOutcomeBarChartSVG(outcomes);
  const cellCount = (svg.match(/class="scenario-cell scenario-cell-/g) ?? []).length;
  assertEquals(
    cellCount,
    outcomes.length,
    `expected ${outcomes.length} cells, got ${cellCount}`,
  );
});

Deno.test("renderOutcomeBarChartSVG: score range axis renders min and max", () => {
  const svg = renderOutcomeBarChartSVG(makeOutcomes());
  assertStringIncludes(svg, "score-axis-min");
  assertStringIncludes(svg, "score-axis-max");
  // The makeOutcomes() spread has min=-1500 and max=1000; both must appear.
  assertStringIncludes(svg, "-1500");
  assertStringIncludes(svg, "1000");
});

Deno.test("renderOutcomeBarChartSVG: count labels reflect input distribution", () => {
  const svg = renderOutcomeBarChartSVG(makeOutcomes());
  // 3 landed, 1 crashed, 1 out_of_bounds, 1 flying.
  assertStringIncludes(svg, ">3<");
  // Total should appear in the y-axis label.
  assertStringIncludes(svg, "scenarios (6)");
});

Deno.test("renderOutcomeBarChartSVG: deterministic for identical input", () => {
  const outcomes = makeOutcomes();
  const a = renderOutcomeBarChartSVG(outcomes, { title: "Run", width: 800, height: 320 });
  const b = renderOutcomeBarChartSVG(outcomes, { title: "Run", width: 800, height: 320 });
  assertEquals(a, b);
});

Deno.test("renderOutcomeBarChartSVG: scales to 200 scenarios", () => {
  const outcomes: ScenarioOutcome[] = [];
  for (let i = 0; i < 200; i++) {
    outcomes.push({
      scenarioIndex: i,
      outcome: i % 17 === 0 ? "crashed" : "landed",
      score: i,
    });
  }
  const svg = renderOutcomeBarChartSVG(outcomes);
  const cellCount = (svg.match(/class="scenario-cell scenario-cell-/g) ?? []).length;
  assertEquals(cellCount, 200);
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderOutcomeBarChartSVG: legend renders all four outcome labels", () => {
  const svg = renderOutcomeBarChartSVG(makeOutcomes());
  assertStringIncludes(svg, "legend");
  for (const cat of OUTCOME_ORDER) {
    assertStringIncludes(svg, cat);
  }
});

Deno.test("renderOutcomeBarChartSVG: tooltips include scenario index and outcome", () => {
  const outcomes: ScenarioOutcome[] = [
    { scenarioIndex: 42, outcome: "landed", score: 1000 },
  ];
  const svg = renderOutcomeBarChartSVG(outcomes);
  assertStringIncludes(svg, "<title>scenario 42: landed");
});

Deno.test("renderOutcomeBarChartSVG: single-outcome input does not produce NaN", () => {
  const outcomes: ScenarioOutcome[] = [
    { scenarioIndex: 0, outcome: "landed", score: 1000 },
    { scenarioIndex: 1, outcome: "landed", score: 1000 },
  ];
  const svg = renderOutcomeBarChartSVG(outcomes);
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
});

Deno.test("renderOutcomeBarChartSVG: each outcome category gets a distinct fill", () => {
  // The contract is that the four categories are visually separable, not
  // that any particular hex is used — a palette restyle must not fail here.
  const svg = renderOutcomeBarChartSVG(makeOutcomes());
  const fills = OUTCOME_ORDER.map((cat) => fillForClass(svg, `count-bar-${cat}`));
  for (let i = 0; i < OUTCOME_ORDER.length; i++) {
    assert(fills[i], `count bar for ${OUTCOME_ORDER[i]} must carry a fill`);
  }
  assertEquals(
    new Set(fills).size,
    fills.length,
    "each outcome needs a distinct colour",
  );
});

Deno.test("renderOutcomeBarChartSVG: bar, strip cell and legend swatch agree per category", () => {
  // The three surfaces exist to be read together, so they must share one
  // colour per category. Asserting agreement — rather than the hex itself —
  // keeps the test behavioural.
  const svg = renderOutcomeBarChartSVG(makeOutcomes());
  for (const cat of OUTCOME_ORDER) {
    const bar = fillForClass(svg, `count-bar-${cat}`);
    assert(bar, `count bar for ${cat} must carry a fill`);
    assertEquals(
      fillForClass(svg, `scenario-cell-${cat}`),
      bar,
      `strip cell for ${cat} must match its count bar`,
    );
    assertEquals(
      fillForClass(svg, `legend-swatch-${cat}`),
      bar,
      `legend swatch for ${cat} must match its count bar`,
    );
  }
});
