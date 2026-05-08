/**
 * SVG rendering helpers for the Maze Navigation example.
 *
 * Produces a single animated SVG of the champion's run. The maze
 * walls are drawn statically on a coloured floor; a circle representing
 * the agent moves along the recorded trajectory using SMIL `<animate>`
 * on `cx` / `cy`. A trailing dotted "footprint" polyline is drawn so
 * the path remains visible after the agent has reached the goal. The
 * goal cell pulses via an opacity animation when the agent arrives.
 */
import type { MazeState } from "./maze.ts";

/** Pixel size of each grid cell. */
const CELL_SIZE = 32;

/** Top margin reserved for the title row and step counter. */
const MARGIN_TOP = 40;

/** Side margin around the maze. */
const MARGIN_SIDE = 12;

/** Total animation duration (seconds) for one full replay loop. */
export const ANIMATION_DURATION_SECONDS = 8;

/** Maximum number of trajectory keyframes baked into the SMIL value lists. */
export const MAX_KEYFRAMES = 200;

/** Wall colour. */
const WALL_COLOUR = "#1f2933";

/** Floor (open cell) colour. */
const FLOOR_COLOUR = "#f5e9d3";

/** Floor secondary colour for the chequer pattern. */
const FLOOR_COLOUR_ALT = "#f0dfb8";

/** Start cell colour. */
const START_COLOUR = "#7ed6df";

/** Goal cell colour. */
const GOAL_COLOUR = "#e056fd";

/** Agent (circle) colour. */
const AGENT_COLOUR = "#ff7f50";

/** Footprint polyline colour. */
const FOOTPRINT_COLOUR = "#ff7f50";

/** Convert a cell x-coordinate to its SVG-x position. */
function cellLeft(x: number): number {
  return MARGIN_SIDE + x * CELL_SIZE;
}

/** Convert a cell y-coordinate to its SVG-y position. */
function cellTop(y: number): number {
  return MARGIN_TOP + y * CELL_SIZE;
}

/** Convert a cell coordinate to its SVG-centre x position. */
function cellCenterX(x: number): number {
  return cellLeft(x) + CELL_SIZE / 2;
}

/** Convert a cell coordinate to its SVG-centre y position. */
function cellCenterY(y: number): number {
  return cellTop(y) + CELL_SIZE / 2;
}

/**
 * Sub-sample the trace down to at most {@link MAX_KEYFRAMES} entries.
 * The first and final entries are always retained so a SMIL-disabled
 * preview shows a sensible static frame and the step counter ends on
 * the correct value.
 */
function sampleTrace(trace: MazeState[]): MazeState[] {
  if (trace.length <= MAX_KEYFRAMES) return trace.slice();
  const stride = Math.ceil(trace.length / MAX_KEYFRAMES);
  const samples: MazeState[] = [];
  for (let i = 0; i < trace.length; i += stride) samples.push(trace[i]);
  if (samples[samples.length - 1] !== trace[trace.length - 1]) {
    samples.push(trace[trace.length - 1]);
  }
  return samples;
}

/**
 * Render the champion's run as an animated SVG. The trace must
 * contain at least one state. The first state is taken as the static
 * base pose so SMIL-disabled viewers see a sensible frame.
 */
