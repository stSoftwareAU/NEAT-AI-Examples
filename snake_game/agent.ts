/**
 * Snake-game agent: sensor encoding and action decoding.
 *
 * The controller observes the world through a small sensor pack of
 * eight floating-point values (well below the issue's 12-input
 * budget). Outputs are four logistic activations — one per heading —
 * and the agent commits to the argmax over those scores every tick.
 *
 * Sensor channels (all clamped to friendly numerical ranges):
 *   0. Wall distance forward — cells of free space in front of the
 *      head along the current heading, normalised by `gridSize`.
 *   1. Wall distance to the snake's left.
 *   2. Wall distance to the snake's right.
 *   3. Food Δx — `(food.x − head.x) / gridSize` (signed).
 *   4. Food Δy — `(food.y − head.y) / gridSize` (signed).
 *   5. Tail Δx — `(tail.x − head.x) / gridSize` (signed).
 *   6. Tail Δy — `(tail.y − head.y) / gridSize` (signed).
 *   7. Length — `body.length / (gridSize · gridSize)`.
 */
import { Heading, HEADING_DELTAS, type SnakeState } from "./snake.ts";

/** Number of sensor inputs fed to the controller. */
export const INPUT_COUNT = 8;

/** Number of action outputs (one per heading). */
export const OUTPUT_COUNT = 4;

/** Headings in argmax order for {@link decodeAction}. */
export const ACTION_HEADINGS: ReadonlyArray<Heading> = [
  Heading.Up,
  Heading.Right,
  Heading.Down,
  Heading.Left,
];

/**
 * Compute the integer wall distance from `(x, y)` along `(dx, dy)` —
 * how many free cells the snake could move forward before hitting the
 * grid boundary or its own body. Used for the three "vision" sensors.
 */
function wallDistance(
  state: SnakeState,
  startX: number,
  startY: number,
  dx: number,
  dy: number,
): number {
  // Build a set of body cells (excluding the head) so the distance
  // counts the snake as a wall.
  const blocked = new Set<string>();
  for (let i = 1; i < state.body.length; i++) {
    blocked.add(`${state.body[i].x},${state.body[i].y}`);
  }
  let distance = 0;
  let x = startX + dx;
  let y = startY + dy;
  while (x >= 0 && y >= 0 && x < state.gridSize && y < state.gridSize) {
    if (blocked.has(`${x},${y}`)) break;
    distance += 1;
    x += dx;
    y += dy;
  }
  return distance;
}

/** Heading 90° to the snake's left of `current`. */
export function headingLeft(current: Heading): Heading {
  return ((current + 3) % 4) as Heading;
}

/** Heading 90° to the snake's right of `current`. */
export function headingRight(current: Heading): Heading {
  return ((current + 1) % 4) as Heading;
}

/**
 * Encode a {@link SnakeState} as a Float32Array of {@link INPUT_COUNT}
 * sensor values. Values are normalised so the network sees inputs in
 * a comparable range regardless of grid size.
 */
export function encodeState(state: SnakeState): Float32Array {
  const head = state.body[0];
  const tail = state.body[state.body.length - 1];
  const grid = state.gridSize;

  const forward = HEADING_DELTAS[state.heading];
  const left = HEADING_DELTAS[headingLeft(state.heading)];
  const right = HEADING_DELTAS[headingRight(state.heading)];

  const wallForward = wallDistance(state, head.x, head.y, forward[0], forward[1]) / grid;
  const wallLeft = wallDistance(state, head.x, head.y, left[0], left[1]) / grid;
  const wallRight = wallDistance(state, head.x, head.y, right[0], right[1]) / grid;

  const foodDx = (state.food.x - head.x) / grid;
  const foodDy = (state.food.y - head.y) / grid;

  const tailDx = (tail.x - head.x) / grid;
  const tailDy = (tail.y - head.y) / grid;

  const lengthSensor = state.body.length / (grid * grid);

  return new Float32Array([
    wallForward,
    wallLeft,
    wallRight,
    foodDx,
    foodDy,
    tailDx,
    tailDy,
    lengthSensor,
  ]);
}

/**
 * Convert the four logistic outputs into the chosen {@link Heading}
 * by argmax. Ties favour lower indices (Up, then Right, then Down,
 * then Left); the tie-breaker is irrelevant for evolutionary search
 * but keeps the mapping deterministic.
 */
export function decodeAction(outputs: ArrayLike<number>): Heading {
  let bestIdx = 0;
  let best = outputs[0];
  for (let i = 1; i < OUTPUT_COUNT; i++) {
    if (outputs[i] > best) {
      best = outputs[i];
      bestIdx = i;
    }
  }
  return ACTION_HEADINGS[bestIdx];
}
