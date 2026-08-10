/**
 * Multi-run error-curve SVG renderer.
 *
 * Plots a single continuous error polyline across every run combined,
 * with faint vertical guide lines and labels at each run boundary. Use
 * this to visualise the unified noise → competent arc that emerges when
 * an example is resumed across multiple runs via
 * {@link ./multi_run_state.ts}.
 *
 * Series:
 *   - error vs cumulative generation (single continuous line)
 *
 * Pure string emission — no DOM, no extra dependencies. Output is
 * byte-identical for identical inputs.
 */

import type { MultiRunMilestone } from "./multi_run_state.ts";
import { selectVisibleBoundaryIndices } from "./multi_run_boundary_thinning.ts";
import { renderLeftAxis, renderXAxis } from "./chart_axis.ts";
import { escapeAttr, escapeText, fmt, formatScore } from "./svg_text.ts";
import { makeScale, makeXScale, maxBy } from "./chart_scale.ts";

/** Options controlling {@link renderMultiRunErrorChartSVG}. */
export interface RenderMultiRunErrorChartOptions {
  /** Total SVG width in user units. Default 800. */
  width?: number;
  /** Total SVG height in user units. Default 400. */
  height?: number;
  /** Chart title rendered at the top. */
  title?: string;
  /**
   * Plot cumulative generation on a base-10 logarithmic X axis. Default
   * `true` because milestone cadence (1, 10, 100, ...) spans several
   * orders of magnitude.
   */
  logX?: boolean;
  /**
   * Render a caption block summarising the final error, total runs,
   * total cumulative generations and total wall-clock (sum of
   * `generationWallClockMs`). Default `false`.
   */
  caption?: boolean;
}

/** Stroke colour for the error polyline. */
const ERROR_COLOUR = "#d62728";
/** Stroke colour for the faint run-boundary guide line. */
const BOUNDARY_COLOUR = "#cccccc";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;
const DEFAULT_TITLE = "Multi-run evolution — error vs cumulative generations";

/** Minimum upper bound of the Y axis — keeps low-error runs readable. */
const MIN_Y_MAX = 0.05;

/** Plot-area inset from the SVG edges, leaving room for axes and caption. */
const MARGIN = { top: 50, right: 40, bottom: 60, left: 70 } as const;

/**
 * Render the multi-run error history as an SVG string.
 *
 * Throws if `samples` is empty — callers are expected to skip rendering
 * when no milestones have been captured yet.
 */
