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
/** Stroke colour for the faint run-boundary guide line. */
const BOUNDARY_COLOUR = "#cccccc";

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

  lines.push(renderXAxis(genMin, genMax, xScale, plotY + plotH, logX));
  lines.push(renderLeftAxis(0, neuronsMax, yLeftScale, plotX));
  lines.push(renderRightAxis(0, synapsesMax, yRightScale, plotX + plotW));

  // Run-boundary markers — render under the polylines so the data stays
  // visually on top. Detect each runIndex transition in cumulative order.
  lines.push(renderRunBoundaries(ordered, xScale, plotY, plotH));

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
// Scaling helpers
// ---------------------------------------------------------------------------

function maxBy<T>(arr: readonly T[], get: (t: T) => number): number {
  let best = -Infinity;
  for (const item of arr) {
    const v = get(item);
    if (v > best) best = v;
  }
  return best;
}

/**
 * Build a linear scale mapping `[domainMin, domainMax]` onto
 * `[rangeMin, rangeMax]`. Collapses to the centre of the range when the
 * domain is degenerate.
 */
function makeScale(
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): (v: number) => number {
  const dSpan = domainMax - domainMin;
  if (dSpan === 0) {
    const mid = (rangeMin + rangeMax) / 2;
    return () => mid;
  }
  const rSpan = rangeMax - rangeMin;
  return (v: number) => rangeMin + ((v - domainMin) / dSpan) * rSpan;
}

/**
 * Build an X scale that maps cumulative generation onto
 * `[rangeMin, rangeMax]`. In log mode, generation values are passed
 * through `Math.log10` after clamping to a minimum of 1 (avoids log(0)).
 */
function makeXScale(
  genMin: number,
  genMax: number,
  rangeMin: number,
  rangeMax: number,
  logX: boolean,
): (v: number) => number {
  if (!logX) {
    return makeScale(genMin, genMax, rangeMin, rangeMax);
  }
  const lMin = Math.log10(Math.max(1, genMin));
  const lMax = Math.log10(Math.max(1, genMax));
  const linear = makeScale(lMin, lMax, rangeMin, rangeMax);
  return (v: number) => linear(Math.log10(Math.max(1, v)));
}

// ---------------------------------------------------------------------------
// Axis and series rendering
// ---------------------------------------------------------------------------

