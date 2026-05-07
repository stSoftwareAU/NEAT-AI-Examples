/**
 * SVG rendering helpers for the cart-pole example.
 *
 * Produces a single animated SVG of the champion's run. The cart and
 * pole primitives carry SMIL `<animate>` elements driven by a sampled
 * sequence of keyframes from the trace, so when the SVG is loaded in
 * any modern browser (or rendered on GitHub) the cart slides and the
 * pole oscillates through the actual recorded states. Static viewers
 * still see the initial frame thanks to the base attribute values, so
 * accessibility and screenshot tools degrade gracefully.
 */
import type { CartPoleState } from "./physics.ts";

/** Width (in SVG user units) of the rendered animated scene. */
export const FRAME_WIDTH = 480;

/** Height of the scene, including headroom for the swinging pole. */
export const FRAME_HEIGHT = 320;

/** Half-width of the visible track (m), used to map state.x → pixels. */
const TRACK_HALF_WIDTH = 2.4;

/** Pixel length of the rendered pole. */
const POLE_PIXELS = 140;

/** Total animation duration (seconds) for one full replay. */
export const ANIMATION_DURATION_SECONDS = 6;

interface ProjectedFrame {
  cartLeft: number;
  cartCentre: number;
  poleTopX: number;
  poleTopY: number;
  step: number;
}

/**
 * Render an animated SVG of a cart-pole run.
 *
 * @param trace Sequential states captured during the run.
 * @param frameCount Number of evenly-spaced keyframes sampled from the
 *   trace for the SMIL animation. Larger values produce smoother
 *   motion. A value of 1 renders a single static state; values greater
 *   than `trace.length` are clamped.
 */