export function renderMultiRunErrorChartSVG(
  samples: readonly MultiRunMilestone[],
  options: RenderMultiRunErrorChartOptions = {},
): string {
  if (samples.length === 0) {
    throw new Error("renderMultiRunErrorChartSVG requires at least one sample");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? DEFAULT_TITLE;
  const logX = options.logX ?? true;
  const caption = options.caption ?? false;

  // Sort defensively by cumulativeGen so the polyline is stable
  // regardless of input order. Never mutate the caller's array.
  const ordered = [...samples].sort((a, b) => a.cumulativeGen - b.cumulativeGen);

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  const genMin = ordered[0].cumulativeGen;
  const genMax = ordered[ordered.length - 1].cumulativeGen;

  // Y axis: linear, [0, max(MIN_Y_MAX, observedMax)].
  const observedMax = maxBy(ordered, (s) => s.error);
  const yMax = Math.max(MIN_Y_MAX, observedMax);
  const yMin = 0;

  const xScale = makeXScale(genMin, genMax, plotX, plotX + plotW, logX);
  const yScale = makeScale(yMin, yMax, plotY + plotH, plotY);

  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="${escapeAttr(title)} chart">`,
    `  <title>${escapeText(title)}</title>`,
    `  <rect width="${width}" height="${height}" fill="#fafafa"/>`,
    `  <text x="${width / 2}" y="24" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      escapeText(title) +
      `</text>`,
  );

  lines.push(
    `  <rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" ` +
      `fill="#ffffff" stroke="#333333" stroke-width="1"/>`,
  );

  lines.push(renderXAxis({
    min: genMin,
    max: genMax,
    scale: xScale,
    baseY: plotY + plotH,
    logX,
    label: "cumulative generation",
  }));
  lines.push(renderLeftAxis({
    min: yMin,
    max: yMax,
    scale: yScale,
    baseX: plotX,
    label: "error",
    integerTicks: false,
    groupClass: "y-axis",
  }));
  if (logX) {
    lines.push(
      renderAxisFootnote(
        plotX,
        plotY + plotH + 46,
        plotW,
        "Linear error on Y · log₁₀ generations on X · line is best error so far · dots are raw milestone measurements.",
      ),
    );
  }

  // Run-boundary markers — render under the polylines so the data stays
  // visually on top. Detect each runIndex transition in cumulative order.
  lines.push(renderRunBoundaries(ordered, xScale, plotY, plotH, plotW));

  // Issue #431: plot the best-error-so-far envelope as a single
  // continuous polyline. The envelope is monotonically non-increasing,
  // so re-evaluation noise at run boundaries (a resumed champion scoring
  // worse on fresh stochastic episodes) no longer makes the
  // evolution-progress line appear to regress. Raw measurements are
  // still surfaced via circle markers.
  lines.push(renderErrorSeries(ordered, xScale, yScale));

  if (caption) {
    lines.push(renderCaption(ordered, width, height));
  }

  lines.push(`</svg>`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run boundaries, series and caption rendering
// ---------------------------------------------------------------------------

function renderRunBoundaries(
  samples: readonly MultiRunMilestone[],
  xScale: (v: number) => number,
  plotTop: number,
  plotH: number,
  plotW: number,
): string {
  // Detect every runIndex transition in cumulative order before
  // applying the thinning policy — boundaries are de-duplicated to
  // (runIndex, cumulativeGen) pairs at this stage.
  const boundaries: Array<{ runIndex: number; cumulativeGen: number }> = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (curr.runIndex === prev.runIndex) continue;
    boundaries.push({
      runIndex: curr.runIndex,
      cumulativeGen: curr.cumulativeGen,
    });
  }

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

function renderErrorSeries(
  samples: readonly MultiRunMilestone[],
  xScale: (v: number) => number,
  yScale: (v: number) => number,
): string {
  // Issue #431: render a single best-error-so-far envelope as the
  // evolution-progress line. Walking the samples in cumulative order
  // and taking the running minimum guarantees the polyline is
  // monotonically non-increasing in error — it never spikes up at run
  // boundaries even when a resumed champion is re-measured slightly
  // worse on fresh stochastic episodes.
  const envelope: number[] = [];
  let runningMin = Infinity;
  for (const s of samples) {
    if (s.error < runningMin) runningMin = s.error;
    envelope.push(runningMin);
  }

  const out: string[] = [];
  out.push(`  <g class="error-line">`);
  const points = samples.map((s, i) =>
    `${fmt(xScale(s.cumulativeGen))},${fmt(yScale(envelope[i]))}`
  );
  out.push(
    `    <polyline class="error-envelope" fill="none" stroke="${ERROR_COLOUR}" ` +
      `stroke-width="1.5" points="${points.join(" ")}"/>`,
  );
  // Circles plot the raw milestone error — viewers can still see the
  // re-evaluation noise that motivated the envelope.
  for (const s of samples) {
    out.push(
      `    <circle class="error-point" cx="${fmt(xScale(s.cumulativeGen))}" ` +
        `cy="${fmt(yScale(s.error))}" r="2.4" fill="${ERROR_COLOUR}"/>`,
    );
  }
  out.push(`  </g>`);
  return out.join("\n");
}

function renderAxisFootnote(x: number, y: number, w: number, text: string): string {
  return [
    `  <g class="axis-footnote" font-family="sans-serif" font-size="10" fill="#666666">`,
    `    <text x="${fmt(x + w / 2)}" y="${fmt(y)}" text-anchor="middle">` +
    escapeText(text) + `</text>`,
    `  </g>`,
  ].join("\n");
}

function renderCaption(
  samples: readonly MultiRunMilestone[],
  width: number,
  height: number,
): string {
  const last = samples[samples.length - 1];
  const distinctRuns = new Set(samples.map((s) => s.runIndex)).size;
  const totalGens = last.cumulativeGen;
  const totalMs = samples.reduce((acc, s) => acc + s.generationWallClockMs, 0);
  // Issue #344: surface a generations-per-minute throughput rate so
  // viewers can see the effective training pace alongside the raw
  // wall-clock total. `totalMs === 0` is treated as 0 gens/min to keep
  // the caption finite and free of divide-by-zero artefacts.
  const gensPerMinute = totalMs > 0 ? (totalGens / totalMs) * 60_000 : 0;
  const text = `final error ${formatScore(last.error)} · ${distinctRuns} runs · ` +
    `${totalGens} cumulative generations · ${totalMs} ms total · ` +
    `${formatRate(gensPerMinute)} gen/min`;
  return [
    `  <g class="caption" font-family="sans-serif" font-size="12" fill="#222222">`,
    `    <text x="${fmt(width / 2)}" y="${fmt(height - 22)}" text-anchor="middle">` +
    escapeText(text) + `</text>`,
    `  </g>`,
  ].join("\n");
}

/** Format a generations-per-minute throughput rate to a short, deterministic string. */
function formatRate(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (v >= 10) return Math.round(v).toString();
  return (Math.round(v * 10) / 10).toString();
}
