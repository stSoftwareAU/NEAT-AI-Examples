/**
 * Unit tests for the `evolveDir` return-value summary SVG renderer.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `renderEvolveDirSummarySvg` (returned SVG string contents, structure,
 * deterministic output, error handling) without inspecting how the
 * renderer builds it.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "./evolve_dir_summary.ts";

/** A canonical, well-formed summary used as the happy-path baseline. */
function makeSummary(overrides: Partial<EvolveDirSummary> = {}): EvolveDirSummary {
  return {
    finalError: 0.0125,
    finalScore: 0.876,
    wallClockMs: 123_456,
    generations: 1000,
    seedNeurons: 5,
    seedSynapses: 4,
    finalNeurons: 12,
    finalSynapses: 23,
    targetError: 0.01,
    timeoutMinutes: 5,
    ...overrides,
  };
}

Deno.test("renderEvolveDirSummarySvg: happy path emits SVG containing every numeric callout", () => {
  const summary = makeSummary();
  const svg = renderEvolveDirSummarySvg(summary);

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");

  // Numeric callouts — all four required values present in the output.
  assertStringIncludes(svg, "0.013"); // finalError, 3 dp
  assertStringIncludes(svg, "0.876"); // finalScore, 3 dp
  assertStringIncludes(svg, "1000"); // generations
  // Wall-clock is formatted (e.g. "2m 3s" or "123456 ms"); the raw count
  // of milliseconds is the floor — we expect a human-friendly form
  // mentioning minutes or seconds for >= 1 second.
  assert(
    /\b\d+m \d+s\b|\b\d+s\b/.test(svg),
    "SVG must contain a formatted wall-clock duration",
  );

  // Topology bars — both seed and final counts surface in the SVG.
  assertStringIncludes(svg, "topology");
  assertStringIncludes(svg, "5"); // seedNeurons
  assertStringIncludes(svg, "4"); // seedSynapses
  assertStringIncludes(svg, "12"); // finalNeurons
  assertStringIncludes(svg, "23"); // finalSynapses

  // No NaN/Infinity leaks into the output.
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderEvolveDirSummarySvg: stop-condition caption appears when targetError/timeoutMinutes set", () => {
  const summary = makeSummary({ targetError: 0.005, timeoutMinutes: 3 });
  const svg = renderEvolveDirSummarySvg(summary);

  assertStringIncludes(svg, "caption");
  // Caption surfaces the configured stop conditions.
  assertStringIncludes(svg, "0.005");
  assertStringIncludes(svg, "3");
});

Deno.test("renderEvolveDirSummarySvg: caption omitted when stop conditions are absent", () => {
  const summary = makeSummary({ targetError: undefined, timeoutMinutes: undefined });
  const svg = renderEvolveDirSummarySvg(summary);
  assert(
    !svg.includes('class="caption"'),
    "caption must not appear when both stop-condition fields are absent",
  );
});

Deno.test("renderEvolveDirSummarySvg: rejects non-finite finalError", () => {
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ finalError: Number.NaN })),
    Error,
    "finalError",
  );
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ finalError: Number.POSITIVE_INFINITY })),
    Error,
    "finalError",
  );
});

Deno.test("renderEvolveDirSummarySvg: rejects non-finite finalScore", () => {
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ finalScore: Number.NaN })),
    Error,
    "finalScore",
  );
});

Deno.test("renderEvolveDirSummarySvg: rejects non-finite wallClockMs", () => {
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ wallClockMs: Number.NEGATIVE_INFINITY })),
    Error,
    "wallClockMs",
  );
});

Deno.test("renderEvolveDirSummarySvg: rejects non-finite generations", () => {
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ generations: Number.NaN })),
    Error,
    "generations",
  );
});

Deno.test("renderEvolveDirSummarySvg: rejects non-finite topology counts", () => {
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ seedNeurons: Number.NaN })),
    Error,
    "seedNeurons",
  );
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ seedSynapses: Number.POSITIVE_INFINITY })),
    Error,
    "seedSynapses",
  );
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ finalNeurons: Number.NaN })),
    Error,
    "finalNeurons",
  );
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ finalSynapses: Number.NaN })),
    Error,
    "finalSynapses",
  );
});

Deno.test("renderEvolveDirSummarySvg: rejects non-finite optional fields when provided", () => {
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ targetError: Number.NaN })),
    Error,
    "targetError",
  );
  assertThrows(
    () => renderEvolveDirSummarySvg(makeSummary({ timeoutMinutes: Number.POSITIVE_INFINITY })),
    Error,
    "timeoutMinutes",
  );
});

Deno.test("renderEvolveDirSummarySvg: edge case — seed equals final topology (no growth)", () => {
  const summary = makeSummary({
    seedNeurons: 7,
    seedSynapses: 9,
    finalNeurons: 7,
    finalSynapses: 9,
  });
  const svg = renderEvolveDirSummarySvg(summary);

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  // Both seed and final values appear; the bar pair must still render.
  assertStringIncludes(svg, "topology");
  assertStringIncludes(svg, "7");
  assertStringIncludes(svg, "9");
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity");
});

Deno.test("renderEvolveDirSummarySvg: edge case — very large topology values", () => {
  const summary = makeSummary({
    seedNeurons: 1,
    seedSynapses: 1,
    finalNeurons: 5000,
    finalSynapses: 10_000,
    generations: 50_000,
    wallClockMs: 3_600_000,
  });
  const svg = renderEvolveDirSummarySvg(summary);

  assertStringIncludes(svg, "5000");
  assertStringIncludes(svg, "10000");
  assertStringIncludes(svg, "50000");
  assert(!svg.includes("NaN"));
});

Deno.test("renderEvolveDirSummarySvg: edge case — very small numeric ranges (sub-millisecond)", () => {
  const summary = makeSummary({
    finalError: 1e-9,
    finalScore: 1e-9,
    wallClockMs: 0,
    generations: 1,
    seedNeurons: 2,
    seedSynapses: 1,
    finalNeurons: 2,
    finalSynapses: 1,
    targetError: undefined,
    timeoutMinutes: undefined,
  });
  const svg = renderEvolveDirSummarySvg(summary);

  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");
  assert(!svg.includes("NaN"));
  assert(!svg.includes("Infinity"));
});

Deno.test("renderEvolveDirSummarySvg: deterministic — identical input produces identical output", () => {
  const summary = makeSummary();
  const a = renderEvolveDirSummarySvg(summary);
  const b = renderEvolveDirSummarySvg(summary);
  assertEquals(a, b);
});

Deno.test("renderEvolveDirSummarySvg: pure string emission — no DOM, no Date.now()", () => {
  const summary = makeSummary();
  const first = renderEvolveDirSummarySvg(summary);
  // Sleep briefly (synchronously, in a benign busy-wait via a tight
  // arithmetic loop). If the renderer embeds the current time, the
  // second call would differ even though the input did not.
  let _spin = 0;
  for (let i = 0; i < 1_000_000; i++) _spin += i;
  const second = renderEvolveDirSummarySvg(summary);
  assertEquals(first, second, `byte-identical output required; spin=${_spin}`);
});

Deno.test("renderEvolveDirSummarySvg: option overrides for width/height/title flow through", () => {
  const summary = makeSummary();
  const svg = renderEvolveDirSummarySvg(summary, {
    width: 600,
    height: 320,
    title: "Custom Title",
  });
  assertStringIncludes(svg, 'width="600"');
  assertStringIncludes(svg, 'height="320"');
  assertStringIncludes(svg, "Custom Title");
});
