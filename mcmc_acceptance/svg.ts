/**
 * SVG rendering helpers for the MCMC mutation-acceptance demo.
 *
 * Produces a dual-axis chart:
 *
 * - Left axis (blue): moving-average acceptance rate, with a dashed
 *   horizontal line at the 23.4% optimal target.
 * - Right axis (orange): the temperature schedule on a log scale.
 *
 * The X axis is the proposal index. The two curves share the same
 * horizontal span; the legend identifies each series.
 */
import type { ProposalRecord } from "./mcmc_acceptance.ts";

/** Width (in SVG user units) of the rendered chart. */
export const PLOT_WIDTH = 880;

/** Height (in SVG user units) of the rendered chart. */
export const PLOT_HEIGHT = 440;

/** Inner plot margins. */
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 64;
const MARGIN_LEFT = 70;
const MARGIN_RIGHT = 80;

/** Width of the inner plot area. */
const INNER_WIDTH = PLOT_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
/** Height of the inner plot area. */
const INNER_HEIGHT = PLOT_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

/** CSS class assigned to the 23.4% target reference line. */
export const TARGET_LINE_CLASS = "target-line";

/** Inputs to {@link renderAcceptanceSVG}. */
export interface RenderAcceptanceOptions {
  /** Per-iteration MH proposal records (used for the temperature curve). */
  proposals: readonly ProposalRecord[];
  /** Per-iteration moving-average acceptance rate. */
  movingAcceptance: readonly number[];
  /** Target acceptance rate to draw as a horizontal dashed line. */
  target: number;
}

/**
 * Render an SVG dual-axis chart of acceptance rate (left, blue) and
 * temperature (right, orange) over MH iterations. A horizontal dashed
 * line marks the {@link RenderAcceptanceOptions.target} target.
 */
