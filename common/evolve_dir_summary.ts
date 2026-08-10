/**
 * Shared SVG summary chart for the return value of `Creature.evolveDir`.
 *
 * `Creature.evolveDir` resolves with `{ error, score, time, generation }`
 * after the run terminates (either because `targetError` was reached or
 * the `timeoutMinutes` budget expired). Combined with the seed and final
 * creature's topology (neurons / synapses counts captured by the caller),
 * that is enough to summarise the whole run at a glance.
 *
 * This module renders a deterministic, dependency-free SVG with:
 *
 *   - A "before vs after" topology bar pair (seed vs final, for both
 *     neurons and synapses).
 *   - Numeric callouts for `finalError`, `finalScore`, `generations` and
 *     a human-friendly `wallClockMs` duration.
 *   - An optional caption quoting the configured `targetError` and
 *     `timeoutMinutes` stop conditions.
 *
 * Output is byte-identical for identical inputs — no timestamps, no
 * random IDs, no DOM. Pure string emission, matching the convention of
 * the other helpers in `common/`.
 */

import { escapeAttr, escapeText, fmt, formatScore } from "./svg_text.ts";

/** Statistics captured around a single `Creature.evolveDir` run. */
export interface EvolveDirSummary {
  /** Final error returned by `evolveDir` (the `error` field). */
  finalError: number;
  /** Final score returned by `evolveDir` (the `score` field). */
  finalScore: number;
  /** Wall-clock duration in milliseconds (sourced from the returned `time`). */
  wallClockMs: number;
  /** Generations completed (the returned `generation`). */
  generations: number;
  /** Neuron count of the starting creature, captured before `evolveDir`. */
  seedNeurons: number;
  /** Synapse count of the starting creature, captured before `evolveDir`. */
  seedSynapses: number;
  /** Neuron count of the final creature, read after `evolveDir` resolves. */
  finalNeurons: number;
  /** Synapse count of the final creature, read after `evolveDir` resolves. */
  finalSynapses: number;
  /** Configured target error threshold, if any (caption only). */
  targetError?: number;
  /** Configured timeout in minutes, if any (caption only). */
  timeoutMinutes?: number;
}

/** Options controlling {@link renderEvolveDirSummarySvg}. */
export interface RenderEvolveDirSummaryOptions {
  /** Total SVG width in user units. Default 720. */
  width?: number;
  /** Total SVG height in user units. Default 360. */
  height?: number;
  /** Chart title rendered at the top. Default "evolveDir Run Summary". */
  title?: string;
}

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 360;

/** Plot-area inset from the SVG edges, leaving room for the title and caption. */
const MARGIN = { top: 48, right: 24, bottom: 56, left: 24 } as const;

/** Bar colour for the seed (before) topology. */
const SEED_COLOUR = "#9ecae1";
/** Bar colour for the final (after) topology. */
const FINAL_COLOUR = "#1f77b4";
/** Accent colour for numeric callouts. */
const CALLOUT_COLOUR = "#2ca02c";

/** Numeric fields that must be finite — checked before any rendering. */
const REQUIRED_NUMERIC_FIELDS: ReadonlyArray<keyof EvolveDirSummary> = [
  "finalError",
  "finalScore",
  "wallClockMs",
  "generations",
  "seedNeurons",
  "seedSynapses",
  "finalNeurons",
  "finalSynapses",
];

/** Optional numeric fields — validated only when provided. */
const OPTIONAL_NUMERIC_FIELDS: ReadonlyArray<keyof EvolveDirSummary> = [
  "targetError",
  "timeoutMinutes",
];

/**
 * Render a deterministic SVG summary of an `evolveDir` run.
 *
 * Throws if any required numeric field is non-finite (`NaN` or `±Infinity`),
 * or if an optional field is supplied but non-finite. The error message
 * names the offending field so callers can fix the upstream capture.
 */
