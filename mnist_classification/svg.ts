/**
 * Animated grid SVG renderer for the MNIST classification example.
 *
 * Lays out a `GRID_ROWS × GRID_COLS` grid of digit "cells". Each cell
 * pre-renders several digits as `<g>` groups stacked on top of each
 * other, and a SMIL `<animate>` with `calcMode="discrete"` switches
 * which group is visible — so during a single 9-second loop every
 * cell pulses through several test samples without needing JavaScript
 * or external images.
 *
 * Each digit pixel is emitted as a tiny `<rect>` so the SVG renders
 * everywhere (Markdown, GitHub Pages, raw `img` tags) and stays
 * digest-stable. Black background pixels are skipped to keep the
 * file size manageable.
 *
 * The predicted-vs-actual label sits below each cell in green when
 * the prediction is correct and red when it is wrong, so the chart
 * doubles as a confusion-matrix style visualisation.
 */

/** Number of cell columns in the rendered grid. */
export const GRID_COLS = 5;

/** Number of cell rows in the rendered grid. */
export const GRID_ROWS = 4;

/** Total animation duration (seconds) for one full sweep across all frames. */
export const ANIMATION_DURATION_SECONDS = 9;

/** Native side length of an MNIST image (pixels). */
export const SOURCE_IMAGE_SIZE = 28;

/** SVG units per source pixel — keeps each digit at 84×84 SVG units. */
const PIXEL_SCALE = 3;

/** SVG units occupied by each cell's image area. */
const CELL_IMAGE_SIZE = SOURCE_IMAGE_SIZE * PIXEL_SCALE;

/** Vertical space (SVG units) reserved for the "T:x P:y" label below each cell. */
const CELL_LABEL_HEIGHT = 26;

/** Padding (SVG units) between adjacent cells. */
const CELL_PADDING = 14;

/** Outer padding (SVG units) around the whole grid. */
const OUTER_MARGIN = 28;

/** Height (SVG units) of the caption below the grid. */
const CAPTION_HEIGHT = 60;

/** Total SVG width derived from the grid layout. */
export const SVG_WIDTH = OUTER_MARGIN * 2 +
  GRID_COLS * CELL_IMAGE_SIZE +
  (GRID_COLS - 1) * CELL_PADDING;

/** Total SVG height derived from the grid layout. */
export const SVG_HEIGHT = OUTER_MARGIN * 2 +
  GRID_ROWS * (CELL_IMAGE_SIZE + CELL_LABEL_HEIGHT) +
  (GRID_ROWS - 1) * CELL_PADDING +
  CAPTION_HEIGHT;

/** A single frame within a cell — one digit + its prediction. */
export interface CellFrame {
  /**
   * Raw 28×28 pixels in row-major order, values in `0..255`. Pixels
   * with a value at or below {@link DigitGridOptions.pixelThreshold}
   * are not emitted, keeping the output tractable.
   */
  pixels: ArrayLike<number>;
  /** Ground-truth class label (0..9). */
  label: number;
  /** Network's argmax prediction (0..9). */
  prediction: number;
}

/** A grid cell — several frames that crossfade via SMIL opacity. */
export interface DigitCell {
  frames: CellFrame[];
}

/** Options for {@link renderDigitGridSVG}. */
export interface DigitGridOptions {
  /**
   * Cells in reading order (row-major). May be shorter than
   * `GRID_ROWS * GRID_COLS` — empty positions stay blank but the SVG
   * still renders.
   */
  cells: DigitCell[];
  /** Test-set accuracy used in the caption. */
  accuracy: number;
  /** Held-out validation accuracy used in the caption. */
  validationAccuracy: number;
  /** Pixel-value threshold below which pixels are not emitted. Default 24. */
  pixelThreshold?: number;
  /** Override the source-image side length (default {@link SOURCE_IMAGE_SIZE}). */
  imageSize?: number;
}

/** Right-pads `n` to two decimals to keep SVG output stable. */
function fmt(n: number): string {
  return n.toFixed(2);
}

