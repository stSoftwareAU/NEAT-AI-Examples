/**
 * Multi-run complexity-curve SVG renderer.
 *
 * Plots creature complexity (neuron count and synapse count) versus
 * cumulative generations across every run combined, with faint vertical
 * guide lines and labels at each run boundary. Use this to visualise the
 * diminishing-returns / "evolution slows as topology grows" narrative
 * that emerges when an example is resumed across multiple runs via
 * {@link ./multi_run_state.ts}.
 *
 * Series:
 *   - neurons (left axis, green)
 *   - synapses (right axis, red)
 *
 * Pure string emission — no DOM, no extra dependencies. Output is
 * byte-identical for identical inputs.
 */

import type { MultiRunMilestone } from "./multi_run_state.ts";
import { renderLeftAxis, renderRightAxis, renderXAxis } from "./chart_axis.ts";
import { renderRunBoundaries, segmentSamplesByRun } from "./chart_run_boundaries.ts";
import { escapeAttr, escapeText, fmt } from "./svg_text.ts";
import { makeScale, makeXScale, maxBy } from "./chart_scale.ts";

/** Options controlling {@link renderMultiRunComplexityChartSVG}. */
export interface RenderMultiRunComplexityChartOptions {
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
   * Render a caption block summarising the final neuron + synapse counts
   * and total run count. Default `false`.
   */
  caption?: boolean;
}

/** Stroke colour for the neurons polyline (left axis). */
const NEURONS_COLOUR = "#2ca02c";
/** Stroke colour for the synapses polyline (right axis). */
const SYNAPSES_COLOUR = "#d62728";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;
const DEFAULT_TITLE = "Multi-run evolution — creature complexity vs cumulative generations";

/** Plot-area inset from the SVG edges, leaving room for axes and legend. */
const MARGIN = { top: 50, right: 70, bottom: 60, left: 70 } as const;

/**
 * Render the multi-run complexity history as a dual-axis SVG string.
 *
 * Throws if `samples` is empty — callers are expected to skip rendering
 * when no milestones have been captured yet.
 */
