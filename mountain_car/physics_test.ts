/**
 * Tests for the deterministic Mountain-Car physics module. These are
 * "what" tests — they verify the observable behaviour of the simulator
 * (positions, velocities, success flags, encoding) rather than how it
 * is computed.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import {
  DEFAULT_PARAMS,
  DEFAULT_START_V,
  DEFAULT_START_X,
  encodeState,
  GOAL_POSITION,
  hillHeight,
  initialState,
  isSuccess,
  MAX_EPISODE_STEPS,
  type MountainCarState,
  perturbedInitialState,
  step,
} from "./physics.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

Deno.test("initialState places the car at rest at the valley centre", () => {
  const s = initialState();
  assertEquals(s.x, DEFAULT_START_X);
  assertEquals(s.v, DEFAULT_START_V);
});

Deno.test("initialState honours overrides", () => {
  const s = initialState({ x: -0.6, v: 0.01 });
  assertEquals(s.x, -0.6);
  assertEquals(s.v, 0.01);
});

Deno.test("step returns a new object — input state is not mutated", () => {
  const s = initialState();
  const next = step(s, 1);
  assertEquals(s.x, DEFAULT_START_X, "input x should be unchanged");
  assertEquals(s.v, DEFAULT_START_V, "input v should be unchanged");
  assert(next !== s, "step must return a new state object");
});

Deno.test(
  "step from rest at x=-0.5 with action=+1 matches the published reference values",
  () => {
    // Reference computation (matching OpenAI Gym MountainCar-v0):
    //   v' = 0 + 0.001 - 0.0025 * cos(3 * -0.5)
    //      = 0.001 - 0.0025 * cos(-1.5)
    //      ≈ 0.001 - 0.0025 * 0.0707372016677029
    //      ≈ 0.000823157
    //   x' = -0.5 + v'
    //      ≈ -0.499176843
    const s = step({ x: -0.5, v: 0 }, 1);
    const expectedV = 0.001 - 0.0025 * Math.cos(-1.5);
    const expectedX = -0.5 + expectedV;
    assertAlmostEquals(s.v, expectedV, 1e-12);
    assertAlmostEquals(s.x, expectedX, 1e-12);
    assert(s.v > 0, "engine push at the valley centre should produce positive velocity");
  },
);

Deno.test(
  "applying +1 from rest over a short horizon increases velocity then position",
  () => {
    // Apply +1 force for 10 steps starting at the valley centre. The
    // car's velocity should grow above zero and its x coordinate should
    // edge to the right; it cannot have escaped over the goal yet
    // because the engine is too weak.
    let s: MountainCarState = { x: -0.5, v: 0 };
    for (let i = 0; i < 10; i++) {
      s = step(s, 1);
    }
    assert(s.v > 0, `expected positive velocity after 10 right-pushes, got ${s.v}`);
    assert(s.x > -0.5, `expected position to advance right, got ${s.x}`);
    assert(!isSuccess(s), "10 right-pushes from rest cannot reach the goal flag");
  },
);

Deno.test("step clamps velocity to the +/- maxSpeed envelope", () => {
  // Set initial velocity at the upper bound and apply +1 — the engine
  // would push v above maxSpeed but the clamp must hold it.
  const s = step({ x: 0.4, v: DEFAULT_PARAMS.maxSpeed }, 1);
  assert(
    s.v <= DEFAULT_PARAMS.maxSpeed,
    `velocity should not exceed maxSpeed=${DEFAULT_PARAMS.maxSpeed}, got ${s.v}`,
  );
  assert(
    s.v >= -DEFAULT_PARAMS.maxSpeed,
    `velocity should not fall below -maxSpeed, got ${s.v}`,
  );
});

Deno.test("step clamps position to the [minPosition, maxPosition] track", () => {
  const right = step({ x: 0.59, v: DEFAULT_PARAMS.maxSpeed }, 1);
  assert(
    right.x <= DEFAULT_PARAMS.maxPosition,
    `position should be clamped to maxPosition, got ${right.x}`,
  );
  const left = step({ x: -1.19, v: -DEFAULT_PARAMS.maxSpeed }, -1);
  assertEquals(left.x, DEFAULT_PARAMS.minPosition);
});

Deno.test("colliding with the left wall sets velocity to zero", () => {
  // Heading hard into the left wall — once x clamps to minPosition
  // the velocity must collapse to zero so the car cannot keep "pushing".
  const s = step({ x: -1.19, v: -DEFAULT_PARAMS.maxSpeed }, -1);
  assertEquals(s.x, DEFAULT_PARAMS.minPosition);
  assertEquals(s.v, 0);
});

Deno.test("step is deterministic for identical inputs", () => {
  const a = step({ x: -0.4, v: 0.02 }, 1);
  const b = step({ x: -0.4, v: 0.02 }, 1);
  assertEquals(a, b);
});

Deno.test("a no-action coast at the valley centre still drifts (slope is non-zero)", () => {
  // At x = -0.5 the slope cos(3·x) = cos(-1.5) ≈ 0.0707 is positive,
  // so gravity pulls the car towards the negative direction (left).
  const s = step({ x: -0.5, v: 0 }, 0);
  assert(s.v < 0, `expected gravity to pull velocity negative, got ${s.v}`);
});

Deno.test("isSuccess flags a state at or beyond the goal flag", () => {
  assertEquals(isSuccess({ x: GOAL_POSITION, v: 0 }), true);
  assertEquals(isSuccess({ x: GOAL_POSITION + 0.01, v: 0 }), true);
  assertEquals(isSuccess({ x: GOAL_POSITION - 0.01, v: 0 }), false);
});

Deno.test("isSuccess returns false for the canonical initial state", () => {
  assertEquals(isSuccess(initialState()), false);
});

Deno.test("encodeState produces a 2-element Float32Array of [x, v]", () => {
  const arr = encodeState({ x: 0.3, v: -0.04 });
  assertEquals(arr.length, 2);
  assertAlmostEquals(arr[0], 0.3, 1e-6);
  assertAlmostEquals(arr[1], -0.04, 1e-6);
});

Deno.test("hillHeight is a smooth sinusoid bounded in [0.1, 1.0]", () => {
  // sin(3·x)·0.45 + 0.55 ranges in [0.10, 1.00].
  for (let x = -1.2; x <= 0.6 + 1e-9; x += 0.1) {
    const h = hillHeight(x);
    assert(h >= 0.1 - 1e-9 && h <= 1.0 + 1e-9, `expected h ∈ [0.1, 1.0] at x=${x}, got ${h}`);
  }
});

Deno.test("MAX_EPISODE_STEPS matches the canonical MountainCar-v0 limit", () => {
  // Sanity-check the published 200-step horizon so an accidental edit
  // can be caught quickly in review.
  assertEquals(MAX_EPISODE_STEPS, 200);
});

Deno.test("perturbedInitialState samples x in [-magnitude, +magnitude] around the valley centre", () => {
  const random = createDeterministicRandom(7);
  const magnitude = 0.05;
  for (let i = 0; i < 50; i++) {
    const s = perturbedInitialState(random, magnitude);
    assertEquals(s.v, DEFAULT_START_V, "starting velocity should remain zero");
    assert(
      s.x >= DEFAULT_START_X - magnitude - 1e-12,
      `expected x >= ${DEFAULT_START_X - magnitude}, got ${s.x}`,
    );
    assert(
      s.x <= DEFAULT_START_X + magnitude + 1e-12,
      `expected x <= ${DEFAULT_START_X + magnitude}, got ${s.x}`,
    );
  }
});

Deno.test("perturbedInitialState is deterministic for the same PRNG seed", () => {
  const a = perturbedInitialState(createDeterministicRandom(42), 0.05);
  const b = perturbedInitialState(createDeterministicRandom(42), 0.05);
  assertEquals(a, b);
});

Deno.test("a hand-crafted swing policy reaches the goal within the step limit", () => {
  // Bang-bang policy: push in the direction of current velocity to
  // build up oscillation. This is the classic "swing-up" controller
  // and confirms the simulator is solvable.
  let s: MountainCarState = initialState();
  let solved = false;
  for (let i = 0; i < MAX_EPISODE_STEPS; i++) {
    const action = s.v >= 0 ? 1 : -1;
    s = step(s, action);
    if (isSuccess(s)) {
      solved = true;
      break;
    }
  }
  assertEquals(solved, true, `swing-up policy should solve within ${MAX_EPISODE_STEPS} steps`);
});
