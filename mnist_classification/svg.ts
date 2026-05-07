/**
 * SVG rendering helpers for the MNIST classification example.
 *
 * Produces a single animated SVG with a 5 × 4 grid of test digits.
 * Each cell shows the original 28 × 28 greyscale image plus a label
 * overlay — green when the network's prediction matches the ground
 * truth, red when it does not. Cells cross-fade through several test
 * samples per slot using SMIL `<animate>` so the visualisation pulses
 * and feels alive.
 */
import type { Creature } from "@stsoftware/neat-ai";

import { type MnistSample, predictDigit, SOURCE_GRID } from "./mnist_classification.ts";

/** Width (in SVG user units) of the rendered grid. */
export const PLOT_WIDTH = 640;

/** Height (in SVG user units) of the rendered grid. */
export const PLOT_HEIGHT = 560;

/** Width of the cell area inside the plot. */
const CELL_W = 110;

/** Height of the cell area inside the plot. */
const CELL_H = 110;

/** Top-left corner of the grid. */
const GRID_X = 30;
const GRID_Y = 60;

/** Gap between cells. */
const CELL_GAP = 14;

/** Total animation duration (seconds) for one full cross-fade cycle. */
export const ANIMATION_DURATION_SECONDS = 6;

/** Options controlling the grid render. */
export interface RenderOptions {
  /** Number of cell columns. */
  cols: number;
  /** Number of cell rows. */
  rows: number;
  /** Number of samples cross-faded inside each cell. */
  samplesPerCell: number;
  /** Overall test-fold accuracy in `[0, 1]` for the caption. */
  accuracy: number;
}

/**
 * Render the animated digit grid. The renderer takes the first
 * `cols * rows * samplesPerCell` samples from `testSamples` and
 * cycles them through the cells with SMIL opacity cross-fades.
 *
 * Fewer samples than required is allowed — the renderer simply repeats
 * the available samples so the grid always fills.
 */
export function renderMnistGridSVG(
  creature: Creature,
  testSamples: readonly MnistSample[],
  options: RenderOptions,
): string {
  const { cols, rows, samplesPerCell, accuracy } = options;
  if (cols < 1 || rows < 1) {
    throw new Error(`grid dimensions must be positive, got ${cols}×${rows}`);
  }
  if (samplesPerCell < 1) {
    throw new Error(`samplesPerCell must be at least 1, got ${samplesPerCell}`);
  }
  if (testSamples.length === 0) {
    throw new Error("renderMnistGridSVG: testSamples must be non-empty");
  }

  const cellCount = cols * rows;
  const cells: string[] = [];
  let sampleIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellSamples: MnistSample[] = [];
      for (let s = 0; s < samplesPerCell; s++) {
        cellSamples.push(testSamples[sampleIdx % testSamples.length]);
        sampleIdx++;
      }
      const cellIndex = r * cols + c;
      cells.push(renderCell(creature, cellSamples, c, r, cellIndex, cellCount));
    }
  }

  const correct = countCorrect(creature, testSamples);
  const evaluatedAcc = testSamples.length > 0 ? correct / testSamples.length : accuracy;
  const accuracyPct = (evaluatedAcc * 100).toFixed(1);
  const caption = `<text x="${PLOT_WIDTH / 2}" y="${PLOT_HEIGHT - 22}" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="15" fill="#222">` +
    `Test accuracy: ${accuracyPct}% (${correct} / ${testSamples.length} correct)</text>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="MNIST classification grid with predicted vs. actual labels">`,
    `  <title>MNIST Classification — Predicted vs. Actual</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="32" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="18" font-weight="bold" fill="#222">` +
    `MNIST Classification Champion</text>`,
    `  <g class="cells">`,
    cells.join("\n"),
    `  </g>`,
    caption,
    `</svg>`,
    "",
  ].join("\n");
}

/** Count correctly classified samples (used in the caption). */
function countCorrect(creature: Creature, samples: readonly MnistSample[]): number {
  let correct = 0;
  for (const s of samples) {
    if (predictDigit(creature, s.pixels) === s.label) correct++;
  }
  return correct;
}

/**
 * Render one grid cell — a stack of {@link MnistSample} layers that
 * cross-fade in and out, plus a frame and a label overlay.
 */
function renderCell(
  creature: Creature,
  samples: readonly MnistSample[],
  col: number,
  row: number,
  cellIndex: number,
  cellCount: number,
): string {
  const x = GRID_X + col * (CELL_W + CELL_GAP);
  const y = GRID_Y + row * (CELL_H + CELL_GAP);
  const dur = ANIMATION_DURATION_SECONDS;
  // Stagger the start of each cell's fade so the grid ripples rather
  // than blinking in unison.
  const cellOffset = (cellIndex / cellCount) * (dur / samples.length);

  const layers: string[] = [];
  for (let s = 0; s < samples.length; s++) {
    layers.push(renderSampleLayer(creature, samples[s], x, y, s, samples.length, dur, cellOffset));
  }

  return [
    `    <g class="cell" data-row="${row}" data-col="${col}">`,
    `      <rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" ` +
    `fill="#111" stroke="#333" stroke-width="1"/>`,
    layers.join("\n"),
    `    </g>`,
  ].join("\n");
}