function renderXAxis(
  genMin: number,
  genMax: number,
  xScale: (v: number) => number,
  baseY: number,
  logX: boolean,
): string {
  const ticks = logX ? logTicks(genMin, genMax) : niceTicks(genMin, genMax, 8, true);
  const out: string[] = [];
  out.push(
    `  <g class="x-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const x = xScale(t);
    out.push(
      `    <line x1="${fmt(x)}" y1="${fmt(baseY)}" x2="${fmt(x)}" y2="${fmt(baseY + 4)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(x)}" y="${fmt(baseY + 18)}" text-anchor="middle">${t}</text>`,
    );
  }
  const labelX = (xScale(genMin) + xScale(genMax)) / 2;
  const label = logX ? "cumulative generation (log scale)" : "cumulative generation";
  out.push(
    `    <text x="${fmt(labelX)}" y="${fmt(baseY + 36)}" text-anchor="middle" ` +
      `font-weight="bold">${escapeText(label)}</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderLeftAxis(
  yMin: number,
  yMax: number,
  yScale: (v: number) => number,
  baseX: number,
): string {
  const ticks = niceTicks(yMin, yMax, 5, true);
  const out: string[] = [];
  out.push(
    `  <g class="left-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX - 4)}" y1="${fmt(y)}" x2="${fmt(baseX)}" y2="${fmt(y)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX - 8)}" y="${fmt(y)}" text-anchor="end" ` +
        `dominant-baseline="middle">${t}</text>`,
    );
  }
  const midY = (yScale(yMin) + yScale(yMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX - 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(-90 ${fmt(baseX - 48)} ${fmt(midY)})">neurons</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderRightAxis(
  yMin: number,
  yMax: number,
  yScale: (v: number) => number,
  baseX: number,
): string {
  const ticks = niceTicks(yMin, yMax, 5, true);
  const out: string[] = [];
  out.push(
    `  <g class="right-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX)}" y1="${fmt(y)}" x2="${fmt(baseX + 4)}" y2="${fmt(y)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX + 8)}" y="${fmt(y)}" text-anchor="start" ` +
        `dominant-baseline="middle">${t}</text>`,
    );
  }
  const midY = (yScale(yMin) + yScale(yMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX + 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(90 ${fmt(baseX + 48)} ${fmt(midY)})">synapses</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderRunBoundaries(
  samples: readonly MultiRunMilestone[],
  xScale: (v: number) => number,
  plotTop: number,
  plotH: number,
): string {
  const out: string[] = [];
  out.push(
    `  <g class="run-boundaries" font-family="sans-serif" font-size="10" fill="#666666">`,
  );
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (curr.runIndex === prev.runIndex) continue;
    const x = xScale(curr.cumulativeGen);
    out.push(
      `    <line class="run-boundary" x1="${fmt(x)}" y1="${fmt(plotTop)}" ` +
        `x2="${fmt(x)}" y2="${fmt(plotTop + plotH)}" ` +
        `stroke="${BOUNDARY_COLOUR}" stroke-width="0.5"/>`,
    );
    out.push(
      `    <text x="${fmt(x)}" y="${fmt(plotTop - 4)}" text-anchor="middle">` +
        `run ${curr.runIndex}</text>`,
    );
  }
  out.push(`  </g>`);
  return out.join("\n");
}

function renderSeries(
  lineClass: string,
  pointClass: string,
  colour: string,
  samples: readonly MultiRunMilestone[],
  xScale: (v: number) => number,
  yScale: (s: MultiRunMilestone) => number,
): string {
  const points = samples.map(
    (s) => `${fmt(xScale(s.cumulativeGen))},${fmt(yScale(s))}`,
  );
  const out: string[] = [];
  out.push(`  <g class="${lineClass}">`);
  out.push(
    `    <polyline fill="none" stroke="${colour}" stroke-width="1.5" ` +
      `points="${points.join(" ")}"/>`,
  );
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

// ---------------------------------------------------------------------------
// Tick generation and number formatting
// ---------------------------------------------------------------------------

/**
 * Produce roughly `target` evenly spaced tick values across `[min, max]`.
 * When `integerOnly` is true the ticks are rounded to integers and
 * de-duplicated. When the range is degenerate the function returns the
 * single value as the only tick.
 */
function niceTicks(min: number, max: number, target: number, integerOnly: boolean): number[] {
  if (min === max) {
    return [integerOnly ? Math.round(min) : min];
  }
  const span = max - min;
  const rawStep = span / Math.max(1, target);
  const step = integerOnly ? Math.max(1, Math.round(rawStep)) : niceStep(rawStep);
  const out: number[] = [];
  const start = integerOnly ? Math.ceil(min / step) * step : min;
  for (let v = start; v <= max + 1e-9; v += step) {
    if (integerOnly) out.push(Math.round(v));
    else out.push(v);
  }
  if (out.length === 0) out.push(integerOnly ? Math.round(min) : min);
  const lastTick = integerOnly ? Math.round(max) : max;
  if (out[out.length - 1] !== lastTick) out.push(lastTick);
  return integerOnly ? Array.from(new Set(out)) : out;
}

/**
 * Produce powers-of-ten tick values across `[min, max]`, with the bounds
 * themselves added when they are not already on a decade boundary.
 */
function logTicks(min: number, max: number): number[] {
  const lo = Math.max(1, min);
  const hi = Math.max(lo, max);
  const startExp = Math.floor(Math.log10(lo));
  const endExp = Math.ceil(Math.log10(hi));
  const out: number[] = [];
  for (let e = startExp; e <= endExp; e++) {
    const v = Math.pow(10, e);
    if (v >= lo && v <= hi) out.push(v);
  }
  if (out.length === 0 || out[0] !== lo) out.unshift(lo);
  if (out[out.length - 1] !== hi) out.push(hi);
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const frac = raw / base;
  let nice: number;
  if (frac < 1.5) nice = 1;
  else if (frac < 3) nice = 2;
  else if (frac < 7) nice = 5;
  else nice = 10;
  return nice * base;
}

/** Round a numeric coordinate to two decimal places for compact, deterministic output. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
