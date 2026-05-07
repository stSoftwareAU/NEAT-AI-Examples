/**
 * SVG rendering helpers for the XOR classification example.
 *
 * Produces a single SVG showing the network's decision boundary over
 * the input square `[0,1] × [0,1]`. Each grid cell is shaded
 * according to the network's scalar output: blue for low values
 * (class 0), red for high values (class 1). The four XOR samples are
 * overlaid as labelled circles, and a small legend describes the
 * colour ramp.
 */
import type { Creature } from "@stsoftware/neat-ai";

import { predict, type XorSample } from "./xor_classification.ts";

/** Width (in SVG user units) of the rendered decision-boundary plot. */
export const PLOT_WIDTH = 480;

/** Height (in SVG user units) of the rendered decision-boundary plot. */
export const PLOT_HEIGHT = 480;

/** Width of the grid area inside the plot. */
const GRID_WIDTH = 360;

/** Height of the grid area inside the plot. */
const GRID_HEIGHT = 360;

/** Top-left x coordinate of the grid area. */
const GRID_X = 70;

/** Top-left y coordinate of the grid area. */
const GRID_Y = 50;

/** Total animation duration (seconds) for one full marker pulse cycle. */
export const ANIMATION_DURATION_SECONDS = 4;

/** Options controlling the decision-boundary render. */
export interface RenderOptions {
  /** Number of cells per side. Higher = smoother boundary, slower. */
  gridResolution: number;
  /** XOR samples to plot on top of the grid. */
  samples: readonly XorSample[];
}

/**
 * Render an SVG showing the decision boundary of `creature` over the
 * unit square. Cells are coloured by the network's scalar output;
 * the four XOR samples are overlaid as labelled markers.
 */
export function renderDecisionBoundarySVG(
  creature: Creature,
  options: RenderOptions,
): string {
  const { gridResolution, samples } = options;
  if (gridResolution < 2) {
    throw new Error(`gridResolution must be at least 2, got ${gridResolution}`);
  }

  const cellWidth = GRID_WIDTH / gridResolution;
  const cellHeight = GRID_HEIGHT / gridResolution;

  const cells: string[] = [];
  for (let row = 0; row < gridResolution; row++) {
    for (let col = 0; col < gridResolution; col++) {
      // Map cell centre back to the input space [0, 1] × [0, 1].
      const a = (col + 0.5) / gridResolution;
      const b = 1 - (row + 0.5) / gridResolution; // y-axis flipped for SVG.
      const out = predict(creature, [a, b]);
      const cellX = GRID_X + col * cellWidth;
      const cellY = GRID_Y + row * cellHeight;
      cells.push(
        `    <rect x="${cellX.toFixed(2)}" y="${cellY.toFixed(2)}" ` +
          `width="${(cellWidth + 0.5).toFixed(2)}" height="${(cellHeight + 0.5).toFixed(2)}" ` +
          `fill="${shadeColour(out)}"/>`,
      );
    }
  }

  const markers = samples.map((sample, i) => renderSampleMarker(sample, i)).join("\n");
  const legend = renderLegend();

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="XOR decision boundary with four samples">`,
    `  <title>XOR Decision Boundary</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="28" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
    `XOR Decision Boundary</text>`,
    `  <g class="grid">`,
    cells.join("\n"),
    `  </g>`,
    `  <rect x="${GRID_X}" y="${GRID_Y}" width="${GRID_WIDTH}" height="${GRID_HEIGHT}" ` +
    `fill="none" stroke="#333333" stroke-width="1.5"/>`,
    renderAxes(),
    `  <g class="samples">`,
    markers,
    `  </g>`,
    legend,
    `</svg>`,
    "",
  ].join("\n");
}

/**
 * Map a network output in `[0, 1]` to a hex colour on a blue→white→red
 * ramp. Out-of-range values are clamped.
 */
