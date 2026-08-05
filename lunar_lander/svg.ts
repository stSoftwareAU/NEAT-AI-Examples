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
  classifyOutcome,
  DEFAULT_TERRAIN,
  type LanderAction,
  type LanderOutcome,
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
export const LANDER_HALF_LENGTH = 12;

/** Pixel length of a thruster flame indicator. */
const FLAME_LENGTH = 14;

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
 * @param outcome Final classification of the run. When the controller
 *   `crashed` or drifted `out_of_bounds`, the renderer draws a starburst
 *   explosion at the final state and replaces the resting-pose lander
 *   with debris so the failure is visually unmistakable (issue #177).
 *   Defaults to classifying the last frame's state.
 */
export function renderRunSVG(
  trace: TraceFrame[],
  terrain: LanderTerrain = DEFAULT_TERRAIN,
  outcome?: LanderOutcome,
): string {
  if (trace.length === 0) {
    throw new Error("trace must contain at least one frame");
  }

  const finalState = trace[trace.length - 1].state;
  const resolvedOutcome: LanderOutcome = outcome ?? classifyOutcome(finalState, terrain);
  const exploded = resolvedOutcome === "crashed" || resolvedOutcome === "out_of_bounds";

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
  // When the run ended in an explosion, suppress the resting-pose lander at
  // the touchdown point — the debris/starburst takes its place so the wreck
  // is unmistakable (issue #177).
  const lastIdx = trace.length - 1;
  const midIdx = Math.floor(lastIdx / 2);
  const baseIndices = [0, midIdx, lastIdx];
  const poseIndices = Array.from(
    new Set(exploded ? baseIndices.filter((i) => i !== lastIdx) : baseIndices),
  );

  const poseGroups = poseIndices
    .map((idx) => renderPose(trace[idx], idx, terrain, ceiling))
    .join("\n");

  const finalCx = projectX(finalState.x, terrain);
  const finalCy = projectY(finalState.y, ceiling);
  const explosionGroup = exploded ? renderExplosion(finalCx, finalCy, resolvedOutcome) : "";

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
  // Translate keyframes: "x,y;x,y;..." for the outer group. Issue #181:
  // the projected (state.x, state.y) marks the lander's contact point
  // (legs); the body geometry is centred at the local origin and extends
  // ±LANDER_HALF_LENGTH, so we shift the translate up by
  // LANDER_HALF_LENGTH to keep the legs (local +bodyHalf) on the ground
  // at touchdown rather than punching through it.
  const translateValues = animSamples
    .map((f) =>
      `${projectX(f.state.x, terrain).toFixed(2)},${
        (projectY(f.state.y, ceiling) - LANDER_HALF_LENGTH).toFixed(2)
      }`
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
  // Issue #181: shift up by LANDER_HALF_LENGTH so the legs sit on the
  // projected ground line — see the matching offset in `translateValues`.
  const startCy = projectY(firstSample.state.y, ceiling) - LANDER_HALF_LENGTH;
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
    `  <rect class="terrain" x="0" y="${groundSvg.toFixed(2)}" width="${SVG_WIDTH}" ` +
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
    // Static debris + starburst when the run ended in a crash or
    // out-of-bounds drift (issue #177). Drawn before the animated lander
    // so the SMIL animation overlays during the descent and the debris
    // is what remains when the loop ends.
    explosionGroup,
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
    // Outcome badge — top-right of the canvas. Colour-coded so a viewer
    // can tell at a glance whether the run landed, crashed, drifted out
    // of bounds, or timed out (issue #177).
    renderOutcomeBadge(resolvedOutcome),
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

  // Issue #181: treat (cx, cy) as the lander's contact point (legs).
  // The body extends 2 × bodyHalf along the local-up direction so the
  // lander rests ON the ground at touchdown (state.y = groundY) rather
  // than being half-buried in the terrain silhouette.
  const botX = cx;
  const botY = cy;
  const topX = cx + upX * 2 * bodyHalf;
  const topY = cy + upY * 2 * bodyHalf;
  // Body centre — used for the hull marker.
  const bodyCx = cx + upX * bodyHalf;
  const bodyCy = cy + upY * bodyHalf;

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
    `    <circle class="hull" cx="${bodyCx.toFixed(2)}" cy="${
      bodyCy.toFixed(2)
    }" r="3" fill="#4a90d9"/>`,
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

/** Number of starburst rays drawn around an explosion. */
const EXPLOSION_RAY_COUNT = 12;

/** Outer radius (px) of the explosion starburst rays. */
const EXPLOSION_OUTER_RADIUS = 38;

/** Inner radius (px) of the explosion starburst rays. */
const EXPLOSION_INNER_RADIUS = 14;

/** Number of jagged debris fragments scattered around the impact point. */
const EXPLOSION_DEBRIS_COUNT = 6;

/**
 * Render the wreck of a crashed lander as a `<g class="explosion">` group.
 *
 * The graphic combines four layers so the outcome reads at a glance:
 *
 *   1. A pulsing fireball circle.
 *   2. A radial starburst (zig-zag polygon) in bright orange.
 *   3. Several short "debris" line fragments scattered around the centre.
 *   4. An "EXPLODED" or "OUT OF BOUNDS" caption above the wreck.
 *
 * All geometry is deterministic — no PRNG calls — so the same impact
 * point produces byte-identical SVG output across runs.
 */
function renderExplosion(
  cx: number,
  cy: number,
  outcome: LanderOutcome,
): string {
  const points: string[] = [];
  for (let i = 0; i < EXPLOSION_RAY_COUNT * 2; i++) {
    const angle = (i / (EXPLOSION_RAY_COUNT * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? EXPLOSION_OUTER_RADIUS : EXPLOSION_INNER_RADIUS;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    points.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  const burstPoints = points.join(" ");

  // Debris fragments — short white-grey segments fanning outward at
  // evenly-spaced angles with deterministic length variation so the
  // output stays stable across runs.
  const debrisLines: string[] = [];
  for (let i = 0; i < EXPLOSION_DEBRIS_COUNT; i++) {
    const angle = (i / EXPLOSION_DEBRIS_COUNT) * Math.PI * 2 + Math.PI / 7;
    // Deterministic per-shard length jitter — alternating short/long.
    const len = i % 2 === 0 ? 22 : 14;
    const x1 = cx + Math.cos(angle) * 6;
    const y1 = cy + Math.sin(angle) * 6;
    const x2 = cx + Math.cos(angle) * (6 + len);
    const y2 = cy + Math.sin(angle) * (6 + len);
    debrisLines.push(
      `    <line class="debris" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" ` +
        `x2="${x2.toFixed(2)}" y2="${
          y2.toFixed(2)
        }" stroke="#cccccc" stroke-width="2" stroke-linecap="round"/>`,
    );
  }

  const caption = outcome === "out_of_bounds" ? "OUT OF BOUNDS" : "EXPLODED";

  return [
    `  <g class="explosion" data-outcome="${outcome}">`,
    // Outer fireball — pulsing radius drives the eye to the wreck.
    `    <circle class="fireball" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" ` +
    `r="${EXPLOSION_OUTER_RADIUS}" fill="#ff8c1a" opacity="0.55">`,
    `      <animate attributeName="r" values="${EXPLOSION_OUTER_RADIUS};${
      (EXPLOSION_OUTER_RADIUS * 1.15).toFixed(2)
    };${EXPLOSION_OUTER_RADIUS}" dur="1.2s" repeatCount="indefinite"/>`,
    `      <animate attributeName="opacity" values="0.55;0.85;0.55" ` +
    `dur="1.2s" repeatCount="indefinite"/>`,
    `    </circle>`,
    // Starburst — jagged star polygon in bright orange/yellow.
    `    <polygon class="starburst" points="${burstPoints}" ` +
    `fill="#ffd166" stroke="#ff5722" stroke-width="2" opacity="0.92"/>`,
    // Inner core — bright yellow centre.
    `    <circle class="core" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="6" ` +
    `fill="#fff7d6"/>`,
    ...debrisLines,
    // Caption above the wreck — anchored centre so it sits over the impact.
    `    <text class="explosion-label" x="${cx.toFixed(2)}" y="${
      (cy - EXPLOSION_OUTER_RADIUS - 8).toFixed(2)
    }" text-anchor="middle" font-family="monospace" font-size="13" ` +
    `font-weight="bold" fill="#ff5722" stroke="#0b0b1a" stroke-width="0.5">${caption}</text>`,
    `  </g>`,
  ].join("\n");
}

/**
 * Render an outcome badge in the top-right corner of the canvas. Each
 * outcome gets a colour and a short label so a viewer can tell at a
 * glance whether the run landed, crashed, drifted out of bounds, or
 * timed out (issue #177).
 */
function renderOutcomeBadge(outcome: LanderOutcome): string {
  const styles: Record<LanderOutcome, { label: string; fill: string }> = {
    landed: { label: "✓ LANDED", fill: "#7ed321" },
    crashed: { label: "✗ CRASHED", fill: "#ff5722" },
    out_of_bounds: { label: "✗ OUT OF BOUNDS", fill: "#ff5722" },
    flying: { label: "… TIMED OUT", fill: "#cccccc" },
  };
  const style = styles[outcome];
  const padX = 10;
  const padY = 6;
  // Estimate text width from the label length so the badge sizes nicely.
  const charWidth = 7.2;
  const textWidth = style.label.length * charWidth;
  const w = textWidth + padX * 2;
  const h = 22;
  const x = SVG_WIDTH - w - 12;
  const y = 12;
  return [
    `  <g class="outcome-badge" data-outcome="${outcome}">`,
    `    <rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${h}" rx="4" ` +
    `fill="${style.fill}" opacity="0.92"/>`,
    `    <text x="${(x + w / 2).toFixed(2)}" y="${(y + h - padY).toFixed(2)}" ` +
    `text-anchor="middle" font-family="monospace" font-size="12" font-weight="bold" ` +
    `fill="#0b0b1a">${style.label}</text>`,
    `  </g>`,
  ].join("\n");
}
