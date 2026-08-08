/**
 * Shared SVG renderer for `evolveRL()` milestone statistics.
 *
 * `Creature.evolveRL()` emits `evolverl_milestone` events whose payload is
 * captured per-checkpoint as a {@link MilestoneSample}. The milestone
 * stream is sparse and non-uniformly spaced (typically 1, 2, 5, 10, 20,
 * 50, 100, 200, 500, 1000, then powers of ten), so this renderer plots
 * each sample at its actual generation and offers an optional log-X
 * mapping for the wide dynamic range.
 *
 * Series:
 *   - `bestScore` (left axis, blue)
 *   - `meanEpisodeSteps` (left axis, orange)
 *   - `bestNeurons` (right axis, green)
 *   - `bestSynapses` (right axis, red)
 *
 * Pure string emission — no DOM, no extra dependencies. Output is
 * byte-identical for identical inputs.
 */

import {
  escapeAttr,
  escapeText,
  fmt,
  formatAxisValue,
  renderLeftAxis,
  renderRightAxis,
  renderXAxis,
} from "./chart_axis.ts";
import { makeScale, makeXScale, maxBy, minBy } from "./chart_scale.ts";

/** A single milestone sample emitted by `Creature.evolveRL`. */
export interface MilestoneSample {
  /** Milestone generation (e.g. 1, 10, 100, 1000). */
  generation: number;
  /** Best fitness score at this milestone. */
  bestScore: number;
  /** Neuron count of the best creature at this milestone. */
  bestNeurons: number;
  /** Synapse count of the best creature at this milestone. */
  bestSynapses: number;
  /** Mean episode steps across the milestone evaluation. */
  meanEpisodeSteps: number;
  /** Wall-clock duration of the generation that produced this milestone (ms). */
  generationWallClockMs: number;
}

/** Options controlling {@link renderMilestoneChartSVG}. */
export interface RenderMilestoneChartOptions {
  /** Total SVG width in user units. Default 800. */
  width?: number;
  /** Total SVG height in user units. Default 400. */
  height?: number;
  /** Chart title rendered at the top. Default "evolveRL Milestones". */
  title?: string;
  /**
   * Plot generation on a base-10 logarithmic X axis. Recommended for the
   * canonical 1, 10, 100, 1000, … milestone schedule. Default `false`.
   */
  logX?: boolean;
  /**
   * Render a caption block summarising the final score, topology size and
   * the total wall-clock duration (sum of `generationWallClockMs`).
   * Default `false`.
   */
  caption?: boolean;
}

/** Stroke colour for the best-score line (left axis). */
const SCORE_COLOUR = "#1f77b4";
/** Stroke colour for the mean-episode-steps line (left axis). */
const STEPS_COLOUR = "#ff7f0e";
/** Stroke colour for the neuron-count line (right axis). */
const NEURONS_COLOUR = "#2ca02c";
/** Stroke colour for the synapse-count line (right axis). */
const SYNAPSES_COLOUR = "#d62728";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;

/** Plot-area inset from the SVG edges, leaving room for axes and legend. */
const MARGIN = { top: 40, right: 70, bottom: 60, left: 70 } as const;

/**
 * Render the milestone history as a dual-axis SVG string.
 *
 * Throws if `samples` is empty — callers are expected to skip rendering
 * when no milestones have been captured.
 */