/** Minimal XML escaping for text nodes and attribute values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the SMIL `values` / `keyTimes` pair for a discrete
 * opacity animation that makes frame `i` of `K` total visible during
 * the interval `[i/K, (i+1)/K]` of the cycle.
 *
 * For `K = 1` no animation is needed — return null.
 */
function frameAnimation(
  i: number,
  K: number,
): { values: string; keyTimes: string } | null {
  if (K <= 1) return null;
  const values: string[] = [];
  const keyTimes: string[] = [];
  for (let j = 0; j < K; j++) {
    keyTimes.push((j / K).toFixed(4));
    values.push(j === i ? "1" : "0");
  }
  return { values: values.join(";"), keyTimes: keyTimes.join(";") };
}

/**
 * Render one frame's pixel grid as a sequence of small `<rect>`
 * elements. Background pixels (`<= pixelThreshold`) are skipped to
 * keep the file size manageable.
 */
function renderPixels(
  pixels: ArrayLike<number>,
  imageSize: number,
  threshold: number,
  originX: number,
  originY: number,
): string[] {
  if (pixels.length !== imageSize * imageSize) {
    throw new Error(
      `renderPixels: expected ${imageSize * imageSize} pixels, got ${pixels.length}`,
    );
  }
  const out: string[] = [];
  for (let y = 0; y < imageSize; y++) {
    for (let x = 0; x < imageSize; x++) {
      const v = pixels[y * imageSize + x];
      if (v <= threshold) continue;
      // Map 0..255 -> a high-contrast viridis-ish ramp:
      //   low intensity → indigo, mid → teal, high → yellow.
      // Keeps the visual "fun and colourful" without fancy gradients.
      const t = v / 255;
      const r = Math.round(255 * Math.max(0, Math.min(1, 1.5 * t - 0.2)));
      const g = Math.round(255 * Math.max(0, Math.min(1, 1.6 * t)));
      const b = Math.round(255 * Math.max(0, Math.min(1, 1.6 * (1 - t) - 0.1)));
      const colour = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      const rectX = originX + x * PIXEL_SCALE;
      const rectY = originY + y * PIXEL_SCALE;
      out.push(
        `<rect x="${fmt(rectX)}" y="${fmt(rectY)}" width="${PIXEL_SCALE}" ` +
          `height="${PIXEL_SCALE}" fill="${colour}"/>`,
      );
    }
  }
  return out;
}

/**
 * Render a single cell at the given `originX`, `originY`. Returns the
 * SVG fragment for that cell.
 */
function renderCell(
  cell: DigitCell,
  originX: number,
  originY: number,
  imageSize: number,
  threshold: number,
): string {
  const K = cell.frames.length;
  const fragments: string[] = [
    `<g class="cell">`,
    // Cell background panel — purple to make the colourful pixels pop.
    `  <rect x="${fmt(originX)}" y="${fmt(originY)}" width="${CELL_IMAGE_SIZE}" ` +
    `height="${CELL_IMAGE_SIZE}" fill="#1a1230" stroke="#3a2a5a" stroke-width="1"/>`,
  ];

  for (let i = 0; i < K; i++) {
    const frame = cell.frames[i];
    const correct = frame.prediction === frame.label;
    const labelColour = correct ? "#2ecc71" : "#e74c3c";
    const labelText = correct
      ? `T:${frame.label} P:${frame.prediction} ✓`
      : `T:${frame.label} P:${frame.prediction} ✗`;

    const anim = frameAnimation(i, K);
    const initialOpacity = i === 0 ? "1" : "0";
    fragments.push(
      `  <g class="frame frame-${i}" opacity="${initialOpacity}">`,
    );
    if (anim) {
      fragments.push(
        `    <animate attributeName="opacity" calcMode="discrete" ` +
          `values="${anim.values}" keyTimes="${anim.keyTimes}" ` +
          `dur="${ANIMATION_DURATION_SECONDS}s" repeatCount="indefinite"/>`,
      );
    }
    const pixelRects = renderPixels(
      frame.pixels,
      imageSize,
      threshold,
      originX,
      originY,
    );
    for (const r of pixelRects) fragments.push(`    ${r}`);

    // Predicted-vs-actual label below the image.
    const labelX = originX + CELL_IMAGE_SIZE / 2;
    const labelY = originY + CELL_IMAGE_SIZE + CELL_LABEL_HEIGHT - 8;
    fragments.push(
      `    <text class="cell-label cell-label-${correct ? "correct" : "wrong"}" ` +
        `x="${fmt(labelX)}" y="${fmt(labelY)}" text-anchor="middle" ` +
        `font-family="monospace" font-size="14" fill="${labelColour}">` +
        `${escapeXml(labelText)}</text>`,
    );
    fragments.push(`  </g>`);
  }
  fragments.push(`</g>`);
  return fragments.join("\n");
}

