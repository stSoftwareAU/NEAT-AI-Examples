/**
 * Deterministic Snake game model.
 *
 * A pure-TypeScript port of the classic grid-based Snake game. The
 * snake occupies a fixed-size square grid and advances one cell per
 * tick along its current heading. Eating food grows the snake by one
 * segment; running into a wall or its own body ends the episode.
 *
 * Coordinate system:
 *   - `(x, y)` are integer cell coordinates with `(0, 0)` in the
 *     top-left corner. `x` increases rightward, `y` increases downward
 *     (matching SVG conventions, so the renderer is trivial).
 *   - Headings are encoded as one of `Heading.Up`, `Heading.Right`,
 *     `Heading.Down`, `Heading.Left`.
 *
 * Update rules:
 *   - The snake's body is an array of cells; index 0 is the head.
 *   - Each tick the head advances one cell along the new heading. A
 *     180° reversal request is rejected and the previous heading is
 *     used instead, matching the canonical Snake gameplay.
 *   - If the new head cell holds food, the snake grows by one segment
 *     (the tail is not removed) and a new food cell is spawned via the
 *     seeded PRNG. Otherwise the tail is removed so the body length
 *     stays constant.
 *   - The episode ends when the head is outside the grid or collides
 *     with another body cell.
 *
 * Pure functions only — no globals, no hidden timers — so two runs
 * with the same seed produce byte-identical traces.
 */

/** Cardinal headings the snake can move in. Values match `[Δx, Δy]`. */
export enum Heading {
  Up = 0,
  Right = 1,
  Down = 2,
  Left = 3,
}

/** Translation vector for a heading: `[Δx, Δy]`. */
export const HEADING_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** A single grid cell. */
export interface Cell {
  x: number;
  y: number;
}

/** Immutable snapshot of a Snake game state. */
export interface SnakeState {
  /** Side-length of the square grid (in cells). */
  gridSize: number;
  /** Snake body, head at index 0, tail at the last index. */
  body: ReadonlyArray<Cell>;
  /** Current heading. */
  heading: Heading;
  /** Cell holding food (always strictly inside the grid). */
  food: Cell;
  /** True once the snake has died (wall or self collision). */
  dead: boolean;
  /** Number of food items eaten this episode. */
  eaten: number;
  /** Number of ticks executed since `initialState`. */
  steps: number;
}

/** Default grid side length — 12×12 keeps episodes short and visible. */
export const DEFAULT_GRID_SIZE = 12;

/** Default initial snake length. */
export const DEFAULT_INITIAL_LENGTH = 3;

/**
 * Build the initial Snake state. The snake is centred horizontally
 * with its head pointing right, so a small linear tail trails behind
 * it (centre column, three cells wide). Food is placed at a fixed
 * deterministic location for the very first tick; subsequent food
 * spawns flow through the supplied `random()` PRNG.
 */
export function initialState(
  gridSize: number = DEFAULT_GRID_SIZE,
  initialLength: number = DEFAULT_INITIAL_LENGTH,
): SnakeState {
  if (gridSize < 4) {
    throw new Error(`gridSize must be at least 4, got ${gridSize}`);
  }
  if (initialLength < 1 || initialLength >= gridSize) {
    throw new Error(
      `initialLength must be in [1, gridSize), got ${initialLength}`,
    );
  }
  const midY = Math.floor(gridSize / 2);
  const headX = Math.floor(gridSize / 2) + Math.floor(initialLength / 2);
  const body: Cell[] = [];
  for (let i = 0; i < initialLength; i++) {
    body.push({ x: headX - i, y: midY });
  }
  // Default food cell: a deterministic location well clear of the
  // snake so the first tick has a meaningful gradient. Placed three
  // rows below the snake.
  const food: Cell = { x: Math.floor(gridSize / 2), y: midY + 3 };
  return {
    gridSize,
    body,
    heading: Heading.Right,
    food,
    dead: false,
    eaten: 0,
    steps: 0,
  };
}

/**
 * Returns true when `a` and `b` cover the same grid cell.
 */
