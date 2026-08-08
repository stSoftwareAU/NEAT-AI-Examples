/**
 * Shared axis rendering for the SVG chart renderers.
 *
 * The X, left and right axes of `milestone_chart.ts`,
 * `multi_run_complexity_chart.ts` and `multi_run_error_chart.ts` were
 * verbatim copies differing only in their label text, their group class
 * and whether ticks are integers (issue #776). Those three differences
 * are parameters here; everything else — tick geometry, fonts, colours,
 * rotated axis titles — is emitted once.
 *
 * Also home to the deterministic number formatting and XML escaping the
 * chart bodies share, so axis fragments and chart fragments round
 * coordinates identically.
 *
 * Pure string emission — no DOM, no dependencies. Output is
 * byte-identical for identical inputs.
 */

import { logTicks, niceTicks } from "./chart_scale.ts";

/** Tick target for the X axis (the widest axis on every chart). */
const X_AXIS_TICK_TARGET = 8;
/** Tick target for the left/right value axes. */
const VALUE_AXIS_TICK_TARGET = 5;
/** Horizontal offset of the rotated axis title from the plot edge. */
const AXIS_TITLE_OFFSET = 48;

/** Common shape of every axis fragment request. */
interface AxisOptionsBase {
  /** Lower bound of the axis domain. */
  min: number;
  /** Upper bound of the axis domain. */
  max: number;
  /** Maps a domain value to its pixel position along the axis. */
  scale: (v: number) => number;
  /** Axis title, rendered without the `(log scale)` suffix. */
  label: string;
}

/** Options for {@link renderXAxis}. */
export interface XAxisOptions extends AxisOptionsBase {
  /** Y coordinate of the axis baseline (the bottom of the plot area). */
  baseY: number;
  /** Whether the X scale is logarithmic — selects decade ticks and annotates the title. */
  logX: boolean;
}

/** Options for {@link renderLeftAxis} and {@link renderRightAxis}. */
export interface ValueAxisOptions extends AxisOptionsBase {
  /** X coordinate of the plot edge this axis is drawn against. */
  baseX: number;
  /** Round ticks to whole numbers — use for count axes (neurons, synapses). */
  integerTicks: boolean;
  /** Semantic class on the axis group. Defaults to `left-axis` / `right-axis`. */
  groupClass?: string;
}

/**
 * Render the X axis: a tick mark plus label per generation tick, and a
 * centred axis title. Log mode uses decade ticks and appends
 * `(log scale)` to the title.
 */
export function renderXAxis(options: XAxisOptions): string {
  const { min, max, scale, baseY, logX, label } = options;
  const ticks = logX ? logTicks(min, max) : niceTicks(min, max, X_AXIS_TICK_TARGET, true);
  const out: string[] = [];
  out.push(
    `  <g class="x-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const x = scale(t);
    out.push(
      `    <line x1="${fmt(x)}" y1="${fmt(baseY)}" x2="${fmt(x)}" y2="${fmt(baseY + 4)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(x)}" y="${fmt(baseY + 18)}" text-anchor="middle">${t}</text>`,
    );
  }
  const labelX = (scale(min) + scale(max)) / 2;
  const title = logX ? `${label} (log scale)` : label;
  out.push(
    `    <text x="${fmt(labelX)}" y="${fmt(baseY + 36)}" text-anchor="middle" ` +
      `font-weight="bold">${escapeText(title)}</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

/**
 * Render a value axis against the left edge of the plot area: outward
 * tick marks, end-anchored tick labels and a title rotated -90°.
 */
export function renderLeftAxis(options: ValueAxisOptions): string {
  const { min, max, scale, baseX, label, integerTicks } = options;
  const groupClass = options.groupClass ?? "left-axis";
  const out: string[] = [];
  out.push(
    `  <g class="${groupClass}" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of niceTicks(min, max, VALUE_AXIS_TICK_TARGET, integerTicks)) {
    const y = scale(t);
    out.push(
      `    <line x1="${fmt(baseX - 4)}" y1="${fmt(y)}" x2="${fmt(baseX)}" y2="${fmt(y)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX - 8)}" y="${fmt(y)}" text-anchor="end" ` +
        `dominant-baseline="middle">${formatAxisValue(t)}</text>`,
    );
  }
  const midY = (scale(min) + scale(max)) / 2;
  const titleX = baseX - AXIS_TITLE_OFFSET;
  out.push(
    `    <text x="${fmt(titleX)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(-90 ${fmt(titleX)} ${fmt(midY)})">${escapeText(label)}</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

/**
 * Render a value axis against the right edge of the plot area: outward
 * tick marks, start-anchored tick labels and a title rotated 90°.
 */
export function renderRightAxis(options: ValueAxisOptions): string {
  const { min, max, scale, baseX, label, integerTicks } = options;
  const groupClass = options.groupClass ?? "right-axis";
  const out: string[] = [];
  out.push(
    `  <g class="${groupClass}" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of niceTicks(min, max, VALUE_AXIS_TICK_TARGET, integerTicks)) {
    const y = scale(t);
    out.push(
      `    <line x1="${fmt(baseX)}" y1="${fmt(y)}" x2="${fmt(baseX + 4)}" y2="${fmt(y)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX + 8)}" y="${fmt(y)}" text-anchor="start" ` +
        `dominant-baseline="middle">${formatAxisValue(t)}</text>`,
    );
  }
  const midY = (scale(min) + scale(max)) / 2;
  const titleX = baseX + AXIS_TITLE_OFFSET;
  out.push(
    `    <text x="${fmt(titleX)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(90 ${fmt(titleX)} ${fmt(midY)})">${escapeText(label)}</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

/** Round a numeric coordinate to two decimal places for compact, deterministic output. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}

/** Format an axis value (score, error, count) to a short, deterministic string. */
export function formatAxisValue(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
}

/** Escape XML metacharacters for use in element text content. */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape XML metacharacters for use inside a double-quoted attribute. */
export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
