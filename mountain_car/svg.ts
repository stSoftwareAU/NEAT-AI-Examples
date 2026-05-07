/**
 * SVG rendering helpers for the Mountain-Car example.
 *
 * Produces a single animated SVG of the champion's run. The hill is
 * drawn as a smooth sinusoidal path with a goal flag at `x = 0.5`. A
 * car icon (a small circle) is animated along the recorded trajectory
 * via SMIL `<animate>` elements on its `cx` and `cy` attributes. The
 * car changes colour the moment it crosses the flag line so static
 * preview tools and accessibility readers can still tell whether the
 * episode succeeded. A bottom progress bar sweeps left-to-right to
 * match the cart-pole style.
 */
import { GOAL_POSITION, hillHeight, type MountainCarState } from "./physics.ts";

/** SVG canvas width in user units. */
export const SVG_WIDTH = 600;

/** SVG canvas height in user units. */
export const SVG_HEIGHT = 320;

/** Minimum horizontal coordinate of the visible track. */
const TRACK_MIN_X = -1.2;

/** Maximum horizontal coordinate of the visible track (just past the goal). */
const TRACK_MAX_X = 0.6;

/** Margin (user units) reserved around the track for padding. */
const MARGIN_X = 30;

/** Top margin reserved for the title row. */
const MARGIN_TOP = 30;

/** Bottom margin reserved for the progress bar. */
const MARGIN_BOTTOM = 40;

/** Total animation duration (seconds) for one full replay loop. */
export const ANIMATION_DURATION_SECONDS = 6;

/**
 * Maximum number of trajectory keyframes baked into the SMIL value
 * lists. Longer traces are sub-sampled to keep the SVG compact.
 */
export const MAX_KEYFRAMES = 80;

/** Radius of the rendered car icon (pixels). */
const CAR_RADIUS = 8;

/** Pixel height of the goal flag pole above the hill profile. */
const FLAG_HEIGHT = 36;

/** Number of points sampled along the hill curve. */
const HILL_SAMPLES = 120;

/** Map a track-space x coordinate to its SVG-x position. */
function projectX(x: number): number {
  const span = TRACK_MAX_X - TRACK_MIN_X;
  return MARGIN_X + ((x - TRACK_MIN_X) / span) * (SVG_WIDTH - 2 * MARGIN_X);
}

/**
 * Map a track-space x coordinate to the SVG-y position of the hill
 * profile at that x. The hill height ranges in `[0.1, 1.0]`; we map
 * it linearly into the drawable vertical region with `1.0` near the
 * top of the canvas.
 */
function projectY(x: number): number {
  const drawableTop = MARGIN_TOP + 10;
  const drawableBottom = SVG_HEIGHT - MARGIN_BOTTOM;
  const drawableHeight = drawableBottom - drawableTop;
  const h = hillHeight(x);
  // hillHeight ∈ [0.1, 1.0]. Larger h = taller hill = smaller SVG y.
  return drawableBottom - ((h - 0.1) / 0.9) * drawableHeight;
}

/** Compute the (cx, cy) of the car when it sits on the hill at `x`. */
function carCenter(x: number): { cx: number; cy: number } {
  return {
    cx: projectX(x),
    cy: projectY(x) - CAR_RADIUS - 2,
  };
}

/**
 * Build a smooth `M ... L ... L ...` SVG path command tracing the hill
 * profile from `TRACK_MIN_X` to `TRACK_MAX_X`.
 */
function buildHillPath(): string {
  const segments: string[] = [];
  for (let i = 0; i <= HILL_SAMPLES; i++) {
    const t = i / HILL_SAMPLES;
    const x = TRACK_MIN_X + t * (TRACK_MAX_X - TRACK_MIN_X);
    const sx = projectX(x).toFixed(2);
    const sy = projectY(x).toFixed(2);
    segments.push(`${i === 0 ? "M" : "L"}${sx},${sy}`);
  }
  // Close the shape to the bottom-right and bottom-left corners so the
  // hill silhouette can be filled.
  segments.push(`L${(SVG_WIDTH - MARGIN_X).toFixed(2)},${(SVG_HEIGHT - MARGIN_BOTTOM).toFixed(2)}`);
  segments.push(`L${MARGIN_X.toFixed(2)},${(SVG_HEIGHT - MARGIN_BOTTOM).toFixed(2)} Z`);
  return segments.join(" ");
}

/** Build the open hill curve (no closure) as a stroke path. */
function buildHillStroke(): string {
  const segments: string[] = [];
  for (let i = 0; i <= HILL_SAMPLES; i++) {
    const t = i / HILL_SAMPLES;
    const x = TRACK_MIN_X + t * (TRACK_MAX_X - TRACK_MIN_X);
    const sx = projectX(x).toFixed(2);
    const sy = projectY(x).toFixed(2);
    segments.push(`${i === 0 ? "M" : "L"}${sx},${sy}`);
  }
  return segments.join(" ");
}

/**
 * Render the champion's run as an animated SVG. The trace must contain
 * at least one state. The first state is taken as the static base
 * pose so SMIL-disabled viewers (e.g. raw image previewers) still see
 * a sensible frame.
 */
