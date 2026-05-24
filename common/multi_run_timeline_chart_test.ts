/**
 * Unit tests for multi_run_timeline_chart.ts
 */

import { assert, assertStringIncludes } from "@std/assert";

import type { MultiRunMilestone } from "./multi_run_state.ts";
import { renderMultiRunTimelineChartSVG } from "./multi_run_timeline_chart.ts";

function milestone(
  runGen: number,
  error: number,
  wallMs: number,
  holdout?: number,
): MultiRunMilestone {
  return {
    runIndex: 1,
    runGen,
    cumulativeGen: runGen,
    error,
    bestScore: holdout ?? 1 - error,
    holdoutScore: holdout,
    neurons: 10,
    synapses: 20,
    generationWallClockMs: wallMs,
    cumulativeWallClockMs: wallMs,
  };
}

Deno.test("renderMultiRunTimelineChartSVG emits SVG with wall-clock axis label", () => {
  const samples: MultiRunMilestone[] = [
    { ...milestone(1, 0.9, 3_600_000, 0.1), cumulativeWallClockMs: 3_600_000 },
    { ...milestone(2, 0.8, 3_600_000, 0.2), cumulativeWallClockMs: 7_200_000 },
  ];
  const svg = renderMultiRunTimelineChartSVG(samples, { caption: true });
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "Wall-clock time (hours)");
  assertStringIncludes(svg, "Hold-out score");
  assert(svg.includes("Total wall-clock"));
});
