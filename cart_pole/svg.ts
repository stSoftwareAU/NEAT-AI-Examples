/**
 * SVG rendering helpers for the cart-pole example.
 *
 * Produces a single horizontal strip showing several evenly-spaced
 * frames from a champion's run. The same primitive (one frame group)
 * is repeated, so the strip stays cheap to generate and easy to read
 * compared with the rustneat animated GIF that inspired this example.
 */
import type { CartPoleState } from "./physics.ts";

/** Width (in SVG user units) used for a single frame in the strip. */
export const FRAME_WIDTH = 180;

/** Height of one frame, including the headroom for the swinging pole. */
export const FRAME_HEIGHT = 220;

/** Half-width of the visible track (m), used to map state.x → pixels. */
const TRACK_HALF_WIDTH = 2.4;

/** Pixel length of the rendered pole. */
const POLE_PIXELS = 90;

/**
 * Render a multi-frame SVG strip of a cart-pole run.
 *
 * @param trace Sequential states captured during the run.
 * @param frameCount Number of evenly-spaced frames to draw. A value of
 *   1 renders only the first state; values greater than `trace.length`
 *   are clamped to `trace.length`.
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

  const svgWidth = FRAME_WIDTH * frames;
  const svgHeight = FRAME_HEIGHT;

  const groups = sampledIndices.map((traceIdx, frameIdx) =>
    renderFrameGroup(trace[traceIdx], traceIdx, frameIdx)
  ).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" ` +
    `width="${svgWidth}" height="${svgHeight}" role="img" ` +
    `aria-label="Cart-pole champion run, ${frames} frames">\n` +
    `  <title>Cart-Pole Champion Run</title>\n` +
    `  <rect width="${svgWidth}" height="${svgHeight}" fill="#fafafa"/>\n` +
    `${groups}\n` +
    `</svg>\n`;
}

/** Render a single cart-pole frame as a `<g>` element. */
function renderFrameGroup(
  state: CartPoleState,
  traceIdx: number,
  frameIdx: number,
): string {
  const xOffset = frameIdx * FRAME_WIDTH;
  const groundY = FRAME_HEIGHT - 40;
  const cartCentre = FRAME_WIDTH / 2 +
    (state.x / TRACK_HALF_WIDTH) * (FRAME_WIDTH / 2 - 30);
  const cartTop = groundY - 20;
  const poleTopX = cartCentre + Math.sin(state.theta) * POLE_PIXELS;
  const poleTopY = cartTop - Math.cos(state.theta) * POLE_PIXELS;

  return [
    `  <g class="frame" data-frame="${frameIdx}" data-step="${traceIdx}" ` +
    `transform="translate(${xOffset},0)">`,
    `    <rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" ` +
    `fill="none" stroke="#cccccc"/>`,
    `    <line x1="20" y1="${groundY}" x2="${FRAME_WIDTH - 20}" y2="${groundY}" ` +
    `stroke="#888888" stroke-width="2"/>`,
    `    <rect x="${cartCentre - 30}" y="${cartTop}" width="60" height="20" ` +
    `fill="#4a90d9" stroke="#1f4d80"/>`,
    `    <line x1="${cartCentre.toFixed(2)}" y1="${cartTop}" ` +
    `x2="${poleTopX.toFixed(2)}" y2="${poleTopY.toFixed(2)}" ` +
    `stroke="#e74c3c" stroke-width="6" stroke-linecap="round"/>`,
    `    <circle cx="${cartCentre.toFixed(2)}" cy="${cartTop}" r="4" fill="#1f4d80"/>`,
    `    <text x="6" y="14" font-family="monospace" font-size="10" fill="#444">step ${traceIdx}</text>`,
    `  </g>`,
  ].join("\n");
}