export function renderRunSVG(trace: MazeState[]): string {
  if (trace.length === 0) {
    throw new Error("trace must contain at least one state");
  }

  const samples = sampleTrace(trace);
  const first = samples[0];
  const final = samples[samples.length - 1];
  const maze = first.maze;
  const animDur = `${ANIMATION_DURATION_SECONDS}s`;
  const animationCommon = `dur="${animDur}" repeatCount="indefinite" ` +
    `calcMode="discrete" fill="freeze"`;

  const svgWidth = maze.width * CELL_SIZE + MARGIN_SIDE * 2;
  const svgHeight = MARGIN_TOP + maze.height * CELL_SIZE + 28;

  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" ` +
      `width="${svgWidth}" height="${svgHeight}" role="img" ` +
      `aria-label="Maze navigation champion run, animated through ${samples.length} keyframes">`,
  );
  lines.push(`  <title>Maze Navigation Champion Run (animated)</title>`);
  lines.push(
    `  <desc>SMIL-animated SVG: a NEAT-AI agent navigates a ${maze.width}×${maze.height} grid ` +
      `maze from start (S) to goal (G). The agent's footsteps are traced as a dotted polyline. ` +
      `Loops every ${ANIMATION_DURATION_SECONDS} seconds.</desc>`,
  );
  lines.push(`  <rect width="${svgWidth}" height="${svgHeight}" fill="#2c3e50"/>`);

  // Floor — chequered for visual interest, drawn before walls.
  lines.push(`  <g class="floor">`);
  for (let y = 0; y < maze.height; y++) {
    for (let x = 0; x < maze.width; x++) {
      const fill = (x + y) % 2 === 0 ? FLOOR_COLOUR : FLOOR_COLOUR_ALT;
      lines.push(
        `    <rect x="${cellLeft(x)}" y="${cellTop(y)}" ` +
          `width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${fill}"/>`,
      );
    }
  }
  lines.push(`  </g>`);

  // Start cell highlight.
  lines.push(
    `  <rect class="start" x="${cellLeft(maze.start.x)}" y="${cellTop(maze.start.y)}" ` +
      `width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${START_COLOUR}" opacity="0.55"/>`,
  );
  lines.push(
    `  <text x="${cellCenterX(maze.start.x)}" y="${cellCenterY(maze.start.y) + 5}" ` +
      `text-anchor="middle" font-family="monospace" font-size="14" font-weight="bold" ` +
      `fill="#1a2230">S</text>`,
  );

  // Goal cell — base rect, then a pulsing overlay that animates its
  // opacity once the agent reaches the goal.
  lines.push(
    `  <rect class="goal" x="${cellLeft(maze.goal.x)}" y="${cellTop(maze.goal.y)}" ` +
      `width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${GOAL_COLOUR}" opacity="0.65"/>`,
  );
  lines.push(
    `  <rect class="goal-pulse" x="${cellLeft(maze.goal.x)}" y="${cellTop(maze.goal.y)}" ` +
      `width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${GOAL_COLOUR}" opacity="0">`,
  );
  lines.push(
    `    <animate attributeName="opacity" values="0;0.85;0" ` +
      `dur="0.9s" repeatCount="indefinite" calcMode="linear"/>`,
  );
  lines.push(`  </rect>`);
  lines.push(
    `  <text x="${cellCenterX(maze.goal.x)}" y="${cellCenterY(maze.goal.y) + 5}" ` +
      `text-anchor="middle" font-family="monospace" font-size="14" font-weight="bold" ` +
      `fill="#1a2230">G</text>`,
  );

  // Walls — drawn over the floor.
  lines.push(`  <g class="walls">`);
  for (let y = 0; y < maze.height; y++) {
    for (let x = 0; x < maze.width; x++) {
      if (maze.walls[y * maze.width + x]) {
        lines.push(
          `    <rect x="${cellLeft(x)}" y="${cellTop(y)}" ` +
            `width="${CELL_SIZE}" height="${CELL_SIZE}" fill="${WALL_COLOUR}"/>`,
        );
      }
    }
  }
  lines.push(`  </g>`);

  // Trailing footprint polyline — lays down the agent's full path so
  // the trail remains visible once the run completes.
  const polylinePoints = samples
    .map((s) => `${cellCenterX(s.position.x)},${cellCenterY(s.position.y)}`)
    .join(" ");
  lines.push(
    `  <polyline class="footprint" points="${polylinePoints}" fill="none" ` +
      `stroke="${FOOTPRINT_COLOUR}" stroke-width="3" stroke-linecap="round" ` +
      `stroke-linejoin="round" stroke-dasharray="2 6" opacity="0.85"/>`,
  );

  // Agent — circle that snaps from cell to cell using SMIL keyframes.
  const cxValues = samples.map((s) => cellCenterX(s.position.x).toFixed(0)).join(";");
  const cyValues = samples.map((s) => cellCenterY(s.position.y).toFixed(0)).join(";");
  lines.push(
    `  <circle class="agent" cx="${cellCenterX(first.position.x)}" ` +
      `cy="${cellCenterY(first.position.y)}" r="${CELL_SIZE / 3}" ` +
      `fill="${AGENT_COLOUR}" stroke="#a04030" stroke-width="2">`,
  );
  lines.push(`    <animate attributeName="cx" values="${cxValues}" ${animationCommon}/>`);
  lines.push(`    <animate attributeName="cy" values="${cyValues}" ${animationCommon}/>`);
  lines.push(`  </circle>`);

  // Title row — example label and final summary (static).
  const verdict = final.reached ? "reached goal" : "did not reach goal";
  lines.push(
    `  <text x="12" y="22" font-family="monospace" font-size="14" fill="#ecf0f1">` +
      `🗺️ Maze · ${final.steps} steps · ${verdict}</text>`,
  );

  // Bottom playhead progress bar — sweeps left-to-right over the loop.
  const progressBarY = svgHeight - 18;
  const progressBarLeft = MARGIN_SIDE;
  const progressBarWidth = svgWidth - MARGIN_SIDE * 2;
  lines.push(
    `  <rect x="${progressBarLeft}" y="${progressBarY}" ` +
      `width="${progressBarWidth}" height="4" fill="#34495e" rx="2"/>`,
  );
  lines.push(
    `  <rect class="progress" x="${progressBarLeft}" y="${progressBarY}" ` +
      `width="0" height="4" fill="${AGENT_COLOUR}" rx="2">`,
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