/**
 * Render the animated digit grid SVG.
 *
 * Throws when no cells are provided — there is nothing meaningful to
 * draw. Cells beyond `GRID_ROWS * GRID_COLS` are silently truncated.
 */
export function renderDigitGridSVG(opts: DigitGridOptions): string {
  if (opts.cells.length === 0) {
    throw new Error("renderDigitGridSVG: at least one cell is required");
  }
  const imageSize = opts.imageSize ?? SOURCE_IMAGE_SIZE;
  const threshold = opts.pixelThreshold ?? 24;
  const cellCount = Math.min(opts.cells.length, GRID_ROWS * GRID_COLS);

  const cellsSvg: string[] = [];
  for (let idx = 0; idx < cellCount; idx++) {
    const row = Math.floor(idx / GRID_COLS);
    const col = idx % GRID_COLS;
    const originX = OUTER_MARGIN + col * (CELL_IMAGE_SIZE + CELL_PADDING);
    const originY = OUTER_MARGIN + row * (CELL_IMAGE_SIZE + CELL_LABEL_HEIGHT + CELL_PADDING);
    cellsSvg.push(renderCell(opts.cells[idx], originX, originY, imageSize, threshold));
  }

  const captionTop = SVG_HEIGHT - CAPTION_HEIGHT - 4;
  const accPct = (opts.accuracy * 100).toFixed(2);
  const valAccPct = (opts.validationAccuracy * 100).toFixed(2);
  const caption = `Validation accuracy: ${valAccPct}%  ·  Test accuracy: ${accPct}%  ·  ` +
    `Green ✓ = correct prediction, red ✗ = wrong`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" ` +
    `width="${SVG_WIDTH}" height="${SVG_HEIGHT}" role="img" ` +
    `aria-label="Animated 5×4 grid of MNIST predictions, with green ticks for correct ` +
    `predictions and red crosses for misclassifications">`,
    `  <title>MNIST Champion — Animated Test Grid</title>`,
    `  <desc>Each cell cross-fades through several test digits over a ` +
    `${ANIMATION_DURATION_SECONDS}-second loop. Pixel intensity is mapped to a ` +
    `purple-to-yellow ramp; the label below shows true/predicted classes — ` +
    `green when the network is correct, red when it is wrong.</desc>`,
    `  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#0d0820"/>`,
    `  <rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="none" ` +
    `stroke="#3a2a5a" stroke-width="1"/>`,
    cellsSvg.join("\n"),
    `  <text x="${SVG_WIDTH / 2}" y="${captionTop + 26}" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" fill="#f5e9ff">${escapeXml(caption)}</text>`,
    `  <text x="${SVG_WIDTH / 2}" y="${captionTop + 46}" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="11" fill="#a89cd6">` +
    `Animated cells cycle every ${ANIMATION_DURATION_SECONDS}s — each cell shows ` +
    `several held-out test digits classified by the champion network.</text>`,
    `</svg>`,
    "",
  ].join("\n");
}
