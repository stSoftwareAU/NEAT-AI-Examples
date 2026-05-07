/**
 * SVG rendering helpers for the lunar-lander example.
 *
 * Produces a single SVG showing the champion's descent: a terrain
 * silhouette with a marked landing pad, the trajectory traced as a
 * polyline, and the lander rendered at start, mid-descent, and
 * touchdown. Optional flame markers appear when a thruster fired on
 * that frame. The renderer takes only pure data — no state, no DOM —
 * so the same trace produces byte-identical output across platforms.
 */
import {
  DEFAULT_TERRAIN,
  type LanderAction,
  type LanderState,
  type LanderTerrain,
} from "./physics.ts";

/** SVG canvas width in user units. */
export const SVG_WIDTH = 800;

/** SVG canvas height in user units. */
export const SVG_HEIGHT = 400;

/** Margin (user units) reserved around the world for axis labels. */
const MARGIN = 30;

/** Half-length of the rendered lander body (pixels). */
const LANDER_HALF_LENGTH = 12;

/** Pixel length of a thruster flame indicator. */
const FLAME_LENGTH = 14;

/** Number of pose markers drawn along the trajectory. Always 3 (start/mid/end). */
export const POSE_MARKER_COUNT = 3;

/** Total animation duration (seconds) for one full descent replay. */
export const ANIMATION_DURATION_SECONDS = 6;

/** HUD fuel-bar origin (top-left x, in SVG user units). */
const HUD_X = 16;

/** HUD fuel-bar origin (y, in SVG user units). */
const HUD_Y = 24;

/** HUD fuel-bar full width (in SVG user units). */
const HUD_FUEL_BAR_WIDTH = 100;

/** A single sampled trace step: state plus the action that produced the next state. */
export interface TraceFrame {
  state: LanderState;
  action: LanderAction;
}

/**
 * Map a world-space coordinate to an SVG-space coordinate. World x runs
 * left-to-right, but SVG y is inverted so altitude grows upward.
 */
function projectX(x: number, terrain: LanderTerrain): number {
  const span = terrain.worldHalfWidth * 2;
  return MARGIN + ((x + terrain.worldHalfWidth) / span) * (SVG_WIDTH - 2 * MARGIN);
}

/** Map an altitude to an SVG y. The world y range is [0, ceiling]. */
function projectY(y: number, ceiling: number): number {
  const drawableHeight = SVG_HEIGHT - 2 * MARGIN;
  return MARGIN + (1 - y / ceiling) * drawableHeight;
}

/**
 * Render a complete lunar-lander run as an SVG document.
 *
 * @param trace The trace frames from start to terminal state. Must be
 *   non-empty.
 * @param terrain Terrain layout (defaults to {@link DEFAULT_TERRAIN}).
 */
