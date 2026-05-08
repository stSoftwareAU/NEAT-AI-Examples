/**
 * SVG rendering helpers for the adaptive mutation rate demo.
 *
 * Produces a two-panel line chart:
 *
 * - **Left panel** — small-creature run. Topology share starts high
 *   and stays high; weight share is its mirror image.
 * - **Right panel** — large-creature run. Topology share collapses
 *   toward zero almost immediately; weight share dominates.
 *
 * Both panels share a `[0, 1]` Y axis (rate) and a `[0, generations]`
 * X axis so the eye can compare the two curves directly.
 */
import type { RunResult } from "./adaptive_mutation.ts";

/** Width (in SVG user units) of the rendered chart. */
export const PLOT_WIDTH = 960;

/** Height (in SVG user units) of the rendered chart. */
export const PLOT_HEIGHT = 460;

/** CSS class assigned to each topology rate polyline. */
export const TOPOLOGY_CURVE_CLASS = "topology-rate";

/** CSS class assigned to each weight rate polyline. */
export const WEIGHT_CURVE_CLASS = "weight-rate";

/** CSS class assigned to the panel container groups. */
export const PANEL_CLASS = "panel";

const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;
const MARGIN_OUTER = 56;
const PANEL_GAP = 36;

/** Inputs to {@link renderAdaptiveMutationSVG}. */
export interface RenderAdaptiveMutationOptions {
  /** Small-creature run result. */
  small: RunResult;
  /** Large-creature run result. */
  large: RunResult;
}

/**
 * Render the two-panel mutation-rate comparison as an SVG string.
 * Both panels share the same Y range (rate ∈ [0, 1]) and X range
 * (generation ∈ [0, generations - 1]) so the curves are directly
 * comparable.
 */
export function renderAdaptiveMutationSVG(options: RenderAdaptiveMutationOptions): string {
  const { small, large } = options;
  if (small.records.length === 0 || large.records.length === 0) {
    throw new Error("small and large records must be non-empty");
  }
  if (small.records.length !== large.records.length) {
    throw new Error(
      `small (${small.records.length}) and large (${large.records.length}) must have equal length`,
    );
  }

  const totalGenerations = small.records.length;
  const innerWidth = PLOT_WIDTH - MARGIN_OUTER * 2 - PANEL_GAP;
  const panelWidth = innerWidth / 2;
  const panelHeight = PLOT_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

  const leftPanel = renderPanel({
    x: MARGIN_OUTER,
    y: MARGIN_TOP,
    width: panelWidth,
    height: panelHeight,
    title: "Small creature",
    subtitle: small.label,
    initialSize: `start: ${small.initialSize.hidden} hidden / ${small.initialSize.synapses} syn`,
    finalSize: `end:   ${small.finalMeanSize.hidden.toFixed(0)} hidden / ` +
      `${small.finalMeanSize.synapses.toFixed(0)} syn`,
    run: small,
    totalGenerations,
  });

  const rightPanel = renderPanel({
    x: MARGIN_OUTER + panelWidth + PANEL_GAP,
    y: MARGIN_TOP,
    width: panelWidth,
    height: panelHeight,
    title: "Large creature",
    subtitle: large.label,
    initialSize: `start: ${large.initialSize.hidden} hidden / ${large.initialSize.synapses} syn`,
    finalSize: `end:   ${large.finalMeanSize.hidden.toFixed(0)} hidden / ` +
      `${large.finalMeanSize.synapses.toFixed(0)} syn`,
    run: large,
    totalGenerations,
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="Adaptive mutation rate — small vs large creature">`,
    `  <title>Adaptive Mutation Rate — Topology Share Drops as Creatures Grow</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="28" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
    `Adaptive Mutation Rate — Topology vs Weight Share</text>`,
    leftPanel,
    rightPanel,
    renderLegend(),
    `</svg>`,
    "",
  ].join("\n");
}

interface PanelOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  subtitle: string;
  initialSize: string;
  finalSize: string;
  run: RunResult;
  totalGenerations: number;
}