/** Render one cross-fade layer — pixel rects, label, animations. */
function renderSampleLayer(
  creature: Creature,
  sample: MnistSample,
  cellX: number,
  cellY: number,
  layerIndex: number,
  layerCount: number,
  totalDur: number,
  cellOffset: number,
): string {
  const slotDur = totalDur / layerCount;
  const begin = (cellOffset + layerIndex * slotDur).toFixed(3);
  // SMIL keyTimes for an opacity ramp: fade-in → hold → fade-out → 0.
  // Values are normalised against `totalDur` because SMIL keyTimes must
  // span [0, 1] over the full animation duration.
  const fadeIn = (slotDur * 0.05) / totalDur;
  const holdEnd = (slotDur * 0.85) / totalDur;
  const fadeOut = (slotDur * 0.95) / totalDur;
  const slotEnd = slotDur / totalDur;

  // Predict on the downsampled pixels; render the source 28×28 image.
  const predicted = predictDigit(creature, sample.pixels);
  const correct = predicted === sample.label;
  const labelColour = correct ? "#2ecc71" : "#e74c3c";
  const tick = correct ? "✓" : "✗";

  const pixelGrid = renderPixels(sample.source ?? sample.pixels, cellX, cellY);

  return [
    `      <g class="layer" opacity="${layerIndex === 0 ? 1 : 0}">`,
    pixelGrid,
    `        <rect x="${cellX + CELL_W - 38}" y="${cellY + 4}" width="34" height="22" ` +
    `rx="4" ry="4" fill="${labelColour}" opacity="0.85"/>`,
    `        <text x="${cellX + CELL_W - 21}" y="${cellY + 20}" text-anchor="middle" ` +
    `font-family="monospace" font-size="13" font-weight="bold" fill="#fff">` +
    `${predicted}${tick}</text>`,
    `        <text x="${cellX + 4}" y="${cellY + CELL_H - 6}" text-anchor="start" ` +
    `font-family="monospace" font-size="11" fill="#eee">` +
    `actual ${sample.label}</text>`,
    `        <animate attributeName="opacity" ` +
    `values="0;1;1;0;0" ` +
    `keyTimes="0;${fadeIn.toFixed(4)};${holdEnd.toFixed(4)};` +
    `${fadeOut.toFixed(4)};${slotEnd.toFixed(4)}" ` +
    `dur="${totalDur}s" begin="${begin}s" repeatCount="indefinite"/>`,
    `      </g>`,
  ].join("\n");
}

/**
 * Emit one `<rect>` per pixel for a sample. The image is rendered as a
 * 28×28 grid scaled to `(CELL_W - 8) × (CELL_H - 8)` so it sits inside
 * the cell with a small border.
 */
function renderPixels(pixels: Float32Array, cellX: number, cellY: number): string {
  const padX = 4;
  const padY = 28; // leave room for the label overlay at the top
  const drawW = CELL_W - 2 * padX;
  const drawH = CELL_H - padY - 8;
  const cellSize = Math.min(drawW, drawH) / SOURCE_GRID;
  const gridSide = SOURCE_GRID;

  // If the supplied pixels are not 28×28, fall back to whatever square grid they form.
  const expectedLen = gridSide * gridSide;
  const usePixels = pixels.length === expectedLen ? pixels : pixels;
  const side = pixels.length === expectedLen ? gridSide : Math.round(Math.sqrt(pixels.length));
  const sz = pixels.length === expectedLen ? cellSize : Math.min(drawW, drawH) / side;

  const rects: string[] = [];
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const v = Math.max(0, Math.min(1, usePixels[r * side + c]));
      if (v < 0.04) continue; // skip near-black pixels for size
      const px = (cellX + padX + c * sz).toFixed(2);
      const py = (cellY + padY + r * sz).toFixed(2);
      const sw = (sz + 0.5).toFixed(2);
      const intensity = Math.round(v * 255);
      rects.push(
        `        <rect x="${px}" y="${py}" width="${sw}" height="${sw}" ` +
          `fill="${pixelColour(intensity)}"/>`,
      );
    }
  }
  return rects.join("\n");
}

/** Map a greyscale intensity 0..255 to a yellow-orange-red ramp. */
export function pixelColour(intensity: number): string {
  const v = Math.max(0, Math.min(255, Math.round(intensity)));
  // Background is dark; foreground ramp is yellow → orange → red.
  // t = 0  → black (#111)
  // t = 1  → bright yellow (#ffe066)
  const t = v / 255;
  const dark = { r: 0x11, g: 0x11, b: 0x11 };
  const bright = { r: 0xff, g: 0xe0, b: 0x66 };
  const r = Math.round(dark.r + (bright.r - dark.r) * t);
  const g = Math.round(dark.g + (bright.g - dark.g) * t);
  const b = Math.round(dark.b + (bright.b - dark.b) * t);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