export function renderEvolveDirSummarySvg(
  summary: EvolveDirSummary,
  options: RenderEvolveDirSummaryOptions = {},
): string {
  validateSummary(summary);

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? "evolveDir Run Summary";

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  // 55/45 split: topology bars on the left, numeric callouts on the right.
  const topoW = Math.max(160, Math.floor(plotW * 0.55));
  const calloutX = plotX + topoW + 16;
  const calloutW = Math.max(120, plotX + plotW - calloutX);

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="${escapeAttr(title)} summary chart">`,
    `  <title>${escapeText(title)}</title>`,
    `  <rect width="${width}" height="${height}" fill="#fafafa"/>`,
    `  <text x="${fmt(width / 2)}" y="24" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      escapeText(title) +
      `</text>`,
  );

  lines.push(renderTopologyPanel(summary, plotX, plotY, topoW, plotH));
  lines.push(renderCalloutPanel(summary, calloutX, plotY, calloutW, plotH));

  if (summary.targetError !== undefined || summary.timeoutMinutes !== undefined) {
    lines.push(renderCaption(summary, width, height));
  }

  lines.push(`</svg>`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSummary(summary: EvolveDirSummary): void {
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    const value = summary[field] as number;
    if (!Number.isFinite(value)) {
      throw new Error(
        `EvolveDirSummary.${field} must be a finite number, got ${String(value)}`,
      );
    }
  }
  for (const field of OPTIONAL_NUMERIC_FIELDS) {
    const value = summary[field];
    if (value !== undefined && !Number.isFinite(value as number)) {
      throw new Error(
        `EvolveDirSummary.${field} must be a finite number when provided, got ${String(value)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Topology panel — before / after bars for neurons and synapses
// ---------------------------------------------------------------------------

function renderTopologyPanel(
  summary: EvolveDirSummary,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const out: string[] = [];
  out.push(`  <g class="topology" font-family="sans-serif" font-size="11" fill="#333">`);
  out.push(
    `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
      `fill="#ffffff" stroke="#333" stroke-width="1"/>`,
  );

  // Panel heading.
  out.push(
    `    <text x="${fmt(x + 10)}" y="${fmt(y + 16)}" font-weight="bold">topology</text>`,
  );

  // Two groups side by side: neurons (left) and synapses (right). Each
  // group has a seed bar and a final bar with a count label above and a
  // group label below.
  const groupW = w / 2;
  drawTopologyGroup(
    out,
    x,
    y + 24,
    groupW,
    h - 36,
    "neurons",
    summary.seedNeurons,
    summary.finalNeurons,
  );
  drawTopologyGroup(
    out,
    x + groupW,
    y + 24,
    groupW,
    h - 36,
    "synapses",
    summary.seedSynapses,
    summary.finalSynapses,
  );

  out.push(`  </g>`);
  return out.join("\n");
}

function drawTopologyGroup(
  out: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  seed: number,
  final: number,
): void {
  // Reserve a strip at the bottom for labels.
  const labelStripH = 22;
  const barAreaH = Math.max(1, h - labelStripH);
  const ceiling = Math.max(1, seed, final) * 1.1;

  // Two bars: seed (left) and final (right), with padding either side.
  const slotW = w / 2;
  const barW = slotW * 0.5;

  const seedBarH = (seed / ceiling) * barAreaH;
  const seedBarX = x + (slotW - barW) / 2;
  const seedBarY = y + barAreaH - seedBarH;
  out.push(
    `    <rect class="topo-bar topo-bar-seed-${label}" ` +
      `x="${fmt(seedBarX)}" y="${fmt(seedBarY)}" width="${fmt(barW)}" height="${fmt(seedBarH)}" ` +
      `fill="${SEED_COLOUR}"/>`,
  );
  out.push(
    `    <text x="${fmt(seedBarX + barW / 2)}" y="${fmt(seedBarY - 4)}" text-anchor="middle" ` +
      `font-weight="bold">${seed}</text>`,
  );
  out.push(
    `    <text x="${fmt(seedBarX + barW / 2)}" y="${
      fmt(y + barAreaH + 12)
    }" text-anchor="middle">` +
      `seed</text>`,
  );

  const finalBarH = (final / ceiling) * barAreaH;
  const finalBarX = x + slotW + (slotW - barW) / 2;
  const finalBarY = y + barAreaH - finalBarH;
  out.push(
    `    <rect class="topo-bar topo-bar-final-${label}" ` +
      `x="${fmt(finalBarX)}" y="${fmt(finalBarY)}" width="${fmt(barW)}" height="${
        fmt(finalBarH)
      }" ` +
      `fill="${FINAL_COLOUR}"/>`,
  );
  out.push(
    `    <text x="${fmt(finalBarX + barW / 2)}" y="${fmt(finalBarY - 4)}" text-anchor="middle" ` +
      `font-weight="bold">${final}</text>`,
  );
  out.push(
    `    <text x="${fmt(finalBarX + barW / 2)}" y="${
      fmt(y + barAreaH + 12)
    }" text-anchor="middle">` +
      `final</text>`,
  );

  // Group label centred below the pair.
  out.push(
    `    <text x="${fmt(x + w / 2)}" y="${fmt(y + barAreaH + 22)}" text-anchor="middle" ` +
      `font-weight="bold">${escapeText(label)}</text>`,
  );
}

// ---------------------------------------------------------------------------
// Numeric-callout panel — finalError, finalScore, generations, wallClock
// ---------------------------------------------------------------------------

function renderCalloutPanel(
  summary: EvolveDirSummary,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const out: string[] = [];
  out.push(`  <g class="callouts" font-family="sans-serif" font-size="11" fill="#333">`);
  out.push(
    `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
      `fill="#ffffff" stroke="#333" stroke-width="1"/>`,
  );

  out.push(
    `    <text x="${fmt(x + 10)}" y="${fmt(y + 16)}" font-weight="bold">summary</text>`,
  );

  // Four rows of label + value. Spaced evenly across the available
  // height below the heading.
  const headerH = 28;
  const rows: Array<[string, string]> = [
    ["final error", formatScore(summary.finalError)],
    ["final score", formatScore(summary.finalScore)],
    ["generations", String(Math.round(summary.generations))],
    ["wall clock", formatDuration(summary.wallClockMs)],
  ];
  const rowH = Math.max(20, (h - headerH - 8) / rows.length);
  for (let i = 0; i < rows.length; i++) {
    const [label, value] = rows[i];
    const rowY = y + headerH + i * rowH + rowH / 2;
    out.push(
      `    <text class="callout-label" x="${fmt(x + 12)}" y="${fmt(rowY)}" ` +
        `dominant-baseline="middle">${escapeText(label)}</text>`,
    );
    out.push(
      `    <text class="callout-value" x="${fmt(x + w - 12)}" y="${fmt(rowY)}" ` +
        `text-anchor="end" dominant-baseline="middle" font-weight="bold" ` +
        `fill="${CALLOUT_COLOUR}">${escapeText(value)}</text>`,
    );
  }

  out.push(`  </g>`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Caption — stop-condition footer
// ---------------------------------------------------------------------------

function renderCaption(
  summary: EvolveDirSummary,
  width: number,
  height: number,
): string {
  const parts: string[] = [];
  if (summary.targetError !== undefined) {
    parts.push(`target error ${formatScore(summary.targetError)}`);
  }
  if (summary.timeoutMinutes !== undefined) {
    parts.push(`timeout ${summary.timeoutMinutes} min`);
  }
  const text = `stop conditions: ${parts.join(" · ")}`;
  return [
    `  <g class="caption" font-family="sans-serif" font-size="12" fill="#555">`,
    `    <text x="${fmt(width / 2)}" y="${fmt(height - 12)}" text-anchor="middle">` +
    escapeText(text) +
    `</text>`,
    `  </g>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * Format a millisecond duration as a short, human-friendly string:
 *   - < 1 second   → "Xms"
 *   - < 1 minute   → "Xs"
 *   - < 1 hour     → "Xm Ys"
 *   - >= 1 hour    → "Xh Ym"
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
