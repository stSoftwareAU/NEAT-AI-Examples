/**
 * SVG rendering helpers for the Snake-game example.
 *
 * Produces a single animated SVG of the champion's playthrough. The
 * board is drawn as a checker-pattern grid; the snake's body is
 * rendered as a chain of rounded rectangles (head distinct from
 * body); the food cell pulses via opacity animation. Each segment's
 * `x` and `y` attributes are animated through SMIL keyframe lists
 * derived from the recorded trace, so the snake visibly grows as it
 * eats food.
 *
 * Limits to keep the file compact:
 *   - Frames are sub-sampled to {@link MAX_KEYFRAMES} entries.
 *   - The snake is rendered up to {@link MAX_SEGMENTS} segments; if it
 *     grows longer (rare, given grid-12 and 500-step caps) extra
 *     segments are simply not drawn.
 */
import type { Cell, SnakeState } from "./snake.ts";

/** SVG canvas width in user units. */
export const SVG_WIDTH = 480;

/** SVG canvas height in user units. */
export const SVG_HEIGHT = 520;

/** Pixel size of each grid cell. */
const CELL_SIZE = 32;

/** Pixel inset for body squares so they look slightly inset in their cell. */
const SEGMENT_INSET = 3;

/** Top margin reserved for the title row and score. */
const MARGIN_TOP = 40;

/** Total animation duration (seconds) for one full replay loop. */
export const ANIMATION_DURATION_SECONDS = 8;

/** Maximum number of trajectory keyframes baked into the SMIL value lists. */
export const MAX_KEYFRAMES = 120;

/** Maximum number of snake segments rendered. */
export const MAX_SEGMENTS = 64;

/** Colour used for the snake's head. */
const HEAD_COLOUR = "#f1c40f";

/** Colour used for the snake's body. */
const BODY_COLOUR = "#27ae60";

/** Alternating fill colours for the checker pattern. */
const CHECKER_LIGHT = "#f5f7fa";
const CHECKER_DARK = "#e3e8ef";

/** Food cell colour. */
const FOOD_COLOUR = "#e74c3c";

/** Convert a cell coordinate to its SVG-x position. */
function cellX(x: number): number {
  return x * CELL_SIZE;
}

/** Convert a cell coordinate to its SVG-y position. */
function cellY(y: number): number {
  return MARGIN_TOP + y * CELL_SIZE;
}

/**
 * Sub-sample the trace down to at most {@link MAX_KEYFRAMES} entries.
 * The first and final entries are always retained so a SMIL-disabled
 * preview shows a sensible static frame and the score counter ends on
 * the correct value.
 */
function sampleTrace(trace: SnakeState[]): SnakeState[] {
  if (trace.length <= MAX_KEYFRAMES) return trace.slice();
  const stride = Math.ceil(trace.length / MAX_KEYFRAMES);
  const samples: SnakeState[] = [];
  for (let i = 0; i < trace.length; i += stride) samples.push(trace[i]);
  if (samples[samples.length - 1] !== trace[trace.length - 1]) {
    samples.push(trace[trace.length - 1]);
  }
  return samples;
}

/** Return the cell occupied by segment `i` in `state`, or `undefined`. */
function segmentCell(state: SnakeState, i: number): Cell | undefined {
  return state.body[i];
}

/**
 * Render the champion's playthrough as an animated SVG. The trace
 * must contain at least one state. The first state is taken as the
 * static base pose so SMIL-disabled viewers see a sensible frame.
 */