export function renderRunSVG(trace: MountainCarState[]): string {
  if (trace.length === 0) {
    throw new Error("trace must contain at least one state");
  }

  // Sub-sample down to MAX_KEYFRAMES while always keeping the final
  // state — the moment the car crosses (or fails to cross) the flag.
  const sampleStride = Math.max(1, Math.floor(trace.length / MAX_KEYFRAMES));
  const samples: MountainCarState[] = [];
  for (let i = 0; i < trace.length; i += sampleStride) {
    samples.push(trace[i]);
  }
  if (samples[samples.length - 1] !== trace[trace.length - 1]) {
    samples.push(trace[trace.length - 1]);
  }

  const cxValues = samples.map((s) => carCenter(s.x).cx.toFixed(2)).join(";");
  const cyValues = samples.map((s) => carCenter(s.x).cy.toFixed(2)).join(";");
  // Car colour: greys until it reaches the flag, then turns success-green
  // and stays green for the rest of the loop. Discrete keyframes give a
  // sharp visual confirmation.
  const fillValues = samples
    .map((s) => (s.x >= GOAL_POSITION ? "#2ecc71" : "#e74c3c"))
    .join(";");

  const animDur = `${ANIMATION_DURATION_SECONDS}s`;
  const animationCommon =
    `dur="${animDur}" repeatCount="indefinite" calcMode="linear" fill="freeze"`;

  const first = samples[0];
  const firstCenter = carCenter(first.x);
  const firstFill = first.x >= GOAL_POSITION ? "#2ecc71" : "#e74c3c";

  // Goal flag geometry: a vertical pole at the goal position rising
  // out of the hill, plus a triangular flag near the top.
  const goalX = projectX(GOAL_POSITION);
  const goalHillY = projectY(GOAL_POSITION);
  const flagBaseY = goalHillY;
  const flagTopY = flagBaseY - FLAG_HEIGHT;
  const flagTipX = goalX + 18;
  const flagMidY = flagTopY + 10;

  // Progress bar geometry — matches the cart-pole style.
  const progressBarY = SVG_HEIGHT - 18;
  const progressBarLeft = MARGIN_X;
  const progressBarWidth = SVG_WIDTH - 2 * MARGIN_X;

  const lastSample = samples[samples.length - 1];
  const stepsTaken = trace.length - 1;
  const succeeded = lastSample.x >= GOAL_POSITION;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" ` +
    `width="${SVG_WIDTH}" height="${SVG_HEIGHT}" role="img" ` +
    `aria-label="Mountain Car champion run, animated through ${samples.length} keyframes">`,
    `  <title>Mountain Car Champion Run (animated)</title>`,
    `  <desc>SMIL-animated SVG: an under-powered car oscillates across a sinusoidal ` +
    `valley and finally crests the goal flag. The car icon changes colour the moment ` +
    `it crosses the flag line. Loops every ${ANIMATION_DURATION_SECONDS} seconds.</desc>`,
    `  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#eef6ff"/>`,
    `  <rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" ` +
    `fill="none" stroke="#cccccc"/>`,
    // Hill silhouette (filled).
    `  <path class="hill-fill" d="${buildHillPath()}" fill="#7cb342" stroke="none"/>`,
    // Hill profile (stroked) — the smooth sinusoidal curve.
    `  <path class="hill" d="${buildHillStroke()}" fill="none" stroke="#33691e" ` +
    `stroke-width="2"/>`,
    // Goal flag: pole + triangular flag.
    `  <g class="goal">`,
    `    <line x1="${goalX.toFixed(2)}" y1="${flagBaseY.toFixed(2)}" ` +
    `x2="${goalX.toFixed(2)}" y2="${flagTopY.toFixed(2)}" stroke="#222" stroke-width="2"/>`,
    `    <polygon points="${goalX.toFixed(2)},${flagTopY.toFixed(2)} ` +
    `${flagTipX.toFixed(2)},${flagMidY.toFixed(2)} ` +
    `${goalX.toFixed(2)},${(flagTopY + 18).toFixed(2)}" fill="#f1c40f" stroke="#b7950b"/>`,
    // Dashed flag line — visual marker of the success threshold.
    `    <line x1="${goalX.toFixed(2)}" y1="${MARGIN_TOP.toFixed(2)}" ` +
    `x2="${goalX.toFixed(2)}" y2="${flagBaseY.toFixed(2)}" stroke="#f1c40f" ` +
    `stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>`,
    `  </g>`,
    // Animated car: a small circle that follows the trajectory.
    `  <circle class="car" cx="${firstCenter.cx.toFixed(2)}" ` +
    `cy="${firstCenter.cy.toFixed(2)}" r="${CAR_RADIUS}" fill="${firstFill}" ` +
    `stroke="#222" stroke-width="2">`,
    `    <animate attributeName="cx" values="${cxValues}" ${animationCommon}/>`,
    `    <animate attributeName="cy" values="${cyValues}" ${animationCommon}/>`,
    `    <animate attributeName="fill" values="${fillValues}" ` +
    `dur="${animDur}" repeatCount="indefinite" calcMode="discrete" fill="freeze"/>`,
    `  </circle>`,
    // Title row: example label and outcome summary.
    `  <text x="12" y="22" font-family="monospace" font-size="13" fill="#333">` +
    `Mountain Car · ${stepsTaken} steps · ${succeeded ? "solved" : "timed out"}</text>`,
    `  <text x="${SVG_WIDTH - 12}" y="22" text-anchor="end" font-family="sans-serif" ` +
    `font-size="11" fill="#666">animated · loops every ${ANIMATION_DURATION_SECONDS}s</text>`,
    // Progress bar background.
    `  <rect x="${progressBarLeft.toFixed(2)}" y="${progressBarY}" ` +
    `width="${progressBarWidth.toFixed(2)}" height="4" fill="#d0d7de" rx="2"/>`,
    // Progress bar sweep.
    `  <rect class="progress" x="${progressBarLeft.toFixed(2)}" y="${progressBarY}" ` +
    `width="0" height="4" fill="#4a90d9" rx="2">`,
    `    <animate attributeName="width" values="0;${progressBarWidth.toFixed(2)}" ` +
    `dur="${animDur}" repeatCount="indefinite" fill="freeze"/>`,
    `  </rect>`,
    `</svg>`,
    "",
  ].join("\n");
}
