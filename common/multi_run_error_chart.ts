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

  lines.push(renderXAxis(genMin, genMax, xScale, plotY + plotH, logX));
  lines.push(renderYAxis(yMin, yMax, yScale, plotX));

  // Run-boundary markers — render under the polyline so the line stays
  // visually on top. Detect each runIndex transition in cumulative order.
  lines.push(renderRunBoundaries(ordered, xScale, plotY, plotH));

  // Single continuous error polyline across every sample.
  lines.push(renderErrorSeries(ordered, xScale, yScale));

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

function renderYAxis(
  yMin: number,
  yMax: number,
  yScale: (v: number) => number,
  baseX: number,
): string {
  const ticks = niceTicks(yMin, yMax, 5, false);
  const out: string[] = [];
  out.push(
    `  <g class="y-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX - 4)}" y1="${fmt(y)}" x2="${fmt(baseX)}" y2="${fmt(y)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX - 8)}" y="${fmt(y)}" text-anchor="end" ` +
        `dominant-baseline="middle">${formatError(t)}</text>`,
    );
  }
  const midY = (yScale(yMin) + yScale(yMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX - 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(-90 ${fmt(baseX - 48)} ${fmt(midY)})">error</text>`,
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

function renderErrorSeries(
  samples: readonly MultiRunMilestone[],
  xScale: (v: number) => number,
  yScale: (v: number) => number,
): string {
  const points = samples.map((s) => `${fmt(xScale(s.cumulativeGen))},${fmt(yScale(s.error))}`);
  const out: string[] = [];
  out.push(`  <g class="error-line">`);
  out.push(
    `    <polyline fill="none" stroke="${ERROR_COLOUR}" stroke-width="1.5" ` +
      `points="${points.join(" ")}"/>`,
  );
  for (const s of samples) {
    out.push(
      `    <circle class="error-point" cx="${fmt(xScale(s.cumulativeGen))}" ` +
        `cy="${fmt(yScale(s.error))}" r="2.4" fill="${ERROR_COLOUR}"/>`,
    );
  }
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
  const totalGens = last.cumulativeGen;
  const totalMs = samples.reduce((acc, s) => acc + s.generationWallClockMs, 0);
  const text = `final error ${formatError(last.error)} · ${distinctRuns} runs · ` +
    `${totalGens} cumulative generations · ${totalMs} ms total`;
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

/** Format an error value to a short, deterministic string. */
function formatError(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
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