function renderPanel(opts: PanelOptions): string {
  const { x, y, width, height, title, subtitle, initialSize, finalSize, run } = opts;

  const xScale = (gen: number) => x + (gen / Math.max(1, opts.totalGenerations - 1)) * width;
  const yScale = (rate: number) => y + (1 - rate) * height;

  const topologyPoints = run.records
    .map((r) => `${xScale(r.generation).toFixed(2)},${yScale(r.topologyRate).toFixed(2)}`)
    .join(" ");
  const weightPoints = run.records
    .map((r) => `${xScale(r.generation).toFixed(2)},${yScale(r.weightRate).toFixed(2)}`)
    .join(" ");

  const lines: string[] = [];
  lines.push(`  <g class="${PANEL_CLASS}" font-family="sans-serif">`);
  lines.push(
    `    <text x="${(x + width / 2).toFixed(2)}" y="${(y - 22).toFixed(2)}" ` +
      `text-anchor="middle" font-size="14" font-weight="bold" fill="#222">${title}</text>`,
  );
  lines.push(
    `    <text x="${(x + width / 2).toFixed(2)}" y="${(y - 6).toFixed(2)}" ` +
      `text-anchor="middle" font-size="11" fill="#555">${subtitle}</text>`,
  );
  lines.push(
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" ` +
      `height="${height.toFixed(2)}" fill="#ffffff" stroke="#333" stroke-width="1"/>`,
  );
  lines.push(renderYTicks(x, y, height));
  lines.push(renderXTicks(x, y, width, height, opts.totalGenerations, xScale));
  lines.push(
    `    <polyline class="${WEIGHT_CURVE_CLASS}" fill="none" stroke="#2e86de" ` +
      `stroke-width="2" points="${weightPoints}"/>`,
  );
  lines.push(
    `    <polyline class="${TOPOLOGY_CURVE_CLASS}" fill="none" stroke="#e67e22" ` +
      `stroke-width="2" points="${topologyPoints}"/>`,
  );
  lines.push(renderAxisLabels(x, y, width, height));
  lines.push(
    `    <text x="${(x + 8).toFixed(2)}" y="${(y + height - 30).toFixed(2)}" ` +
      `font-size="10" fill="#666">${escapeXml(initialSize)}</text>`,
  );
  lines.push(
    `    <text x="${(x + 8).toFixed(2)}" y="${(y + height - 16).toFixed(2)}" ` +
      `font-size="10" fill="#666">${escapeXml(finalSize)}</text>`,
  );
  lines.push(`  </g>`);
  return lines.join("\n");
}

function renderYTicks(panelX: number, panelY: number, panelHeight: number): string {
  const ticks = 5;
  const lines: string[] = [`    <g class="ticks-y">`];
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const value = t;
    const yPos = panelY + (1 - t) * panelHeight;
    lines.push(
      `      <line x1="${panelX.toFixed(2)}" y1="${yPos.toFixed(2)}" ` +
        `x2="${(panelX - 5).toFixed(2)}" y2="${yPos.toFixed(2)}" ` +
        `stroke="#333" stroke-width="1"/>`,
    );
    lines.push(
      `      <text x="${(panelX - 8).toFixed(2)}" y="${(yPos + 4).toFixed(2)}" ` +
        `text-anchor="end" font-size="11" fill="#333">${value.toFixed(2)}</text>`,
    );
  }
  lines.push(`    </g>`);
  return lines.join("\n");
}

function renderXTicks(
  _panelX: number,
  panelY: number,
  _panelWidth: number,
  panelHeight: number,
  totalGenerations: number,
  xScale: (gen: number) => number,
): string {
  const ticks = 5;
  const lines: string[] = [`    <g class="ticks-x">`];
  const baseY = panelY + panelHeight;
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const gen = Math.round(t * (totalGenerations - 1));
    const xPos = xScale(gen);
    lines.push(
      `      <line x1="${xPos.toFixed(2)}" y1="${baseY.toFixed(2)}" ` +
        `x2="${xPos.toFixed(2)}" y2="${(baseY + 5).toFixed(2)}" ` +
        `stroke="#333" stroke-width="1"/>`,
    );
    lines.push(
      `      <text x="${xPos.toFixed(2)}" y="${(baseY + 18).toFixed(2)}" ` +
        `text-anchor="middle" font-size="11" fill="#333">${gen}</text>`,
    );
  }
  lines.push(`    </g>`);
  return lines.join("\n");
}

function renderAxisLabels(
  panelX: number,
  panelY: number,
  panelWidth: number,
  panelHeight: number,
): string {
  const baseY = panelY + panelHeight;
  const xMid = panelX + panelWidth / 2;
  return [
    `    <g class="axis-labels" font-size="11" fill="#333">`,
    `      <text x="${xMid.toFixed(2)}" y="${(baseY + 36).toFixed(2)}" ` +
    `text-anchor="middle">generation</text>`,
    `      <text x="${(panelX - 36).toFixed(2)}" y="${(panelY + panelHeight / 2).toFixed(2)}" ` +
    `text-anchor="middle" dominant-baseline="middle" ` +
    `transform="rotate(-90 ${(panelX - 36).toFixed(2)} ` +
    `${(panelY + panelHeight / 2).toFixed(2)})">mutation share</text>`,
    `    </g>`,
  ].join("\n");
}

function renderLegend(): string {
  const x = PLOT_WIDTH / 2 - 200;
  const y = PLOT_HEIGHT - 28;
  return [
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#333">`,
    `    <line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" ` +
    `stroke="#e67e22" stroke-width="2"/>`,
    `    <text x="${x + 28}" y="${y + 4}">topology mutations (add/remove neuron/synapse)</text>`,
    `    <line x1="${x + 280}" y1="${y}" x2="${x + 302}" y2="${y}" ` +
    `stroke="#2e86de" stroke-width="2"/>`,
    `    <text x="${x + 308}" y="${y + 4}">weight/bias mutations</text>`,
    `  </g>`,
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
