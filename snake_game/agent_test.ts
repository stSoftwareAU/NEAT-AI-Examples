/**
 * Unit tests for the Snake-game agent (sensor encoding & action
 * decoding). "What" tests only — call the encoder with known states,
 * inspect the resulting Float32Array, and assert on the values.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  ACTION_HEADINGS,
  decodeAction,
  encodeState,
  headingLeft,
  headingRight,
  INPUT_COUNT,
  OUTPUT_COUNT,
} from "./agent.ts";
import { Heading, type SnakeState } from "./snake.ts";

function makeState(overrides: Partial<SnakeState> = {}): SnakeState {
  return {
    gridSize: 12,
    body: [{ x: 6, y: 6 }, { x: 5, y: 6 }, { x: 4, y: 6 }],
    heading: Heading.Right,
    food: { x: 8, y: 6 },
    dead: false,
    eaten: 0,
    steps: 0,
    ...overrides,
  };
}

Deno.test("encodeState produces exactly INPUT_COUNT values", () => {
  const state = makeState();
  const out = encodeState(state);
  assertEquals(out.length, INPUT_COUNT);
});

Deno.test("encodeState wall distances respect the grid bounds", () => {
  // Head at (11, 0) heading right — the right wall is one step away.
  const state = makeState({
    body: [{ x: 11, y: 0 }, { x: 10, y: 0 }, { x: 9, y: 0 }],
    heading: Heading.Right,
  });
  const out = encodeState(state);
  // Wall forward = 0 cells of free space.
  assertEquals(out[0], 0);
});

Deno.test("encodeState food delta points toward the food", () => {
  const state = makeState({
    body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }],
    food: { x: 8, y: 5 },
  });
  const out = encodeState(state);
  // foodDx = (8 - 5) / 12 = 0.25
  assertAlmostEquals(out[3], 0.25, 1e-6);
  // foodDy = 0
  assertAlmostEquals(out[4], 0, 1e-6);
});

Deno.test("encodeState tail delta points back toward the tail", () => {
  const state = makeState({
    body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }],
  });
  const out = encodeState(state);
  // tailDx = (3 - 5) / 12 = -2/12
  assertAlmostEquals(out[5], -2 / 12, 1e-6);
  assertAlmostEquals(out[6], 0, 1e-6);
});

Deno.test("encodeState length sensor scales with body size", () => {
  const a = encodeState(makeState({ body: [{ x: 5, y: 5 }] }));
  const b = encodeState(makeState({
    body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }],
  }));
  assert(b[7] > a[7], "length sensor should grow with body size");
});

Deno.test("headingLeft/Right rotate cardinally", () => {
  assertEquals(headingLeft(Heading.Up), Heading.Left);
  assertEquals(headingRight(Heading.Up), Heading.Right);
  assertEquals(headingLeft(Heading.Right), Heading.Up);
  assertEquals(headingRight(Heading.Right), Heading.Down);
});

Deno.test("decodeAction picks the argmax over the four outputs", () => {
  for (let i = 0; i < OUTPUT_COUNT; i++) {
    const outputs = [0.1, 0.1, 0.1, 0.1];
    outputs[i] = 0.9;
    assertEquals(decodeAction(outputs), ACTION_HEADINGS[i]);
  }
});