export function renderMultiRunComplexityChartSVG(
  samples: readonly MultiRunMilestone[],
  options: RenderMultiRunComplexityChartOptions = {},
): string {
  if (samples.length === 0) {
    throw new Error(
      "renderMultiRunComplexityChartSVG requires at least one sample",
    );
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? DEFAULT_TITLE;
  const logX = options.logX ?? true;
  const caption = options.caption ?? false;

  // Sort defensively by cumulativeGen so plotting is stable regardless
  // of input order. Never mutate the caller's array.
  const ordered = [...samples].sort(
    (a, b) => a.cumulativeGen - b.cumulativeGen,
  );

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  const genMin = ordered[0].cumulativeGen;
  const genMax = ordered[ordered.length - 1].cumulativeGen;

  // Independent Y ranges per axis, clamped to zero so growth from a
  // small seed is readable. Use a +1 floor so a degenerate single-value
  // series still has a visible axis range.
  const neuronsMax = Math.max(1, maxBy(ordered, (s) => s.neurons));
  const synapsesMax = Math.max(1, maxBy(ordered, (s) => s.synapses));

  const xScale = makeXScale(genMin, genMax, plotX, plotX + plotW, logX);
  const yLeftScale = makeScale(0, neuronsMax, plotY + plotH, plotY);
  const yRightScale = makeScale(0, synapsesMax, plotY + plotH, plotY);

  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="${escapeAttr(title)} dual-axis chart">`,
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
    min: 0,
    max: neuronsMax,
    scale: yLeftScale,
    baseX: plotX,
    label: "neurons",
    integerTicks: true,
  }));
  lines.push(renderRightAxis({
    min: 0,
    max: synapsesMax,
    scale: yRightScale,
    baseX: plotX + plotW,
    label: "synapses",
    integerTicks: true,
  }));

  // Run-boundary markers — render under the polylines so the data stays
  // visually on top. Detect each runIndex transition in cumulative order.
  lines.push(renderRunBoundaries({
    samples: ordered,
    xScale,
    plotTop: plotY,
    plotH,
    plotW,
  }));

  // Series — neurons on left axis, synapses on right axis.
  lines.push(
    renderSeries(
      "neurons-line",
      "neurons-point",
      NEURONS_COLOUR,
      ordered,
      xScale,
      (s) => yLeftScale(s.neurons),
    ),
  );
  lines.push(
    renderSeries(
      "synapses-line",
      "synapses-point",
      SYNAPSES_COLOUR,
      ordered,
      xScale,
      (s) => yRightScale(s.synapses),
    ),
  );

  lines.push(renderLegend(plotX, plotY));

  if (caption) {
    lines.push(renderCaption(ordered, width, height));
  }

  lines.push(`</svg>`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Series, legend and caption rendering
// ---------------------------------------------------------------------------

function renderSeries(
  lineClass: string,
  pointClass: string,
  colour: string,
  samples: readonly MultiRunMilestone[],
  xScale: (v: number) => number,
  yScale: (s: MultiRunMilestone) => number,
): string {
  const segments = segmentSamplesByRun(samples);
  const out: string[] = [];
  out.push(`  <g class="${lineClass}">`);
  for (const seg of segments) {
    const points = seg.map(
      (s) => `${fmt(xScale(s.cumulativeGen))},${fmt(yScale(s))}`,
    );
    out.push(
      `    <polyline class="${lineClass}-segment" fill="none" stroke="${colour}" ` +
        `stroke-width="1.5" points="${points.join(" ")}"/>`,
    );
  }
  for (const s of samples) {
    out.push(
      `    <circle class="${pointClass}" cx="${fmt(xScale(s.cumulativeGen))}" ` +
        `cy="${fmt(yScale(s))}" r="2.4" fill="${colour}"/>`,
    );
  }
  out.push(`  </g>`);
  return out.join("\n");
}

function renderLegend(plotX: number, plotY: number): string {
  const x = plotX + 12;
  const y = plotY + 12;
  const items: Array<[string, string]> = [
    [NEURONS_COLOUR, "neurons"],
    [SYNAPSES_COLOUR, "synapses"],
  ];
  const out: string[] = [];
  out.push(
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222222">`,
  );
  out.push(
    `    <rect x="${fmt(x - 6)}" y="${fmt(y - 10)}" width="120" height="40" ` +
      `fill="#ffffff" fill-opacity="0.85" stroke="#cccccc" stroke-width="0.5"/>`,
  );
  items.forEach(([colour, label], i) => {
    const itemY = y + i * 16;
    out.push(
      `    <line x1="${fmt(x)}" y1="${fmt(itemY)}" x2="${fmt(x + 18)}" y2="${fmt(itemY)}" ` +
        `stroke="${colour}" stroke-width="2"/>`,
    );
    out.push(
      `    <text x="${fmt(x + 24)}" y="${fmt(itemY + 4)}">${escapeText(label)}</text>`,
    );
  });
  out.push(`  </g>`);
  return out.join("\n");
}

function renderCaption(
  samples: readonly MultiRunMilestone[],
  width: number,
  height: number,
): string {
  const last = samples[samples.length - 1];
  const distinctRuns = new Set(samples.map((s) => s.runIndex)).size;
  const text = `final ${last.neurons} neurons · ${last.synapses} synapses · ` +
    `${distinctRuns} runs · ${last.cumulativeGen} cumulative generations`;
  return [
    `  <g class="caption" font-family="sans-serif" font-size="12" fill="#222222">`,
    `    <text x="${fmt(width / 2)}" y="${fmt(height - 6)}" text-anchor="middle">` +
    escapeText(text) + `</text>`,
    `  </g>`,
  ].join("\n");
}