export function renderRunSVG(trace: SnakeState[]): string {
  if (trace.length === 0) {
    throw new Error("trace must contain at least one state");
  }

  const samples = sampleTrace(trace);
  const first = samples[0];
  const final = samples[samples.length - 1];
  const gridSize = first.gridSize;
  const animDur = `${ANIMATION_DURATION_SECONDS}s`;
  // SMIL `repeatCount="indefinite"` for looping, `calcMode="discrete"`
  // so segments snap from cell to cell rather than slide through the
  // grid lines (matches the discrete game step semantics).
  const animationCommon = `dur="${animDur}" repeatCount="indefinite" ` +
    `calcMode="discrete" fill="freeze"`;

  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" ` +
      `width="${SVG_WIDTH}" height="${SVG_HEIGHT}" role="img" ` +
      `aria-label="Snake champion playthrough, animated through ${samples.length} keyframes">`,
  );
  lines.push(`  <title>Snake Champion Playthrough (animated)</title>`);
  lines.push(
    `  <desc>SMIL-animated SVG: a NEAT-AI controller plays Snake on a ${gridSize}×${gridSize} ` +
      `grid. The snake body grows whenever the head meets food. Loops every ` +
      `${ANIMATION_DURATION_SECONDS} seconds.</desc>`,
  );
  lines.push(`  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#1a2230"/>`);

  // Checker board background.
  lines.push(`  <g class="board">`);
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const fill = (x + y) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
      lines.push(
        `    <rect x="${cellX(x)}" y="${cellY(y)}" ` +
          `width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${fill}"/>`,
      );
    }
  }
  lines.push(`  </g>`);

  // Animated food cell — moves to a new keyframe each tick and pulses
  // via opacity animation.
  const foodXValues = samples.map((s) => (cellX(s.food.x) + SEGMENT_INSET).toFixed(0)).join(";");
  const foodYValues = samples.map((s) => (cellY(s.food.y) + SEGMENT_INSET).toFixed(0)).join(";");
  lines.push(
    `  <rect class="food" x="${(cellX(first.food.x) + SEGMENT_INSET).toFixed(0)}" ` +
      `y="${(cellY(first.food.y) + SEGMENT_INSET).toFixed(0)}" ` +
      `width="${CELL_SIZE - 2 * SEGMENT_INSET}" height="${CELL_SIZE - 2 * SEGMENT_INSET}" ` +
      `rx="6" ry="6" fill="${FOOD_COLOUR}" stroke="#922b21" stroke-width="1">`,
  );
  lines.push(`    <animate attributeName="x" values="${foodXValues}" ${animationCommon}/>`);
  lines.push(`    <animate attributeName="y" values="${foodYValues}" ${animationCommon}/>`);
  lines.push(
    `    <animate attributeName="opacity" values="1;0.55;1" ` +
      `dur="0.8s" repeatCount="indefinite" calcMode="linear"/>`,
  );
  lines.push(`  </rect>`);

  // Snake segments — render up to MAX_SEGMENTS; each animates its
  // `x`, `y`, and `opacity` via SMIL value lists.
  const maxObservedLength = Math.min(
    MAX_SEGMENTS,
    samples.reduce((m, s) => Math.max(m, s.body.length), 0),
  );

  for (let i = 0; i < maxObservedLength; i++) {
    // For each keyframe, emit the (x, y) for segment i if present, or
    // the head's position with opacity 0 if the segment does not yet
    // exist (so it pops into being when the snake grows).
    const xValues: string[] = [];
    const yValues: string[] = [];
    const opValues: string[] = [];
    let initialX = 0;
    let initialY = 0;
    let initialOp = 0;
    for (let k = 0; k < samples.length; k++) {
      const seg = segmentCell(samples[k], i);
      if (seg !== undefined) {
        const sx = cellX(seg.x) + SEGMENT_INSET;
        const sy = cellY(seg.y) + SEGMENT_INSET;
        xValues.push(sx.toFixed(0));
        yValues.push(sy.toFixed(0));
        opValues.push("1");
        if (k === 0) {
          initialX = sx;
          initialY = sy;
          initialOp = 1;
        }
      } else {
        // Segment not yet grown: hide off-grid.
        const head = samples[k].body[0] ?? samples[k].body[samples[k].body.length - 1];
        const sx = cellX(head.x) + SEGMENT_INSET;
        const sy = cellY(head.y) + SEGMENT_INSET;
        xValues.push(sx.toFixed(0));
        yValues.push(sy.toFixed(0));
        opValues.push("0");
      }
    }
    const fill = i === 0 ? HEAD_COLOUR : BODY_COLOUR;
    const stroke = i === 0 ? "#b7950b" : "#1e8449";
    const className = i === 0 ? "snake-head" : "snake-body";
    lines.push(
      `  <rect class="${className}" x="${initialX.toFixed(0)}" y="${initialY.toFixed(0)}" ` +
        `width="${CELL_SIZE - 2 * SEGMENT_INSET}" height="${CELL_SIZE - 2 * SEGMENT_INSET}" ` +
        `rx="6" ry="6" fill="${fill}" stroke="${stroke}" stroke-width="1" ` +
        `opacity="${initialOp}">`,
    );
    lines.push(`    <animate attributeName="x" values="${xValues.join(";")}" ${animationCommon}/>`);
    lines.push(`    <animate attributeName="y" values="${yValues.join(";")}" ${animationCommon}/>`);
    lines.push(
      `    <animate attributeName="opacity" values="${opValues.join(";")}" ${animationCommon}/>`,
    );
    lines.push(`  </rect>`);
  }

  // Title row: example label and final summary (static).
  lines.push(
    `  <text x="12" y="22" font-family="monospace" font-size="14" fill="#ecf0f1">` +
      `🐍 Snake · ${final.eaten} eaten · ${final.steps} steps · ` +
      `${final.dead ? "died" : "alive"}</text>`,
  );

  // Animated score counter. We emit one <text> overlay per distinct
  // score level reached during the playthrough: the first is visible
  // from `t=0`, each subsequent overlay flips to visible via a SMIL
  // `<set attributeName="display">` element timed to the moment the
  // snake eats. Combined, the overlays produce a counter that bumps
  // up live in step with the playthrough.
  const distinctScores: { eaten: number; tickIndex: number }[] = [];
  let lastEaten = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].eaten !== lastEaten) {
      distinctScores.push({ eaten: samples[i].eaten, tickIndex: i });
      lastEaten = samples[i].eaten;
    }
  }
  const totalTicks = Math.max(1, samples.length - 1);
  for (let idx = 0; idx < distinctScores.length; idx++) {
    const { eaten, tickIndex } = distinctScores[idx];
    const score = eaten * 100;
    const beginSeconds = (tickIndex / totalTicks) * ANIMATION_DURATION_SECONDS;
    // The first overlay starts visible; subsequent overlays start
    // hidden and become visible at their `begin` time. When the
    // animation loops we hide them again at `t=0` so the counter
    // resets cleanly.
    const initialDisplay = idx === 0 ? "inline" : "none";
    lines.push(
      `  <text class="score" x="${SVG_WIDTH - 12}" y="22" text-anchor="end" ` +
        `font-family="monospace" font-size="14" fill="#f1c40f" ` +
        `display="${initialDisplay}">` +
        `score ${score}`,
    );
    if (idx > 0) {
      // Show this overlay at the appropriate moment in every loop.
      lines.push(
        `    <set attributeName="display" to="inline" ` +
          `begin="${beginSeconds.toFixed(2)}s; ${
            (beginSeconds + ANIMATION_DURATION_SECONDS)
              .toFixed(2)
          }s" />`,
      );
      // Hide it at the start of each loop so the counter resets.
      lines.push(
        `    <set attributeName="display" to="none" ` +
          `begin="0s; ${ANIMATION_DURATION_SECONDS}s" />`,
      );
    } else if (distinctScores.length > 1) {
      // The first overlay must hide once a higher score appears.
      const nextBegin = (distinctScores[1].tickIndex / totalTicks) * ANIMATION_DURATION_SECONDS;
      lines.push(
        `    <set attributeName="display" to="none" ` +
          `begin="${nextBegin.toFixed(2)}s; ${
            (nextBegin + ANIMATION_DURATION_SECONDS).toFixed(2)
          }s" />`,
      );
      lines.push(
        `    <set attributeName="display" to="inline" ` +
          `begin="0s; ${ANIMATION_DURATION_SECONDS}s" />`,
      );
    }
    lines.push(`  </text>`);
  }

  // Score-pulse playhead under the counter — colour-shifts whenever
  // the snake has eaten anything, just for visual flourish.
  const colourValues = samples.map((s) => (s.eaten > 0 ? HEAD_COLOUR : "#bdc3c7")).join(";");
  lines.push(
    `  <rect class="score-pulse" x="${SVG_WIDTH - 70}" y="28" width="58" height="4" ` +
      `rx="2" ry="2" fill="${HEAD_COLOUR}">`,
  );
  lines.push(
    `    <animate attributeName="fill" values="${colourValues}" ${animationCommon}/>`,
  );
  lines.push(`  </rect>`);

  // Bottom playhead progress bar.
  const progressBarY = SVG_HEIGHT - 18;
  const progressBarLeft = 12;
  const progressBarWidth = SVG_WIDTH - 24;
  lines.push(
    `  <rect x="${progressBarLeft}" y="${progressBarY}" ` +
      `width="${progressBarWidth}" height="4" fill="#34495e" rx="2"/>`,
  );
  lines.push(
    `  <rect class="progress" x="${progressBarLeft}" y="${progressBarY}" ` +
      `width="0" height="4" fill="#f1c40f" rx="2">`,
  );
  lines.push(
    `    <animate attributeName="width" values="0;${progressBarWidth}" ` +
      `dur="${animDur}" repeatCount="indefinite" fill="freeze"/>`,
  );
  lines.push(`  </rect>`);

  lines.push(`</svg>`);
  lines.push("");
  return lines.join("\n");
}