export function renderRunSVG(
  trace: CartPoleState[],
  frameCount: number,
): string {
  if (trace.length === 0) {
    throw new Error("trace must contain at least one state");
  }
  const frames = Math.min(Math.max(1, frameCount), trace.length);

  const sampledIndices: number[] = [];
  if (frames === 1) {
    sampledIndices.push(0);
  } else {
    for (let i = 0; i < frames; i++) {
      const idx = Math.round((i * (trace.length - 1)) / (frames - 1));
      sampledIndices.push(idx);
    }
  }

  const projected: ProjectedFrame[] = sampledIndices.map((traceIdx) =>
    projectFrame(trace[traceIdx], traceIdx)
  );

  const groundY = FRAME_HEIGHT - 60;
  const cartTop = groundY - 28;
  const trackLeft = 30;
  const trackRight = FRAME_WIDTH - 30;

  // Build SMIL value lists. Static viewers (or SMIL-disabled renderers)
  // see the first sampled state as the base attribute value.
  const first = projected[0];
  const last = projected[projected.length - 1];
  const cartLeftValues = projected.map((p) => p.cartLeft.toFixed(2)).join(";");
  const cartCentreValues = projected.map((p) => p.cartCentre.toFixed(2)).join(";");
  const poleTopXValues = projected.map((p) => p.poleTopX.toFixed(2)).join(";");
  const poleTopYValues = projected.map((p) => p.poleTopY.toFixed(2)).join(";");

  const animDur = `${ANIMATION_DURATION_SECONDS}s`;
  // Linear interpolation between sampled states. Single-frame traces
  // fall back to a no-op animation that keeps the static pose in place.
  const calcMode = frames > 1 ? "linear" : "discrete";
  const animationCommon =
    `dur="${animDur}" repeatCount="indefinite" calcMode="${calcMode}" fill="freeze"`;

  // Progress bar: a small rectangle whose width sweeps left-to-right
  // each loop, giving viewers a play-head indicator.
  const progressBarY = FRAME_HEIGHT - 18;
  const progressBarW = trackRight - trackLeft;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}" ` +
    `width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" role="img" ` +
    `aria-label="Cart-pole champion run, animated through ${frames} keyframes">`,
    `  <title>Cart-Pole Champion Run (animated)</title>`,
    `  <desc>SMIL-animated SVG: the cart slides along the track and the pole ` +
    `oscillates through the recorded champion trajectory, looping every ` +
    `${ANIMATION_DURATION_SECONDS} seconds.</desc>`,
    `  <rect width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="#fafafa"/>`,
    `  <rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" ` +
    `fill="none" stroke="#cccccc"/>`,
    // Track.
    `  <line x1="${trackLeft}" y1="${groundY}" x2="${trackRight}" y2="${groundY}" ` +
    `stroke="#888888" stroke-width="2"/>`,
    // Cart body — animates its `x` attribute through the projected positions.
    `  <rect class="cart" x="${first.cartLeft.toFixed(2)}" y="${cartTop}" ` +
    `width="60" height="28" fill="#4a90d9" stroke="#1f4d80">`,
    `    <animate attributeName="x" values="${cartLeftValues}" ${animationCommon}/>`,
    `  </rect>`,
    // Pole — SMIL animates the bottom (x1) and top (x2,y2) endpoints.
    `  <line class="pole" x1="${first.cartCentre.toFixed(2)}" y1="${cartTop}" ` +
    `x2="${first.poleTopX.toFixed(2)}" y2="${first.poleTopY.toFixed(2)}" ` +
    `stroke="#e74c3c" stroke-width="8" stroke-linecap="round">`,
    `    <animate attributeName="x1" values="${cartCentreValues}" ${animationCommon}/>`,
    `    <animate attributeName="x2" values="${poleTopXValues}" ${animationCommon}/>`,
    `    <animate attributeName="y2" values="${poleTopYValues}" ${animationCommon}/>`,
    `  </line>`,
    // Hub: pivot point at the top centre of the cart.
    `  <circle class="hub" cx="${first.cartCentre.toFixed(2)}" cy="${cartTop}" ` +
    `r="5" fill="#1f4d80">`,
    `    <animate attributeName="cx" values="${cartCentreValues}" ${animationCommon}/>`,
    `  </circle>`,
    // Frame label: shows starting and ending step counts so static
    // viewers know what range the animation spans.
    `  <text x="12" y="22" font-family="monospace" font-size="13" fill="#444">` +
    `step ${first.step} → ${last.step}</text>`,
    // Static caption to make the loop length clear.
    `  <text x="${FRAME_WIDTH - 12}" y="22" text-anchor="end" font-family="sans-serif" ` +
    `font-size="11" fill="#888">animated · loops every ${ANIMATION_DURATION_SECONDS}s</text>`,
    // Background for progress bar.
    `  <rect x="${trackLeft}" y="${progressBarY}" width="${progressBarW}" height="4" ` +
    `fill="#e0e0e0" rx="2"/>`,
    // Sweeping progress fill.
    `  <rect class="progress" x="${trackLeft}" y="${progressBarY}" width="0" height="4" ` +
    `fill="#4a90d9" rx="2">`,
    `    <animate attributeName="width" values="0;${progressBarW}" ` +
    `dur="${animDur}" repeatCount="indefinite" fill="freeze"/>`,
    `  </rect>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** Project a single trace state into screen coordinates. */
function projectFrame(state: CartPoleState, traceIdx: number): ProjectedFrame {
  const groundY = FRAME_HEIGHT - 60;
  const cartTop = groundY - 28;
  const cartCentre = FRAME_WIDTH / 2 +
    (state.x / TRACK_HALF_WIDTH) * (FRAME_WIDTH / 2 - 60);
  const cartLeft = cartCentre - 30;
  const poleTopX = cartCentre + Math.sin(state.theta) * POLE_PIXELS;
  const poleTopY = cartTop - Math.cos(state.theta) * POLE_PIXELS;
  return { cartLeft, cartCentre, poleTopX, poleTopY, step: traceIdx };
}
