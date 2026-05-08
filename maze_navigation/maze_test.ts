/**
 * Unit tests for the deterministic grid-maze model.
 *
 * "What" tests only — each test calls a real function, runs the
 * simulator, and asserts on observable output (state values, reached
 * flag, manhattan distances, sensor readings).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  Action,
  cellsEqual,
  defaultMaze,
  inBounds,
  initialState,
  isWall,
  manhattan,
  parseMaze,
  step,
  wallDistance,
} from "./maze.ts";

Deno.test("parseMaze accepts a minimal layout with S and G", () => {
  const maze = parseMaze([
    "###",
    "#SG",
    "###",
  ]);
  assertEquals(maze.width, 3);
  assertEquals(maze.height, 3);
  assertEquals(maze.start, { x: 1, y: 1 });
  assertEquals(maze.goal, { x: 2, y: 1 });
});

Deno.test("parseMaze rejects rows of differing widths", () => {
  assertThrows(() =>
    parseMaze([
      "###",
      "##",
    ])
  );
});

Deno.test("parseMaze rejects layouts without a start cell", () => {
  assertThrows(() =>
    parseMaze([
      "###",
      "#.G",
      "###",
    ])
  );
});

Deno.test("parseMaze rejects layouts without a goal cell", () => {
  assertThrows(() =>
    parseMaze([
      "###",
      "#S.",
      "###",
    ])
  );
});

Deno.test("parseMaze rejects unrecognised characters", () => {
  assertThrows(() =>
    parseMaze([
      "###",
      "#S?",
      "###",
    ])
  );
});

Deno.test("defaultMaze returns a non-trivial maze with start and goal in opposite corners", () => {
  const maze = defaultMaze();
  assert(maze.width >= 10, `expected width >= 10, got ${maze.width}`);
  assert(maze.height >= 10, `expected height >= 10, got ${maze.height}`);
  assert(!cellsEqual(maze.start, maze.goal));
});

Deno.test("inBounds rejects cells outside the grid", () => {
  const maze = defaultMaze();
  assert(inBounds(maze, 0, 0));
  assert(inBounds(maze, maze.width - 1, maze.height - 1));
  assert(!inBounds(maze, -1, 0));
  assert(!inBounds(maze, 0, maze.height));
});

Deno.test("isWall flags border cells in the default maze", () => {
  const maze = defaultMaze();
  assert(isWall(maze, 0, 0), "the top-left corner should be a wall");
  assert(isWall(maze, maze.width - 1, 0), "the top-right corner should be a wall");
});

Deno.test("isWall returns true for off-grid cells", () => {
  const maze = defaultMaze();
  assert(isWall(maze, -1, 0));
  assert(isWall(maze, maze.width, 0));
});

Deno.test("manhattan computes the |Δx| + |Δy| distance", () => {
  assertEquals(manhattan({ x: 0, y: 0 }, { x: 3, y: 4 }), 7);
  assertEquals(manhattan({ x: 5, y: 5 }, { x: 5, y: 5 }), 0);
});

Deno.test("initialState places the agent on the start cell with 0 steps", () => {
  const maze = defaultMaze();
  const state = initialState(maze);
  assertEquals(state.position, maze.start);
  assertEquals(state.steps, 0);
  assertEquals(state.reached, false);
});

Deno.test("step — happy path: agent placed adjacent to the goal solves in one step", () => {
  const maze = parseMaze([
    "#####",
    "#S.G#",
    "#####",
  ]);
  let state = initialState(maze);
  state = step(state, Action.East);
  state = step(state, Action.East);
  assertEquals(state.position, maze.goal);
  assertEquals(state.reached, true);
  assertEquals(state.steps, 2);
});

Deno.test("step — walls block movement; agent position is unchanged", () => {
  // Tiny maze: agent at (1,1) surrounded by walls on the north and west.
  const maze = parseMaze([
    "#####",
    "#S.G#",
    "#####",
  ]);
  const state = initialState(maze);
  const next = step(state, Action.North);
  assertEquals(next.position, state.position, "north move into wall must leave position unchanged");
  // Step still increments because the action consumed a tick.
  assertEquals(next.steps, 1);
});

Deno.test("step — Stay leaves the position unchanged", () => {
  const maze = defaultMaze();
  const state = initialState(maze);
  const next = step(state, Action.Stay);
  assertEquals(next.position, state.position);
  assertEquals(next.steps, 1);
});

Deno.test("step — once reached, further steps do not advance state", () => {
  const maze = parseMaze([
    "###",
    "#SG",
    "###",
  ]);
  // Wait — start at (1,1), goal at (2,1).
  let state = initialState(maze);
  state = step(state, Action.East);
  assertEquals(state.reached, true);
  const stepsAtArrival = state.steps;
  const after = step(state, Action.East);
  assertEquals(after.position, state.position, "must stay on goal cell");
  assertEquals(after.steps, stepsAtArrival, "step counter must freeze once reached");
});

Deno.test("wallDistance — hand-computed sensor table at a known cell", () => {
  // 5×5 box with a vertical wall splitting the centre row. The
  // start (S) and goal (G) are placed in corners; only the centre
  // row's wall layout matters for this test.
  //   #####
  //   #S..#
  //   #.#.#
  //   #..G#
  //   #####
  // Agent placed (for sensor purposes) at (1, 2) — east-facing wall
  // is at (2, 2) so wallDistance east is 0, west is 0 (wall at (0, 2)),
  // north is 1 (free at (1,1), wall at (1,0)), south is 1 (free at
  // (1,3), wall at (1,4)).
  const maze = parseMaze([
    "#####",
    "#S..#",
    "#.#.#",
    "#..G#",
    "#####",
  ]);
  const cap = 8;
  const east = wallDistance(maze, 1, 2, 1, 0, cap);
  const west = wallDistance(maze, 1, 2, -1, 0, cap);
  const north = wallDistance(maze, 1, 2, 0, -1, cap);
  const south = wallDistance(maze, 1, 2, 0, 1, cap);
  assertEquals(east, 0, "east blocked by central wall");
  assertEquals(west, 0, "west blocked by border wall");
  assertEquals(north, 1, "one free cell to the north");
  assertEquals(south, 1, "one free cell to the south");
});

Deno.test("wallDistance respects the cap", () => {
  // Long open corridor: cap should bound the answer.
  const maze = parseMaze([
    "##########",
    "#S......G#",
    "##########",
  ]);
  // From (1, 1) east, the corridor has 7 free cells before hitting
  // the wall — but cap of 3 should clamp the result.
  const dist = wallDistance(maze, 1, 1, 1, 0, 3);
  assertEquals(dist, 3);
});