export function renderAcceptanceSVG(options: RenderAcceptanceOptions): string {
  const { proposals, movingAcceptance, target } = options;
  if (proposals.length === 0) {
    throw new Error("proposals must contain at least one record");
  }
  if (movingAcceptance.length === 0) {
    throw new Error("movingAcceptance must contain at least one value");
  }

  const totalIterations = Math.max(proposals.length, movingAcceptance.length);
  const xScale = (i: number) => MARGIN_LEFT + (i / Math.max(1, totalIterations - 1)) * INNER_WIDTH;

  // Left axis: acceptance rate ∈ [0, 1].
  const yAccept = (rate: number) => {
    const clamped = Math.max(0, Math.min(1, rate));
    return MARGIN_TOP + (1 - clamped) * INNER_HEIGHT;
  };

  // Right axis: temperature on log scale across the observed range.
  const temps = proposals.map((p) => Math.max(p.temperature, 1e-9));
  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const logMin = Math.log(tMin);
  const logMax = Math.log(tMax);
  const logSpan = logMax - logMin || 1;
  const yTemp = (t: number) => {
    const lt = Math.log(Math.max(t, 1e-9));
    const norm = (lt - logMin) / logSpan;
    return MARGIN_TOP + (1 - norm) * INNER_HEIGHT;
  };

  const acceptancePoints = movingAcceptance
    .map((rate, i) => `${xScale(i).toFixed(2)},${yAccept(rate).toFixed(2)}`)
    .join(" ");
  const temperaturePoints = proposals
    .map((p, i) => `${xScale(i).toFixed(2)},${yTemp(p.temperature).toFixed(2)}`)
    .join(" ");

  const targetY = yAccept(target);
  const targetPercent = (target * 100).toFixed(1);

  const tickPercents = [0, 0.234, 0.5, 0.75, 1];
  const leftTicks = tickPercents
    .map((p) => {
      const y = yAccept(p);
      const label = p === 0.234 ? "23.4%" : `${(p * 100).toFixed(0)}%`;
      return [
        `    <line x1="${MARGIN_LEFT.toFixed(2)}" y1="${y.toFixed(2)}" ` +
        `x2="${(MARGIN_LEFT - 5).toFixed(2)}" y2="${y.toFixed(2)}" ` +
        `stroke="#4a90d9" stroke-width="1"/>`,
        `    <text x="${(MARGIN_LEFT - 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" ` +
        `text-anchor="end" font-size="11" fill="#4a90d9">${label}</text>`,
      ].join("\n");
    })
    .join("\n");

  // Right ticks on the temperature axis: min, geometric mean, max.
  const tMid = Math.exp((logMin + logMax) / 2);
  const tempTicks = [tMin, tMid, tMax];
  const rightTicks = tempTicks
    .map((t) => {
      const y = yTemp(t);
      return [
        `    <line x1="${(MARGIN_LEFT + INNER_WIDTH).toFixed(2)}" y1="${y.toFixed(2)}" ` +
        `x2="${(MARGIN_LEFT + INNER_WIDTH + 5).toFixed(2)}" y2="${y.toFixed(2)}" ` +
        `stroke="#e67e22" stroke-width="1"/>`,
        `    <text x="${(MARGIN_LEFT + INNER_WIDTH + 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" ` +
        `text-anchor="start" font-size="11" fill="#e67e22">${formatTemperature(t)}</text>`,
      ].join("\n");
    })
    .join("\n");

  const xTickCount = 5;
  const xTicks: string[] = [];
  for (let i = 0; i < xTickCount; i++) {
    const t = i / (xTickCount - 1);
    const iter = Math.round(t * (totalIterations - 1));
    const x = xScale(iter);
    xTicks.push(
      `    <line x1="${x.toFixed(2)}" y1="${(MARGIN_TOP + INNER_HEIGHT).toFixed(2)}" ` +
        `x2="${x.toFixed(2)}" y2="${(MARGIN_TOP + INNER_HEIGHT + 5).toFixed(2)}" ` +
        `stroke="#333" stroke-width="1"/>`,
    );
    xTicks.push(
      `    <text x="${x.toFixed(2)}" y="${(MARGIN_TOP + INNER_HEIGHT + 20).toFixed(2)}" ` +
        `text-anchor="middle" font-size="11" fill="#333">${iter}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="MCMC acceptance rate cooling toward 23.4% target">`,
    `  <title>MCMC Mutation Acceptance — Cooling Toward 23.4%</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="28" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
    `MCMC Mutation Acceptance — Cooling Toward 23.4%</text>`,
    `  <g class="plot-frame" font-family="sans-serif">`,
    `    <rect x="${MARGIN_LEFT}" y="${MARGIN_TOP}" width="${INNER_WIDTH}" ` +
    `height="${INNER_HEIGHT}" fill="#ffffff" stroke="#333" stroke-width="1"/>`,
    `  </g>`,
    `  <g class="ticks-left" font-family="sans-serif">`,
    leftTicks,
    `  </g>`,
    `  <g class="ticks-right" font-family="sans-serif">`,
    rightTicks,
    `  </g>`,
    `  <g class="ticks-x" font-family="sans-serif">`,
    xTicks.join("\n"),
    `  </g>`,
    `  <line class="${TARGET_LINE_CLASS}" x1="${MARGIN_LEFT.toFixed(2)}" ` +
    `y1="${targetY.toFixed(2)}" x2="${(MARGIN_LEFT + INNER_WIDTH).toFixed(2)}" ` +
    `y2="${targetY.toFixed(2)}" stroke="#16a085" stroke-width="1.5" ` +
    `stroke-dasharray="6 4"/>`,
    `  <text x="${(MARGIN_LEFT + INNER_WIDTH - 6).toFixed(2)}" ` +
    `y="${(targetY - 6).toFixed(2)}" text-anchor="end" font-size="11" ` +
    `font-family="sans-serif" fill="#16a085">target = ${targetPercent}%</text>`,
    `  <polyline class="temperature" fill="none" stroke="#e67e22" stroke-width="1.4" ` +
    `points="${temperaturePoints}"/>`,
    `  <polyline class="acceptance" fill="none" stroke="#4a90d9" stroke-width="2" ` +
    `points="${acceptancePoints}"/>`,
    renderAxisLabels(),
    renderLegend(),
    `</svg>`,
    "",
  ].join("\n");
}

function renderAxisLabels(): string {
  const baseY = MARGIN_TOP + INNER_HEIGHT;
  const xMid = MARGIN_LEFT + INNER_WIDTH / 2;
  return [
    `  <g class="axis-labels" font-family="sans-serif" font-size="12" fill="#333">`,
    `    <text x="${xMid}" y="${baseY + 44}" text-anchor="middle">proposal iteration</text>`,
    `    <text x="${MARGIN_LEFT - 44}" y="${MARGIN_TOP + INNER_HEIGHT / 2}" ` +
    `text-anchor="middle" dominant-baseline="middle" fill="#4a90d9" ` +
    `transform="rotate(-90 ${MARGIN_LEFT - 44} ${MARGIN_TOP + INNER_HEIGHT / 2})">` +
    `moving-average acceptance rate</text>`,
    `    <text x="${MARGIN_LEFT + INNER_WIDTH + 52}" y="${MARGIN_TOP + INNER_HEIGHT / 2}" ` +
    `text-anchor="middle" dominant-baseline="middle" fill="#e67e22" ` +
    `transform="rotate(90 ${MARGIN_LEFT + INNER_WIDTH + 52} ${MARGIN_TOP + INNER_HEIGHT / 2})">` +
    `temperature (log scale)</text>`,
    `  </g>`,
  ].join("\n");
}

function renderLegend(): string {
  const x = MARGIN_LEFT + 12;
  const y = MARGIN_TOP + 12;
  return [
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#333">`,
    `    <rect x="${x - 6}" y="${y - 12}" width="240" height="60" ` +
    `fill="#ffffff" fill-opacity="0.9" stroke="#cccccc" stroke-width="0.5"/>`,
    `    <line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" stroke="#4a90d9" stroke-width="2"/>`,
    `    <text x="${x + 28}" y="${y + 4}">acceptance rate (left)</text>`,
    `    <line x1="${x}" y1="${y + 16}" x2="${x + 22}" y2="${y + 16}" ` +
    `stroke="#e67e22" stroke-width="1.4"/>`,
    `    <text x="${x + 28}" y="${y + 20}">temperature (right)</text>`,
    `    <line x1="${x}" y1="${y + 32}" x2="${x + 22}" y2="${y + 32}" ` +
    `stroke="#16a085" stroke-width="1.5" stroke-dasharray="6 4"/>`,
    `    <text x="${x + 28}" y="${y + 36}">23.4% target</text>`,
    `  </g>`,
  ].join("\n");
}

function formatTemperature(t: number): string {
  if (t === 0) return "0";
  const abs = Math.abs(t);
  if (abs >= 0.01 && abs < 1000) return t.toFixed(3);
  return t.toExponential(1);
}