export function cellsEqual(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Returns true when `cell` is on the grid (`0 <= x, y < gridSize`).
 */
export function inBounds(cell: Cell, gridSize: number): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < gridSize && cell.y < gridSize;
}

/**
 * Test whether the candidate heading would reverse the snake's
 * current direction (a 180° turn). Snake gameplay rejects this so
 * the snake cannot collide with its own neck.
 */
export function isReverse(current: Heading, candidate: Heading): boolean {
  return ((current + 2) % 4) === candidate;
}

/**
 * Pick a fresh food cell uniformly at random from cells not occupied
 * by the snake body. Falls back to the first free cell scanned in
 * row-major order if the random pick lands on the snake (this can
 * only happen when the grid is densely covered, e.g. snake fills more
 * than half of it). When the grid has no free cells the existing
 * food position is reused — the calling code never reaches this
 * branch in practice because filling the grid means the snake won.
 */
export function spawnFood(
  state: Pick<SnakeState, "gridSize" | "body">,
  random: () => number,
): Cell {
  const { gridSize, body } = state;
  const occupied = new Set<string>();
  for (const cell of body) occupied.add(`${cell.x},${cell.y}`);

  // Try a random pick first.
  for (let attempt = 0; attempt < 32; attempt++) {
    const x = Math.floor(random() * gridSize);
    const y = Math.floor(random() * gridSize);
    if (!occupied.has(`${x},${y}`)) {
      return { x, y };
    }
  }
  // Deterministic fallback — scan the grid in row-major order.
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (!occupied.has(`${x},${y}`)) {
        return { x, y };
      }
    }
  }
  // Snake fills the entire grid: keep food where it was. The caller
  // would treat this as a "won the game" terminal state.
  return { x: body[0].x, y: body[0].y };
}

/**
 * Advance the simulation by one tick.
 *
 * @param state    Current state. Treated as immutable.
 * @param desired  Heading the agent wants to take. If it would reverse
 *                 the current heading the request is ignored and the
 *                 snake keeps moving in `state.heading`.
 * @param random   Seeded PRNG used when food needs to respawn.
 * @returns The state after one tick. The input is not mutated.
 */
export function step(
  state: SnakeState,
  desired: Heading,
  random: () => number,
): SnakeState {
  if (state.dead) return state;

  const heading = isReverse(state.heading, desired) ? state.heading : desired;
  const [dx, dy] = HEADING_DELTAS[heading];
  const head = state.body[0];
  const newHead: Cell = { x: head.x + dx, y: head.y + dy };

  // Wall collision.
  if (!inBounds(newHead, state.gridSize)) {
    return { ...state, heading, dead: true, steps: state.steps + 1 };
  }

  const ate = cellsEqual(newHead, state.food);
  // Build the next body. If we did not eat, drop the tail before
  // collision-checking — the cell the tail is leaving becomes free
  // again so a snake can chase its own tail safely.
  const nextBody: Cell[] = [newHead, ...state.body];
  if (!ate) nextBody.pop();

  // Self collision: the head matches any other body cell.
  for (let i = 1; i < nextBody.length; i++) {
    if (cellsEqual(newHead, nextBody[i])) {
      return { ...state, heading, dead: true, steps: state.steps + 1 };
    }
  }

  let food = state.food;
  let eaten = state.eaten;
  if (ate) {
    eaten += 1;
    food = spawnFood({ gridSize: state.gridSize, body: nextBody }, random);
  }

  return {
    gridSize: state.gridSize,
    body: nextBody,
    heading,
    food,
    dead: false,
    eaten,
    steps: state.steps + 1,
  };
}

/**
 * Build the initial state and place food via `random()` so episodes
 * are reproducible from a single seed (the default `initialState`
 * uses a deterministic placeholder food cell so the very first call
 * needs no PRNG).
 */
export function newGame(
  random: () => number,
  gridSize: number = DEFAULT_GRID_SIZE,
  initialLength: number = DEFAULT_INITIAL_LENGTH,
): SnakeState {
  const state = initialState(gridSize, initialLength);
  const food = spawnFood(state, random);
  return { ...state, food };
}
