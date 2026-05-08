/**
 * Deterministic grid-maze model.
 *
 * A pure-TypeScript maze the NEAT-AI agent has to navigate from a
 * fixed start cell to a fixed goal cell. The layout is encoded as a
 * string-art template so it can be reviewed at a glance and altered
 * without touching code.
 *
 * Coordinate system:
 *   - `(x, y)` are integer cell coordinates with `(0, 0)` in the
 *     top-left corner. `x` increases rightward, `y` increases downward
 *     (matching SVG conventions, so the renderer is trivial).
 *
 * Step semantics:
 *   - Each tick the agent picks one of {@link Action.North},
 *     {@link Action.East}, {@link Action.South}, {@link Action.West},
 *     or {@link Action.Stay}.
 *   - The agent moves one cell in the chosen direction unless the
 *     destination is a wall or off-grid; in either case the agent
 *     stays put. {@link Action.Stay} also leaves the agent in place.
 *
 * Pure functions only — no globals, no hidden timers — so two runs
 * with the same seed produce byte-identical traces.
 */

/** Cardinal actions plus a no-op. */
export enum Action {
  North = 0,
  East = 1,
  South = 2,
  West = 3,
  Stay = 4,
}

/** Translation vector for each action: `[Δx, Δy]`. */
export const ACTION_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, 0],
];

/** A single grid cell. */
export interface Cell {
  x: number;
  y: number;
}

/** Immutable maze layout — walls plus start and goal cells. */
export interface Maze {
  /** Width of the grid in cells. */
  width: number;
  /** Height of the grid in cells. */
  height: number;
  /** Row-major wall mask: `walls[y * width + x] === true` ⇒ wall cell. */
  walls: ReadonlyArray<boolean>;
  /** Start cell — the agent begins here every episode. */
  start: Cell;
  /** Goal cell — the agent wins when it reaches this cell. */
  goal: Cell;
}

/** Immutable snapshot of an in-progress maze run. */
export interface MazeState {
  maze: Maze;
  /** Current agent position. */
  position: Cell;
  /** True once the agent has reached the goal cell. */
  reached: boolean;
  /** Number of ticks executed since `initialState`. */
  steps: number;
}

/**
 * Default 12×12 maze layout. `S` marks the start, `G` the goal, `#`
 * walls and `.` open cells. The layout is an L-shaped corridor that
 * forces the agent to go east first, then south — a small linear
 * policy (no hidden layer) can pick this up in a few generations
 * while the path is still long enough to give the SVG room to
 * breathe.
 */
export const DEFAULT_LAYOUT: ReadonlyArray<string> = [
  "############",
  "#S.........#",
  "##########.#",
  "##########.#",
  "##########.#",
  "##########.#",
  "##########.#",
  "##########.#",
  "##########.#",
  "##########.#",
  "##########G#",
  "############",
];

/**
 * Parse a string-art layout into a {@link Maze}. Every row must have
 * the same length. Exactly one `S` and one `G` are required.
 */
export function parseMaze(layout: ReadonlyArray<string>): Maze {
  if (layout.length === 0) {
    throw new Error("layout must contain at least one row");
  }
  const width = layout[0].length;
  const height = layout.length;
  for (const row of layout) {
    if (row.length !== width) {
      throw new Error(
        `every layout row must be ${width} characters wide, got ${row.length}: "${row}"`,
      );
    }
  }
  const walls: boolean[] = new Array(width * height).fill(false);
  let start: Cell | undefined;
  let goal: Cell | undefined;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = layout[y][x];
      switch (ch) {
        case "#":
          walls[y * width + x] = true;
          break;
        case "S":
          if (start) throw new Error("layout must contain exactly one start cell (S)");
          start = { x, y };
          break;
        case "G":
          if (goal) throw new Error("layout must contain exactly one goal cell (G)");
          goal = { x, y };
          break;
        case ".":
          break;
        default:
          throw new Error(`unrecognised layout character "${ch}" at (${x}, ${y})`);
      }
    }
  }
  if (!start) throw new Error("layout must contain a start cell (S)");
  if (!goal) throw new Error("layout must contain a goal cell (G)");
  return { width, height, walls, start, goal };
}

/** The default 12×12 maze used by the runner and renderer. */
export function defaultMaze(): Maze {
  return parseMaze(DEFAULT_LAYOUT);
}

/** Returns true when `(x, y)` is on the grid. */
export function inBounds(maze: Maze, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < maze.width && y < maze.height;
}

/** Returns true when `(x, y)` is a wall cell. Off-grid counts as a wall. */
export function isWall(maze: Maze, x: number, y: number): boolean {
  if (!inBounds(maze, x, y)) return true;
  return maze.walls[y * maze.width + x];
}

/** Returns true when `a` and `b` cover the same grid cell. */
export function cellsEqual(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Manhattan distance between `a` and `b`. */
export function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Build the initial state — agent at the maze's start cell. */
export function initialState(maze: Maze): MazeState {
  return {
    maze,
    position: { x: maze.start.x, y: maze.start.y },
    reached: cellsEqual(maze.start, maze.goal),
    steps: 0,
  };
}

/**
 * Advance the simulation by one tick. The agent attempts to move in
 * the requested direction; if the destination is a wall or off-grid
 * the position stays unchanged.
 */
export function step(state: MazeState, action: Action): MazeState {
  if (state.reached) return state;
  const [dx, dy] = ACTION_DELTAS[action];
  const tx = state.position.x + dx;
  const ty = state.position.y + dy;
  const blocked = isWall(state.maze, tx, ty);
  const next: Cell = blocked ? { x: state.position.x, y: state.position.y } : { x: tx, y: ty };
  return {
    maze: state.maze,
    position: next,
    reached: cellsEqual(next, state.maze.goal),
    steps: state.steps + 1,
  };
}

/**
 * Wall distance from `(x, y)` along `(dx, dy)` — number of free cells
 * the agent could move through before bumping into a wall (or the
 * grid boundary). The starting cell itself is not counted.
 */
export function wallDistance(
  maze: Maze,
  x: number,
  y: number,
  dx: number,
  dy: number,
  cap: number,
): number {
  let distance = 0;
  let cx = x + dx;
  let cy = y + dy;
  while (distance < cap && !isWall(maze, cx, cy)) {
    distance += 1;
    cx += dx;
    cy += dy;
  }
  return distance;
}
