/**
 * Unit tests for the deterministic Snake game model.
 *
 * "What" tests only — each test calls a real function, runs the
 * simulator, and asserts on observable output (state values, death
 * flags, length progression).
 */
import { assert, assertEquals } from "@std/assert";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  cellsEqual,
  Heading,
  inBounds,
  initialState,
  isReverse,
  newGame,
  spawnFood,
  step,
} from "./snake.ts";

Deno.test("initialState builds a snake of the requested length", () => {
  const s = initialState(12, 4);
  assertEquals(s.body.length, 4);
  assertEquals(s.gridSize, 12);
  assertEquals(s.heading, Heading.Right);
  assertEquals(s.eaten, 0);
  assertEquals(s.steps, 0);
  assertEquals(s.dead, false);
});

Deno.test("initialState rejects too-small grids", () => {
  let threw = false;
  try {
    initialState(2, 3);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("isReverse detects 180° turns", () => {
  assertEquals(isReverse(Heading.Up, Heading.Down), true);
  assertEquals(isReverse(Heading.Down, Heading.Up), true);
  assertEquals(isReverse(Heading.Left, Heading.Right), true);
  assertEquals(isReverse(Heading.Right, Heading.Left), true);
  assertEquals(isReverse(Heading.Up, Heading.Right), false);
  assertEquals(isReverse(Heading.Up, Heading.Up), false);
});

Deno.test("cellsEqual matches identical cells", () => {
  assertEquals(cellsEqual({ x: 1, y: 2 }, { x: 1, y: 2 }), true);
  assertEquals(cellsEqual({ x: 1, y: 2 }, { x: 1, y: 3 }), false);
});

Deno.test("inBounds rejects cells outside the grid", () => {
  assertEquals(inBounds({ x: 0, y: 0 }, 5), true);
  assertEquals(inBounds({ x: 4, y: 4 }, 5), true);
  assertEquals(inBounds({ x: -1, y: 0 }, 5), false);
  assertEquals(inBounds({ x: 5, y: 0 }, 5), false);
  assertEquals(inBounds({ x: 0, y: 5 }, 5), false);
});

Deno.test("step — happy path: snake placed next to food eats it and grows", () => {
  // Place food directly in front of the head so the next move eats.
  const random = createDeterministicRandom(1);
  const base = initialState(12, 3);
  const head = base.body[0];
  const food = { x: head.x + 1, y: head.y };
  const state = { ...base, food };
  const next = step(state, Heading.Right, random);
  assertEquals(next.dead, false);
  assertEquals(next.eaten, 1, "expected eaten to increment after eating food");
  assertEquals(next.body.length, base.body.length + 1, "snake should grow by one segment");
  assertEquals(next.body[0].x, head.x + 1);
  // New food cell should not occupy a body cell.
  for (const cell of next.body) {
    assert(
      !cellsEqual(cell, next.food),
      "new food must not overlap any body cell",
    );
  }
});

Deno.test("step — wall collision ends the episode", () => {
  const random = createDeterministicRandom(2);
  const base = initialState(12, 3);
  // Move snake to the right wall.
  const head = { x: base.gridSize - 1, y: base.body[0].y };
  const body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
  const state = { ...base, body, heading: Heading.Right };
  const next = step(state, Heading.Right, random);
  assertEquals(next.dead, true, "expected death after running into the wall");
  assertEquals(next.eaten, 0);
});

Deno.test("step — self collision ends the episode", () => {
  const random = createDeterministicRandom(3);
  // Construct a snake long enough to collide with itself in one turn.
  // Body shape (heading right, about to turn down then back into itself):
  //   tail at (5, 5), body at (6, 5), (7, 5), (7, 6), (6, 6); head at (5, 6).
  // Asking the head to go up onto (5, 5) would collide with the tail —
  // but the tail moves first. To force a collision we put the head
  // adjacent to a non-tail body cell.
  const body = [
    { x: 6, y: 6 }, // head
    { x: 7, y: 6 },
    { x: 7, y: 5 },
    { x: 6, y: 5 },
    { x: 5, y: 5 },
  ];
  const state = {
    gridSize: 12,
    body,
    heading: Heading.Left,
    food: { x: 0, y: 0 },
    dead: false,
    eaten: 0,
    steps: 0,
  };
  // Move up: head would go to (6, 5) which is currently a body cell
  // and remains one after the tail moves.
  const next = step(state, Heading.Up, random);
  assertEquals(next.dead, true, "expected death after running into own body");
});

Deno.test("step — 180° reversal request is ignored", () => {
  const random = createDeterministicRandom(4);
  const base = initialState(12, 3);
  // Snake heading right; ask it to go left (a reversal).
  const next = step({ ...base }, Heading.Left, random);
  // The snake should keep heading right, not crash into its neck.
  assertEquals(next.heading, Heading.Right);
  assertEquals(next.dead, false);
});

Deno.test("step — non-eating move keeps body length constant", () => {
  const random = createDeterministicRandom(5);
  const base = initialState(12, 3);
  // Set food well away so it is definitely not eaten.
  const state = { ...base, food: { x: 0, y: 0 } };
  const next = step(state, Heading.Right, random);
  assertEquals(next.body.length, base.body.length);
});

Deno.test("spawnFood places food on a cell not occupied by the snake", () => {
  const random = createDeterministicRandom(42);
  const state = initialState(12, 5);
  for (let i = 0; i < 20; i++) {
    const food = spawnFood(state, random);
    assert(food.x >= 0 && food.x < state.gridSize);
    assert(food.y >= 0 && food.y < state.gridSize);
    for (const cell of state.body) {
      assert(!cellsEqual(food, cell), "food must not overlap snake body");
    }
  }
});

Deno.test("newGame is deterministic for the same seed", () => {
  const a = newGame(createDeterministicRandom(7), 12, 3);
  const b = newGame(createDeterministicRandom(7), 12, 3);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});