export function renderRunSVG(
  trace: TraceFrame[],
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): string {
  if (trace.length === 0) {
    throw new Error("trace must contain at least one frame");
  }

  // Determine the world-y ceiling for projection: include the highest
  // point reached plus some headroom so the trajectory always fits.
  const maxAltitude = Math.max(...trace.map((f) => f.state.y));
  const ceiling = Math.max(maxAltitude * 1.1, 20);

  const groundSvg = projectY(terrain.groundY, ceiling);
  const padLeft = projectX(terrain.padX - terrain.padHalfWidth, terrain);
  const padRight = projectX(terrain.padX + terrain.padHalfWidth, terrain);

  const trajectoryPoints = trace
    .map((f) =>
      `${projectX(f.state.x, terrain).toFixed(2)},${projectY(f.state.y, ceiling).toFixed(2)}`
    )
    .join(" ");

  // Pose indices: start, midpoint, last (deduplicated for very short traces).
  const lastIdx = trace.length - 1;
  const midIdx = Math.floor(lastIdx / 2);
  const poseIndices = Array.from(new Set([0, midIdx, lastIdx]));

  const poseGroups = poseIndices
    .map((idx) => renderPose(trace[idx], idx, terrain, ceiling))
    .join("\n");

  // Build SMIL keyframes for an animated lander icon that follows the
  // entire trajectory. Sample at most 80 points so the value lists stay
  // small even for long traces.
  const sampleStride = Math.max(1, Math.floor(trace.length / 80));
  const animSamples: TraceFrame[] = [];
  for (let i = 0; i < trace.length; i += sampleStride) {
    animSamples.push(trace[i]);
  }
  if (animSamples[animSamples.length - 1] !== trace[trace.length - 1]) {
    animSamples.push(trace[trace.length - 1]);
  }
  // Translate keyframes: "x,y;x,y;..." for the outer group.
  const translateValues = animSamples
    .map((f) =>
      `${projectX(f.state.x, terrain).toFixed(2)},${projectY(f.state.y, ceiling).toFixed(2)}`
    )
    .join(";");
  // Rotation keyframes (degrees). Physics convention: positive angle =
  // lean left (anti-clockwise). SVG y is flipped so a left lean in
  // screen-space requires a NEGATIVE SVG rotate value.
  const rotateValues = animSamples
    .map((f) => (-f.state.angle * 180 / Math.PI).toFixed(2))
    .join(";");
  // Per-thruster flame visibility — 1 when firing, 0 otherwise.
  const mainFlameValues = animSamples
    .map((f) => (f.action.main ? "1" : "0"))
    .join(";");
  const leftFlameValues = animSamples
    .map((f) => (f.action.left ? "1" : "0"))
    .join(";");
  const rightFlameValues = animSamples
    .map((f) => (f.action.right ? "1" : "0"))
    .join(";");
  // Fuel bar width (HUD): scales 0..HUD_FUEL_BAR_WIDTH. Issue #72:
  // surfacing fuel as a shrinking bar makes the "fighting fuel" budget
  // visible while watching the descent.
  const startFuel = animSamples[0].state.fuel;
  const fuelBarValues = animSamples
    .map((f) =>
      (HUD_FUEL_BAR_WIDTH * Math.max(0, Math.min(1, f.state.fuel / Math.max(startFuel, 1e-6))))
        .toFixed(2)
    )
    .join(";");

  const animDur = `${ANIMATION_DURATION_SECONDS}s`;
  const firstSample = animSamples[0];
  const startCx = projectX(firstSample.state.x, terrain);
  const startCy = projectY(firstSample.state.y, ceiling);
  const startRotateDeg = (-firstSample.state.angle * 180 / Math.PI).toFixed(2);

  // Pad-target marker geometry: a downward arrow with "TARGET" label
  // hovering above the pad so the lander's destination is unmistakable.
  const padCx = projectX(terrain.padX, terrain);
  const targetTipY = groundSvg - 8;
  const targetTopY = targetTipY - 26;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" ` +
    `width="${SVG_WIDTH}" height="${SVG_HEIGHT}" role="img" ` +
    `aria-label="Lunar lander champion descent trajectory (animated)">`,
    `  <title>Lunar Lander Champion Descent (animated)</title>`,
    `  <desc>SMIL-animated SVG: a lander icon descends along the recorded ` +
    `trajectory, tilting with its angle and flickering its main, left, and ` +
    `right thruster flames as the controller fires them. A HUD shows the ` +
    `remaining fuel budget. Loops every ${ANIMATION_DURATION_SECONDS} seconds.</desc>`,
    `  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#0b0b1a"/>`,
    // Stars — purely cosmetic, deterministic positions for reproducibility.
    renderStars(),
    // Terrain silhouette: filled area from ground down to the bottom of the SVG.
    `  <rect x="0" y="${groundSvg.toFixed(2)}" width="${SVG_WIDTH}" ` +
    `height="${(SVG_HEIGHT - groundSvg).toFixed(2)}" fill="#3a2a1a"/>`,
    // Landing pad: bright strip on top of the terrain.
    `  <rect class="pad" x="${padLeft.toFixed(2)}" y="${(groundSvg - 4).toFixed(2)}" ` +
    `width="${(padRight - padLeft).toFixed(2)}" height="6" fill="#f5d76e" stroke="#b8860b"/>`,
    // Pad-target arrow + label so the destination is obvious.
    `  <g class="target-marker">`,
    `    <line x1="${padCx.toFixed(2)}" y1="${targetTopY.toFixed(2)}" ` +
    `x2="${padCx.toFixed(2)}" y2="${targetTipY.toFixed(2)}" ` +
    `stroke="#f5d76e" stroke-width="2" stroke-dasharray="3 2"/>`,
    `    <polygon points="${(padCx - 5).toFixed(2)},${(targetTipY - 6).toFixed(2)} ` +
    `${(padCx + 5).toFixed(2)},${(targetTipY - 6).toFixed(2)} ` +
    `${padCx.toFixed(2)},${targetTipY.toFixed(2)}" fill="#f5d76e"/>`,
    `    <text x="${padCx.toFixed(2)}" y="${(targetTopY - 4).toFixed(2)}" ` +
    `text-anchor="middle" font-family="monospace" font-size="11" fill="#f5d76e">TARGET</text>`,
    `  </g>`,
    // Trajectory polyline.
    `  <polyline class="trajectory" points="${trajectoryPoints}" ` +
    `fill="none" stroke="#9ad9ff" stroke-width="2" stroke-dasharray="4 3"/>`,
    poseGroups,
    // Animated lander: a translate-then-rotate group lets us draw the
    // lander geometry (body, hull, three thruster flames) once in a
    // local frame at (0,0) and animate the whole package through the
    // trajectory while it tilts with the controller's angle. Each
    // flame's opacity is keyframed so the controls are visible in
    // motion — not just in the static pose markers.
    `  <g class="animated-lander" transform="translate(${startCx.toFixed(2)} ${
      startCy.toFixed(2)
    })">`,
    `    <animateTransform attributeName="transform" type="translate" ` +
    `values="${translateValues}" dur="${animDur}" repeatCount="indefinite" ` +
    `calcMode="linear"/>`,
    `    <g class="lander-rotor" transform="rotate(${startRotateDeg})">`,
    `      <animateTransform attributeName="transform" type="rotate" ` +
    `values="${rotateValues}" dur="${animDur}" repeatCount="indefinite" ` +
    `calcMode="linear"/>`,
    // Body line — drawn vertically so rotate(0) leaves the lander upright.
    `      <line class="anim-body" x1="0" y1="${(-LANDER_HALF_LENGTH).toFixed(2)}" ` +
    `x2="0" y2="${LANDER_HALF_LENGTH.toFixed(2)}" stroke="#dddddd" stroke-width="6" ` +
    `stroke-linecap="round"/>`,
    // Hull marker.
    `      <circle class="anim-hull" cx="0" cy="0" r="6" fill="#4a90d9" ` +
    `stroke="#dddddd" stroke-width="2"/>`,
    // Main-thruster flame: shoots straight down (local frame) when fired.
    `      <line class="anim-flame main" x1="0" y1="${LANDER_HALF_LENGTH.toFixed(2)}" ` +
    `x2="0" y2="${(LANDER_HALF_LENGTH + FLAME_LENGTH).toFixed(2)}" ` +
    `stroke="#ff8c1a" stroke-width="3" stroke-linecap="round" opacity="${
      firstSample.action.main ? 1 : 0
    }">`,
    `        <animate attributeName="opacity" values="${mainFlameValues}" ` +
    `dur="${animDur}" repeatCount="indefinite" calcMode="discrete"/>`,
    `      </line>`,
    // Left-RCS flame: shoots leftward from the lower-left of the body.
    `      <line class="anim-flame left" x1="${(-LANDER_HALF_LENGTH * 0.7).toFixed(2)}" ` +
    `y1="${LANDER_HALF_LENGTH.toFixed(2)}" ` +
    `x2="${(-LANDER_HALF_LENGTH * 0.7 - FLAME_LENGTH * 0.6).toFixed(2)}" ` +
    `y2="${LANDER_HALF_LENGTH.toFixed(2)}" stroke="#ffd166" stroke-width="2" ` +
    `stroke-linecap="round" opacity="${firstSample.action.left ? 1 : 0}">`,
    `        <animate attributeName="opacity" values="${leftFlameValues}" ` +
    `dur="${animDur}" repeatCount="indefinite" calcMode="discrete"/>`,
    `      </line>`,
    // Right-RCS flame: shoots rightward from the lower-right of the body.
    `      <line class="anim-flame right" x1="${(LANDER_HALF_LENGTH * 0.7).toFixed(2)}" ` +
    `y1="${LANDER_HALF_LENGTH.toFixed(2)}" ` +
    `x2="${(LANDER_HALF_LENGTH * 0.7 + FLAME_LENGTH * 0.6).toFixed(2)}" ` +
    `y2="${LANDER_HALF_LENGTH.toFixed(2)}" stroke="#ffd166" stroke-width="2" ` +
    `stroke-linecap="round" opacity="${firstSample.action.right ? 1 : 0}">`,
    `        <animate attributeName="opacity" values="${rightFlameValues}" ` +
    `dur="${animDur}" repeatCount="indefinite" calcMode="discrete"/>`,
    `      </line>`,
    `    </g>`,
    `  </g>`,
    // HUD: animated fuel bar — shrinks as fuel is consumed.
    `  <g class="hud">`,
    `    <text x="${HUD_X}" y="${(HUD_Y - 4).toFixed(2)}" font-family="monospace" ` +
    `font-size="10" fill="#cccccc">FUEL</text>`,
    `    <rect class="hud-fuel-track" x="${HUD_X}" y="${HUD_Y}" ` +
    `width="${HUD_FUEL_BAR_WIDTH}" height="8" fill="#222" stroke="#666" ` +
    `stroke-width="1"/>`,
    `    <rect class="hud-fuel-bar" x="${HUD_X}" y="${HUD_Y}" ` +
    `width="${HUD_FUEL_BAR_WIDTH}" height="8" fill="#7ed321">`,
    `      <animate attributeName="width" values="${fuelBarValues}" ` +
    `dur="${animDur}" repeatCount="indefinite" calcMode="linear"/>`,
    `    </rect>`,
    `  </g>`,
    `  <text x="${SVG_WIDTH - 12}" y="${SVG_HEIGHT - 12}" text-anchor="end" ` +
    `font-family="sans-serif" font-size="11" fill="#9ad9ff">animated · loops every ` +
    `${ANIMATION_DURATION_SECONDS}s</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

/**
 * Render a single lander pose as a `<g>` element. The pose group also
 * includes a small step-index label and any active thruster flames.
 */
function renderPose(
  frame: TraceFrame,
  traceIdx: number,
  terrain: LanderTerrain,
  ceiling: number,
): string {
  const cx = projectX(frame.state.x, terrain);
  const cy = projectY(frame.state.y, ceiling);
  const angle = frame.state.angle;

  // Body: a small rectangle rotated about its centre.
  const bodyHalf = LANDER_HALF_LENGTH;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Local up direction (in screen space, y is flipped, so rotate sin sign).
  const upX = -sin;
  const upY = -cos;

  // Top of the lander (canopy) and bottom of the lander (legs).
  const topX = cx + upX * bodyHalf;
  const topY = cy + upY * bodyHalf;
  const botX = cx - upX * bodyHalf;
  const botY = cy - upY * bodyHalf;

  // Side perpendiculars used for legs and RCS flames.
  const sideX = upY;
  const sideY = -upX;
  const legL_X = botX + sideX * (bodyHalf * 0.7);
  const legL_Y = botY + sideY * (bodyHalf * 0.7);
  const legR_X = botX - sideX * (bodyHalf * 0.7);
  const legR_Y = botY - sideY * (bodyHalf * 0.7);

  const flames: string[] = [];
  if (frame.action.main) {
    const fx = botX - upX * FLAME_LENGTH;
    const fy = botY - upY * FLAME_LENGTH;
    flames.push(
      `    <line class="flame main" x1="${botX.toFixed(2)}" y1="${botY.toFixed(2)}" ` +
        `x2="${fx.toFixed(2)}" y2="${
          fy.toFixed(2)
        }" stroke="#ff8c1a" stroke-width="3" stroke-linecap="round"/>`,
    );
  }
  if (frame.action.left) {
    const fx = legL_X + sideX * FLAME_LENGTH * 0.6;
    const fy = legL_Y + sideY * FLAME_LENGTH * 0.6;
    flames.push(
      `    <line class="flame left" x1="${legL_X.toFixed(2)}" y1="${legL_Y.toFixed(2)}" ` +
        `x2="${fx.toFixed(2)}" y2="${
          fy.toFixed(2)
        }" stroke="#ffd166" stroke-width="2" stroke-linecap="round"/>`,
    );
  }
  if (frame.action.right) {
    const fx = legR_X - sideX * FLAME_LENGTH * 0.6;
    const fy = legR_Y - sideY * FLAME_LENGTH * 0.6;
    flames.push(
      `    <line class="flame right" x1="${legR_X.toFixed(2)}" y1="${legR_Y.toFixed(2)}" ` +
        `x2="${fx.toFixed(2)}" y2="${
          fy.toFixed(2)
        }" stroke="#ffd166" stroke-width="2" stroke-linecap="round"/>`,
    );
  }

  return [
    `  <g class="pose" data-step="${traceIdx}">`,
    `    <line class="body" x1="${botX.toFixed(2)}" y1="${botY.toFixed(2)}" ` +
    `x2="${topX.toFixed(2)}" y2="${
      topY.toFixed(2)
    }" stroke="#dddddd" stroke-width="6" stroke-linecap="round"/>`,
    `    <line class="leg" x1="${botX.toFixed(2)}" y1="${botY.toFixed(2)}" ` +
    `x2="${legL_X.toFixed(2)}" y2="${legL_Y.toFixed(2)}" stroke="#aaaaaa" stroke-width="2"/>`,
    `    <line class="leg" x1="${botX.toFixed(2)}" y1="${botY.toFixed(2)}" ` +
    `x2="${legR_X.toFixed(2)}" y2="${legR_Y.toFixed(2)}" stroke="#aaaaaa" stroke-width="2"/>`,
    `    <circle class="hull" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="3" fill="#4a90d9"/>`,
    ...flames,
    `    <text x="${(cx + 8).toFixed(2)}" y="${(cy - 8).toFixed(2)}" font-family="monospace" ` +
    `font-size="10" fill="#cccccc">step ${traceIdx}</text>`,
    `  </g>`,
  ].join("\n");
}

/** Tiny deterministic starfield in the night sky. */
function renderStars(): string {
  const stars: string[] = [];
  // Fixed-pattern stars (no PRNG dependency to keep the output stable).
  const positions: Array<[number, number]> = [
    [60, 40],
    [140, 70],
    [220, 30],
    [310, 60],
    [400, 25],
    [490, 80],
    [580, 35],
    [660, 75],
    [740, 50],
    [180, 120],
    [350, 110],
    [520, 130],
    [700, 100],
    [80, 200],
    [260, 180],
    [430, 170],
    [620, 190],
  ];
  for (const [x, y] of positions) {
    stars.push(`  <circle cx="${x}" cy="${y}" r="1" fill="#ffffff" opacity="0.7"/>`);
  }
  return stars.join("\n");
}
