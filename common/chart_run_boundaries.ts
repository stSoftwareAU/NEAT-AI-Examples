/**
 * Shared run-boundary handling for the multi-run SVG chart renderers.
 *
 * `multi_run_complexity_chart.ts` and `multi_run_error_chart.ts` both
 * mark where one run ends and the next begins, and both split their
 * polylines so no vertical connector is drawn across that seam. Those
 * two pieces of knowledge were verbatim copies (issue #780) and live
 * here once:
 *
 *   - **Detection** — {@link detectRunBoundaries} walks the milestones in
 *     cumulative order and de-duplicates each `runIndex` transition to a
 *     single `(runIndex, cumulativeGen)` pair.
 *   - **Segmentation** — {@link segmentSamplesByRun} splits the samples
 *     into contiguous runs so polylines stop at each boundary.
 *   - **Emission** — {@link renderRunBoundaries} renders the
 *     `<g class="run-boundaries">` fragment: a faint full-height guide
 *     line plus a `run N` label for every boundary the thinning policy
 *     keeps.
 *
 * The thinning *policy* itself stays in `./multi_run_boundary_thinning.ts`;
 * this module is the detection and emission around it. Numbers are
 * formatted through `./svg_text.ts` so every chart rounds identically.
 *
 * Pure string emission — no DOM, no dependencies. Output is
 * byte-identical for identical inputs.
 */

import { selectVisibleBoundaryIndices } from "./multi_run_boundary_thinning.ts";
import { fmt } from "./svg_text.ts";

/** Stroke colour for the faint run-boundary guide line. */
const BOUNDARY_COLOUR = "#cccccc";

/** Minimal sample shape the boundary helpers need from a milestone. */
export interface RunBoundarySample {
  /** 1-based run index — increases each time evolution is resumed. */
  runIndex: number;
  /** Cumulative generation across all runs combined. */
  cumulativeGen: number;
}

/** A detected transition into a new run, at the generation it starts. */
export interface RunBoundary {
  /** Run the series enters at this boundary. */
  runIndex: number;
  /** Cumulative generation of the first sample of that run. */
  cumulativeGen: number;
}

/** Options for {@link renderRunBoundaries}. */
export interface RunBoundaryOptions {
  /** Milestones in cumulative-generation order. */
  samples: readonly RunBoundarySample[];
  /** Maps a cumulative-generation value to its pixel X. */
  xScale: (v: number) => number;
  /** Y coordinate of the top of the plot area. */
  plotTop: number;
  /** Height of the plot area in user units. */
  plotH: number;
  /** Width of the plot area in user units — drives label thinning. */
  plotW: number;
}

/**
 * Detect every `runIndex` transition in cumulative order, de-duplicated
 * to one `(runIndex, cumulativeGen)` pair per transition. A series with
 * a single run yields no boundaries.
 */
export function detectRunBoundaries(
  samples: readonly RunBoundarySample[],
): RunBoundary[] {
  const boundaries: RunBoundary[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (curr.runIndex === prev.runIndex) continue;
    boundaries.push({
      runIndex: curr.runIndex,
      cumulativeGen: curr.cumulativeGen,
    });
  }
  return boundaries;
}

/**
 * Split milestones into contiguous runs so polylines do not draw
 * vertical connectors at run boundaries. Extra sample fields are carried
 * through untouched.
 */
export function segmentSamplesByRun<T extends { runIndex: number }>(
  samples: readonly T[],
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const s of samples) {
    if (cur.length > 0 && s.runIndex !== cur[cur.length - 1].runIndex) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Render the run-boundary guide lines and `run N` labels as a
 * `<g class="run-boundaries">` fragment. Only the boundaries the
 * thinning policy keeps are emitted — ticks follow labels, so a bare
 * guide line is never drawn. The group is still emitted (empty) when
 * there are no transitions.
 */
export function renderRunBoundaries(options: RunBoundaryOptions): string {
  const { samples, xScale, plotTop, plotH, plotW } = options;
  const boundaries = detectRunBoundaries(samples);

  const longestLabel = boundaries.length === 0 ? 0 : Math.max(
    ...boundaries.map((b) => `run ${b.runIndex}`.length),
  );
  const selected = selectVisibleBoundaryIndices(
    boundaries,
    plotW,
    longestLabel,
    xScale,
  );

  const out: string[] = [];
  out.push(
    `  <g class="run-boundaries" font-family="sans-serif" font-size="10" fill="#666666">`,
  );
  for (let i = 0; i < boundaries.length; i++) {
    if (!selected.has(i)) continue;
    const b = boundaries[i];
    const x = xScale(b.cumulativeGen);
    out.push(
      `    <line class="run-boundary" x1="${fmt(x)}" y1="${fmt(plotTop)}" ` +
        `x2="${fmt(x)}" y2="${fmt(plotTop + plotH)}" ` +
        `stroke="${BOUNDARY_COLOUR}" stroke-width="0.5"/>`,
    );
    out.push(
      `    <text x="${fmt(x)}" y="${fmt(plotTop - 4)}" text-anchor="middle">` +
        `run ${b.runIndex}</text>`,
    );
  }
  out.push(`  </g>`);
  return out.join("\n");
}