export function renderMilestoneChartSVG(
  samples: readonly MilestoneSample[],
  options: RenderMilestoneChartOptions = {},
): string {
  if (samples.length === 0) {
    throw new Error("renderMilestoneChartSVG requires at least one sample");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? "evolveRL Milestones";
  const logX = options.logX ?? false;
  const caption = options.caption ?? false;

  // Sort defensively by generation so plotting is stable regardless of
  // input order. Use a copy — never mutate the caller's array.
  const ordered = [...samples].sort((a, b) => a.generation - b.generation);

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  const genMin = ordered[0].generation;
  const genMax = ordered[ordered.length - 1].generation;

  const scoreMin = minBy(ordered, (s) => s.bestScore);
  const scoreMax = maxBy(ordered, (s) => s.bestScore);
  const stepsMin = minBy(ordered, (s) => s.meanEpisodeSteps);
  const stepsMax = maxBy(ordered, (s) => s.meanEpisodeSteps);

  // Combined left-axis range so score and step series share a reference.
  const leftMin = Math.min(scoreMin, stepsMin);
  const leftMax = Math.max(scoreMax, stepsMax);

  // Shared right-axis range for the two count series, clamped to zero.
  const countMax = Math.max(
    maxBy(ordered, (s) => s.bestNeurons),
    maxBy(ordered, (s) => s.bestSynapses),
  );
  const countMin = 0;

  const xScale = makeXScale(genMin, genMax, plotX, plotX + plotW, logX);
  const yLeftScale = makeScale(leftMin, leftMax, plotY + plotH, plotY);
  const yRightScale = makeScale(countMin, countMax, plotY + plotH, plotY);

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
    label: "generation",
  }));
  lines.push(renderLeftAxis({
    min: leftMin,
    max: leftMax,
    scale: yLeftScale,
    baseX: plotX,
    label: "score / mean steps",
    integerTicks: false,
  }));
  lines.push(renderRightAxis({
    min: countMin,
    max: countMax,
    scale: yRightScale,
    baseX: plotX + plotW,
    label: "neurons / synapses",
    integerTicks: true,
  }));

  // Series — left axis first, then right axis.
  lines.push(
    renderSeries(
      "best-score-line",
      "best-score-point",
      SCORE_COLOUR,
      ordered,
      xScale,
      (s) => yLeftScale(s.bestScore),
    ),
  );
  lines.push(
    renderSeries(
      "mean-steps-line",
      "mean-steps-point",
      STEPS_COLOUR,
      ordered,
      xScale,
      (s) => yLeftScale(s.meanEpisodeSteps),
    ),
  );
  lines.push(
    renderSeries(
      "neurons-line",
      "neurons-point",
      NEURONS_COLOUR,
      ordered,
      xScale,
      (s) => yRightScale(s.bestNeurons),
    ),
  );
  lines.push(
    renderSeries(
      "synapses-line",
      "synapses-point",
      SYNAPSES_COLOUR,
      ordered,
      xScale,
      (s) => yRightScale(s.bestSynapses),
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
  samples: readonly MilestoneSample[],
  xScale: (v: number) => number,
  yScale: (s: MilestoneSample) => number,
): string {
  const points = samples.map((s) => `${fmt(xScale(s.generation))},${fmt(yScale(s))}`);
  const out: string[] = [];
  out.push(`  <g class="${lineClass}">`);
  out.push(
    `    <polyline fill="none" stroke="${colour}" stroke-width="1.5" ` +
      `points="${points.join(" ")}"/>`,
  );
  for (const s of samples) {
    out.push(
      `    <circle class="${pointClass}" cx="${fmt(xScale(s.generation))}" ` +
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
    [SCORE_COLOUR, "best score"],
    [STEPS_COLOUR, "mean episode steps"],
    [NEURONS_COLOUR, "neurons"],
    [SYNAPSES_COLOUR, "synapses"],
  ];
  const out: string[] = [];
  out.push(
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222222">`,
  );
  out.push(
    `    <rect x="${fmt(x - 6)}" y="${fmt(y - 10)}" width="160" height="72" ` +
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
  samples: readonly MilestoneSample[],
  width: number,
  height: number,
): string {
  const last = samples[samples.length - 1];
  const totalMs = samples.reduce((acc, s) => acc + s.generationWallClockMs, 0);
  const text = `final score ${formatAxisValue(last.bestScore)} · ` +
    `${last.bestNeurons} neurons · ${last.bestSynapses} synapses · ` +
    `${totalMs} ms total`;
  return [
    `  <g class="caption" font-family="sans-serif" font-size="12" fill="#222222">`,
    `    <text x="${fmt(width / 2)}" y="${fmt(height - 6)}" text-anchor="middle">` +
    escapeText(text) + `</text>`,
    `  </g>`,
  ].join("\n");
}