export function shadeColour(value: number): string {
  const v = Math.max(0, Math.min(1, value));
  // Blend between #4a90d9 (blue, class 0) and #e74c3c (red, class 1)
  // through #f7f7f7 (near-white) at 0.5 to leave the boundary visible.
  const blue = { r: 0x4a, g: 0x90, b: 0xd9 };
  const white = { r: 0xf7, g: 0xf7, b: 0xf7 };
  const red = { r: 0xe7, g: 0x4c, b: 0x3c };
  let r: number;
  let g: number;
  let b: number;
  if (v < 0.5) {
    const t = v / 0.5;
    r = Math.round(blue.r + (white.r - blue.r) * t);
    g = Math.round(blue.g + (white.g - blue.g) * t);
    b = Math.round(blue.b + (white.b - blue.b) * t);
  } else {
    const t = (v - 0.5) / 0.5;
    r = Math.round(white.r + (red.r - white.r) * t);
    g = Math.round(white.g + (red.g - white.g) * t);
    b = Math.round(white.b + (red.b - white.b) * t);
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** Render a labelled circle for a single XOR sample. */
function renderSampleMarker(sample: XorSample, index: number): string {
  const cx = GRID_X + sample.inputs[0] * GRID_WIDTH;
  const cy = GRID_Y + (1 - sample.inputs[1]) * GRID_HEIGHT;
  const fill = sample.target === 1 ? "#e74c3c" : "#4a90d9";
  const stroke = "#222222";
  const labelX = cx + 12;
  const labelY = cy - 10;
  // Stagger each marker's pulse so the four samples ripple in turn,
  // making it obvious that the boundary separates the highlighted XOR
  // truth-table corners.
  const animDur = `${ANIMATION_DURATION_SECONDS}s`;
  const beginOffset = (index * ANIMATION_DURATION_SECONDS) / 4;
  const beginAttr = `${beginOffset.toFixed(3)}s`;
  return [
    `    <g class="sample" data-index="${index}" data-target="${sample.target}">`,
    // Outer pulse ring — fades out and grows to draw attention to each
    // labelled XOR truth-table point in sequence.
    `      <circle class="pulse" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="8" ` +
    `fill="none" stroke="${fill}" stroke-width="2" opacity="0">`,
    `        <animate attributeName="r" values="8;22" dur="${animDur}" ` +
    `begin="${beginAttr}" repeatCount="indefinite"/>`,
    `        <animate attributeName="opacity" values="0.85;0" dur="${animDur}" ` +
    `begin="${beginAttr}" repeatCount="indefinite"/>`,
    `      </circle>`,
    `      <circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="8" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="2">`,
    `        <animate attributeName="r" values="8;10;8" dur="${animDur}" ` +
    `begin="${beginAttr}" repeatCount="indefinite"/>`,
    `      </circle>`,
    `      <text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" ` +
    `font-family="monospace" font-size="12" fill="#222222">` +
    `(${sample.inputs[0]},${sample.inputs[1]})→${sample.target}</text>`,
    `    </g>`,
  ].join("\n");
}

/** Render the axis labels and tick marks. */
function renderAxes(): string {
  const baseY = GRID_Y + GRID_HEIGHT;
  return [
    `  <g class="axes" font-family="sans-serif" font-size="11" fill="#333333">`,
    `    <text x="${GRID_X}" y="${baseY + 18}" text-anchor="middle">0</text>`,
    `    <text x="${GRID_X + GRID_WIDTH}" y="${baseY + 18}" text-anchor="middle">1</text>`,
    `    <text x="${GRID_X + GRID_WIDTH / 2}" y="${baseY + 36}" text-anchor="middle">` +
    `input a</text>`,
    `    <text x="${GRID_X - 12}" y="${baseY}" text-anchor="end" dominant-baseline="middle">` +
    `0</text>`,
    `    <text x="${GRID_X - 12}" y="${GRID_Y}" text-anchor="end" dominant-baseline="middle">` +
    `1</text>`,
    `    <text x="${GRID_X - 36}" y="${GRID_Y + GRID_HEIGHT / 2}" ` +
    `text-anchor="middle" dominant-baseline="middle" ` +
    `transform="rotate(-90 ${GRID_X - 36} ${GRID_Y + GRID_HEIGHT / 2})">input b</text>`,
    `  </g>`,
  ].join("\n");
}

/** Render the legend showing the colour ramp. */
function renderLegend(): string {
  const legendX = GRID_X;
  const legendY = GRID_Y + GRID_HEIGHT + 50;
  const legendWidth = 200;
  const legendHeight = 12;
  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    stops.push(`<stop offset="${(t * 100).toFixed(0)}%" stop-color="${shadeColour(t)}"/>`);
  }
  return [
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#333333">`,
    `    <defs>`,
    `      <linearGradient id="xor-legend" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `        ${stops.join("\n        ")}`,
    `      </linearGradient>`,
    `    </defs>`,
    `    <rect x="${legendX}" y="${legendY}" width="${legendWidth}" height="${legendHeight}" ` +
    `fill="url(#xor-legend)" stroke="#333333" stroke-width="0.5"/>`,
    `    <text x="${legendX}" y="${legendY + legendHeight + 14}" text-anchor="start">` +
    `0 (class 0)</text>`,
    `    <text x="${legendX + legendWidth}" y="${legendY + legendHeight + 14}" ` +
    `text-anchor="end">1 (class 1)</text>`,
    `    <text x="${legendX + legendWidth + 24}" y="${legendY + legendHeight - 2}" ` +
    `text-anchor="start">network output</text>`,
    `  </g>`,
  ].join("\n");
}
