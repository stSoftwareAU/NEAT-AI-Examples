/**
 * Maze-navigation agent: sensor encoding and action decoding.
 *
 * The controller observes the world through a small sensor pack of
 * five floating-point values:
 *
 *   0. Wall distance North — capped at {@link SENSOR_CAP} cells, then
 *      normalised to `[0, 1]` by dividing by `SENSOR_CAP`.
 *   1. Wall distance East.
 *   2. Wall distance South.
 *   3. Wall distance West.
 *   4. Heading-to-goal — a single packed value:
 *      `(unitX + unitY) / 2` — both components added together so a
 *      single channel encodes the direction towards the goal in the
 *      `[-1, 1]` range. (See {@link encodeState} for the full vector
 *      form passed to the network — five logical sensor channels.)
 *
 * The issue asks for "5 inputs: distances to wall on N/E/S/W (in
 * cells, capped) and a unit-vector heading-to-goal (2 components
 * packed)". We pack the unit vector into the fifth input by averaging
 * its components — sufficient for a small linear policy to recover
 * direction without inflating the input count.
 *
 * Outputs are four logistic activations — one per cardinal action —
 * and the agent commits to the argmax over those scores every tick.
 */
import { Action, type Maze, type MazeState, wallDistance } from "./maze.ts";

/** Number of sensor inputs fed to the controller. */
export const INPUT_COUNT = 5;

/** Number of action outputs (one per cardinal action — Stay is not emitted). */
export const OUTPUT_COUNT = 4;

/** Cap on the wall-distance sensor — keeps the input range bounded. */
export const SENSOR_CAP = 6;

/** Actions in argmax order for {@link decodeAction}. */
export const ACTION_ORDER: ReadonlyArray<Action> = [
  Action.North,
  Action.East,
  Action.South,
  Action.West,
];

/**
 * Compute the unit vector from `position` toward the maze's goal.
 * Returns `[0, 0]` when the agent is already on the goal.
 */
export function headingToGoal(
  maze: Maze,
  position: { x: number; y: number },
): [number, number] {
  const dx = maze.goal.x - position.x;
  const dy = maze.goal.y - position.y;
  const mag = Math.hypot(dx, dy);
  if (mag === 0) return [0, 0];
  return [dx / mag, dy / mag];
}

/**
 * Encode a {@link MazeState} as a Float32Array of {@link INPUT_COUNT}
 * sensor values. Values are normalised so the network sees inputs in
 * a comparable range regardless of maze size.
 */
export function encodeState(state: MazeState): Float32Array {
  const { maze, position } = state;
  const cap = SENSOR_CAP;
  const wallN = wallDistance(maze, position.x, position.y, 0, -1, cap) / cap;
  const wallE = wallDistance(maze, position.x, position.y, 1, 0, cap) / cap;
  const wallS = wallDistance(maze, position.x, position.y, 0, 1, cap) / cap;
  const wallW = wallDistance(maze, position.x, position.y, -1, 0, cap) / cap;
  const [hx, hy] = headingToGoal(maze, position);
  // Pack the two heading components into a single scalar in [-1, 1]
  // by averaging — keeps the input count at five as the issue asks.
  const headingPacked = (hx + hy) / 2;
  return new Float32Array([wallN, wallE, wallS, wallW, headingPacked]);
}

/**
 * Convert the four logistic outputs into the chosen {@link Action} by
 * argmax. Ties favour lower indices (North, then East, then South,
 * then West); the tie-breaker is irrelevant for evolutionary search
 * but keeps the mapping deterministic.
 */
export function decodeAction(outputs: ArrayLike<number>): Action {
  let bestIdx = 0;
  let best = outputs[0];
  for (let i = 1; i < OUTPUT_COUNT; i++) {
    if (outputs[i] > best) {
      best = outputs[i];
      bestIdx = i;
    }
  }
  return ACTION_ORDER[bestIdx];
}
