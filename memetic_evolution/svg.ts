/**
 * SVG rendering helpers for the memetic evolution demo (rewired under
 * issue #303 to render from two {@link EvolveDirSummary} records).
 *
 * The headline chart is a milestone comparison panel: two
 * `EvolveDirSummary` columns side by side (memetic vs control), each
 * with a seeding-event annotation strip across the top so the reader
 * can still see *when* the memetic algorithm re-seeded its population
 * without a per-generation curve. Numeric callouts compare final
 * score, final error, generations and topology counts.
 */
import type { EvolveDirSummary } from "../common/evolve_dir_summary.ts";

/** Width (in SVG user units) of the rendered chart. */
export const PLOT_WIDTH = 880;

/** Height (in SVG user units) of the rendered chart. */
export const PLOT_HEIGHT = 440;

/** CSS class assigned to the milestone-comparison panel group. */
export const MILESTONE_PANEL_CLASS = "memetic-milestone-panel";

/** CSS class assigned to the memetic column (the "with seeding" run). */
export const MEMETIC_COLUMN_CLASS = "memetic-column";

/** CSS class assigned to the control column (the "no seeding" run). */
export const CONTROL_COLUMN_CLASS = "control-column";

/** CSS class assigned to the seeding-event annotation strip. */
export const SEEDING_ANNOTATION_CLASS = "seeding-annotation";

const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 32;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 44;

/** Inputs to {@link renderMemeticSVG}. */
export interface RenderMemeticOptions {
  /** Milestone summary from the memetic (with-seeding) `evolveDir` run. */
  memetic: EvolveDirSummary;
  /** Milestone summary from the control (no-seeding) `evolveDir` run. */
  control: EvolveDirSummary;
  /**
   * Human-readable description of the seeding event the memetic column
   * received (e.g. `"archive seed @ gen 30"`). Rendered as a small
   * annotation strip across the top of the memetic column so the
   * seeding narrative remains visible without a per-generation curve.
   */
  memeticSeedingEvent: string;
  /**
   * Optional human-readable description of the control column's
   * (non-)seeding event — defaults to `"no seeding (control)"`. Kept
   * separate so the reader can see the deliberate contrast.
   */
  controlSeedingEvent?: string;
}

/**
 * Render the memetic-vs-control milestone comparison as an SVG string.
 *
 * The "fitness lift" narrative is driven by the deltas between the
 * supplied memetic and control summaries — no per-generation rows are
 * required.
 */
export function renderMemeticSVG(options: RenderMemeticOptions): string {
  const { memetic, control, memeticSeedingEvent } = options;
  const controlSeedingEvent = options.controlSeedingEvent ?? "no seeding (control)";

  const panelTop = MARGIN_TOP;
  const panelHeight = PLOT_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const innerWidth = PLOT_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const colW = (innerWidth - 20) / 2;
  const memeticX = MARGIN_LEFT;
  const controlX = MARGIN_LEFT + colW + 20;

  const lift = memetic.finalScore - control.finalScore;
  const liftColour = lift >= 0 ? "#27ae60" : "#e74c3c";
  const liftSign = lift >= 0 ? "+" : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="Memetic vs control milestone summary">`,
    `  <title>Memetic Evolution — Seeding From the Fittest Archive</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="28" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
    `Memetic Evolution — Seeding From the Fittest Archive</text>`,
    `  <g class="${MILESTONE_PANEL_CLASS}" font-family="sans-serif">`,
    `    <text x="${MARGIN_LEFT}" y="${(panelTop - 8).toFixed(2)}" font-size="13" ` +
    `font-weight="bold" fill="#222">Memetic (with seeding) vs control (no seeding)</text>`,
    renderColumn(
      memeticX,
      panelTop,
      colW,
      panelHeight,
      "memetic (with seeding)",
      memetic,
      "#1f77b4",
      memeticSeedingEvent,
      MEMETIC_COLUMN_CLASS,
    ),
    renderColumn(
      controlX,
      panelTop,
      colW,
      panelHeight,
      "control (no seeding)",
      control,
      "#7f8c8d",
      controlSeedingEvent,
      CONTROL_COLUMN_CLASS,
    ),
    // Lift callout between the two columns.
    `    <text x="${(MARGIN_LEFT + colW + 10).toFixed(2)}" y="${
      (panelTop + panelHeight / 2 - 8).toFixed(2)
    }" text-anchor="middle" font-size="10" fill="#555">fitness lift</text>`,
    `    <text x="${(MARGIN_LEFT + colW + 10).toFixed(2)}" y="${
      (panelTop + panelHeight / 2 + 10).toFixed(2)
    }" text-anchor="middle" font-size="14" font-weight="bold" fill="${liftColour}">` +
    `${liftSign}${formatScore(lift)}</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

function renderColumn(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  summary: EvolveDirSummary,
  accent: string,
  seedingEvent: string,
  columnClass: string,
): string {
  const headerH = 28;
  const annotationH = 28;
  const annotationY = y + headerH;
  const rowsY = annotationY + annotationH;
  const rowsHeight = h - headerH - annotationH - 8;
  const rows: Array<[string, string]> = [
    ["final score", formatScore(summary.finalScore)],
    ["final error", formatScore(summary.finalError)],
    ["generations", String(Math.round(summary.generations))],
    ["seed → final neurons", `${summary.seedNeurons} → ${summary.finalNeurons}`],
    ["seed → final synapses", `${summary.seedSynapses} → ${summary.finalSynapses}`],
    ["wall clock", formatDuration(summary.wallClockMs)],
  ];
  const rowH = Math.max(18, rowsHeight / rows.length);

  const out: string[] = [];
  out.push(`    <g class="${columnClass}">`);
  // Column frame + header bar.
  out.push(
    `      <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" ` +
      `height="${h.toFixed(2)}" fill="#ffffff" stroke="#333" stroke-width="1"/>`,
    `      <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" ` +
      `height="${headerH.toFixed(2)}" fill="${accent}"/>`,
    `      <text x="${(x + w / 2).toFixed(2)}" y="${
      (y + 18).toFixed(2)
    }" text-anchor="middle" font-size="12" font-weight="bold" fill="#ffffff">` +
      `${escapeXml(label)}</text>`,
  );
  // Seeding-event annotation strip.
  out.push(
    `      <rect class="${SEEDING_ANNOTATION_CLASS}" x="${x.toFixed(2)}" y="${
      annotationY.toFixed(2)
    }" width="${w.toFixed(2)}" height="${annotationH.toFixed(2)}" fill="#f4f6f8" ` +
      `stroke="#ddd" stroke-width="0.5"/>`,
    `      <text x="${(x + w / 2).toFixed(2)}" y="${
      (annotationY + 18).toFixed(2)
    }" text-anchor="middle" font-size="11" fill="#444" font-style="italic">` +
      `${escapeXml(seedingEvent)}</text>`,
  );
  // Numeric callouts.
  for (let i = 0; i < rows.length; i++) {
    const [k, v] = rows[i];
    const rowY = rowsY + i * rowH + rowH / 2;
    out.push(
      `      <text x="${(x + 10).toFixed(2)}" y="${rowY.toFixed(2)}" ` +
        `dominant-baseline="middle" font-size="11" fill="#333">${escapeXml(k)}</text>`,
      `      <text x="${(x + w - 10).toFixed(2)}" y="${rowY.toFixed(2)}" text-anchor="end" ` +
        `dominant-baseline="middle" font-size="11" font-weight="bold" ` +
        `fill="#222">${escapeXml(v)}</text>`,
    );
  }
  out.push(`    </g>`);
  return out.join("\n");
}

function formatScore(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
}

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

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
