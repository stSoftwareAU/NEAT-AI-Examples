/**
 * Unit tests for the maze-navigation agent (sensor encoding & action
 * decoding). "What" tests only — call the encoder with known states,
 * inspect the resulting Float32Array, and assert on the values.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  ACTION_ORDER,
  decodeAction,
  encodeState,
  headingToGoal,
  INPUT_COUNT,
  OUTPUT_COUNT,
  SENSOR_CAP,
} from "./agent.ts";
import { Action, initialState, parseMaze } from "./maze.ts";

Deno.test("encodeState produces exactly INPUT_COUNT values", () => {
  const maze = parseMaze([
    "#####",
    "#S.G#",
    "#####",
  ]);
  const state = initialState(maze);
  const out = encodeState(state);
  assertEquals(out.length, INPUT_COUNT);
});

Deno.test("encodeState — sensor reading at a known cell matches a hand-computed table", () => {
  // Layout:
  //   #####
  //   #...#
  //   #.#.#
  //   #S.G#
  //   #####
  // Agent starts at (1, 3). Wall distances:
  //   north — (1,2) is `.`, (1,1) is `.`, (1,0) is `#` → 2
  //   east  — (2,3) is `.`, (3,3) is `G` (free), (4,3) is `#` → 2
  //   south — (1,4) is `#` → 0
  //   west  — (0,3) is `#` → 0
  const maze = parseMaze([
    "#####",
    "#...#",
    "#.#.#",
    "#S.G#",
    "#####",
  ]);
  const state = initialState(maze);
  const out = encodeState(state);
  assertAlmostEquals(out[0], 2 / SENSOR_CAP, 1e-6, "north sensor");
  assertAlmostEquals(out[1], 2 / SENSOR_CAP, 1e-6, "east sensor");
  assertAlmostEquals(out[2], 0, 1e-6, "south sensor");
  assertAlmostEquals(out[3], 0, 1e-6, "west sensor");
});

Deno.test("encodeState — heading sensor points toward the goal", () => {
  // Agent at (1,1); goal at (3,1) — purely east.
  const maze = parseMaze([
    "#####",
    "#S.G#",
    "#####",
  ]);
  const state = initialState(maze);
  const out = encodeState(state);
  // Heading vector is (1, 0); packed = (1 + 0) / 2 = 0.5.
  assertAlmostEquals(out[4], 0.5, 1e-6);
});

Deno.test("headingToGoal returns the unit vector toward the goal", () => {
  // Goal directly south.
  const maze = parseMaze([
    "###",
    "#S#",
    "#.#",
    "#G#",
    "###",
  ]);
  const [hx, hy] = headingToGoal(maze, maze.start);
  assertAlmostEquals(hx, 0, 1e-6);
  assertAlmostEquals(hy, 1, 1e-6);
});

Deno.test("headingToGoal returns [0, 0] when the agent is on the goal", () => {
  const maze = parseMaze([
    "###",
    "#SG",
    "###",
  ]);
  const [hx, hy] = headingToGoal(maze, maze.goal);
  assertEquals(hx, 0);
  assertEquals(hy, 0);
});

Deno.test("decodeAction picks the argmax over the four outputs", () => {
  for (let i = 0; i < OUTPUT_COUNT; i++) {
    const outputs = [0.1, 0.1, 0.1, 0.1];
    outputs[i] = 0.9;
    assertEquals(decodeAction(outputs), ACTION_ORDER[i]);
  }
});

Deno.test("decodeAction never emits Stay — only cardinal actions", () => {
  for (let i = 0; i < 16; i++) {
    const outputs = [Math.random(), Math.random(), Math.random(), Math.random()];
    const action = decodeAction(outputs);
    assert(action !== Action.Stay);
  }
});
