/**
 * Tests for the deterministic cart-pole physics module. These are
 * "what" tests — they verify the observable behaviour of the simulator
 * (positions, velocities, failure flags) rather than how it is computed.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  type CartPoleState,
  DEFAULT_LIMITS,
  DEFAULT_PARAMS,
  encodeState,
  initialState,
  isFailed,
  perturbedInitialState,
  step,
} from "./physics.ts";

Deno.test("initialState centres the cart with the pole upright", () => {
  const s = initialState();
  assertEquals(s.x, 0);
  assertEquals(s.v, 0);
  assertEquals(s.theta, 0);
  assertEquals(s.omega, 0);
});

Deno.test("step returns a new state object (input is not mutated)", () => {
  const s = initialState();
  const next = step(s, 1);
  assertEquals(s.x, 0, "input state x should be unchanged");
  assertEquals(s.v, 0, "input state v should be unchanged");
  assert(next !== s, "step must return a new state object");
});

Deno.test("a stationary cart with a vertical pole stays vertical when no force is applied at zero gravity", () => {
  // Disable gravity so the pole genuinely cannot fall on its own.
  const params = { ...DEFAULT_PARAMS, gravity: 0, forceMagnitude: 0 };
  let s: CartPoleState = initialState();
  for (let i = 0; i < 100; i++) {
    s = step(s, 0, params);
  }
  assertAlmostEquals(s.theta, 0, 1e-9, "pole angle must remain zero");
  assertAlmostEquals(s.omega, 0, 1e-9, "pole angular velocity must remain zero");
  assertAlmostEquals(s.x, 0, 1e-9, "cart must not drift");
});

Deno.test("a positive force accelerates the cart to the right", () => {
  const s = step(initialState(), 1);
  assert(s.v > 0, `expected cart velocity > 0, got ${s.v}`);
  assert(s.x >= 0, `expected non-negative cart position, got ${s.x}`);
});

Deno.test("a negative force accelerates the cart to the left", () => {
  const s = step(initialState(), -1);
  assert(s.v < 0, `expected cart velocity < 0, got ${s.v}`);
  assert(s.x <= 0, `expected non-positive cart position, got ${s.x}`);
});

Deno.test("a slightly tilted pole falls without control", () => {
  // Start with a small tilt; apply zero force every step. The pole
  // should accelerate away from vertical and trip the failure threshold
  // within a reasonable number of steps.
  let s: CartPoleState = { x: 0, v: 0, theta: 0.05, omega: 0 };
  let failedStep = -1;
  for (let i = 0; i < 500; i++) {
    s = step(s, 0);
    if (isFailed(s)) {
      failedStep = i;
      break;
    }
  }
  assert(failedStep >= 0, "pole should fall without control");
  assert(failedStep < 200, `expected failure before step 200, got ${failedStep}`);
});

Deno.test("step is deterministic for identical inputs", () => {
  const s1 = step({ x: 0.1, v: 0.2, theta: 0.05, omega: -0.1 }, 1);
  const s2 = step({ x: 0.1, v: 0.2, theta: 0.05, omega: -0.1 }, 1);
  assertEquals(s1, s2);
});

Deno.test("isFailed flags an over-tilted pole", () => {
  const tilted: CartPoleState = {
    x: 0,
    v: 0,
    theta: DEFAULT_LIMITS.maxAngle * 1.5,
    omega: 0,
  };
  assertEquals(isFailed(tilted), true);
});

Deno.test("isFailed flags a cart that has run off the track", () => {
  const offTrack: CartPoleState = {
    x: DEFAULT_LIMITS.maxPosition * 1.5,
    v: 0,
    theta: 0,
    omega: 0,
  };
  assertEquals(isFailed(offTrack), true);
});

Deno.test("isFailed returns false near the centre with a vertical pole", () => {
  assertEquals(isFailed(initialState()), false);
});

Deno.test("perturbedInitialState samples each component within ±magnitude", () => {
  const random = createDeterministicRandom(1234);
  const magnitude = 0.05;
  for (let i = 0; i < 100; i++) {
    const s = perturbedInitialState(random, magnitude);
    assert(Math.abs(s.x) <= magnitude, `|x|=${s.x} should be <= ${magnitude}`);
    assert(Math.abs(s.v) <= magnitude, `|v|=${s.v} should be <= ${magnitude}`);
    assert(Math.abs(s.theta) <= magnitude, `|theta|=${s.theta} should be <= ${magnitude}`);
    assert(Math.abs(s.omega) <= magnitude, `|omega|=${s.omega} should be <= ${magnitude}`);
  }
});

Deno.test("perturbedInitialState is deterministic for the same seed", () => {
  const r1 = createDeterministicRandom(42);
  const r2 = createDeterministicRandom(42);
  assertEquals(perturbedInitialState(r1, 0.05), perturbedInitialState(r2, 0.05));
});

Deno.test("perturbedInitialState produces a non-zero starting state with a non-zero magnitude", () => {
  // The whole point of the helper is to break the perfect symmetry of
  // initialState(); a single sample with non-trivial magnitude must
  // differ from the zero state somewhere.
  const random = createDeterministicRandom(7);
  const s = perturbedInitialState(random, 0.05);
  assert(
    s.x !== 0 || s.v !== 0 || s.theta !== 0 || s.omega !== 0,
    "expected at least one component to be perturbed",
  );
});

Deno.test("encodeState produces a 4-element Float32Array of [x, v, theta, omega]", () => {
  const arr = encodeState({ x: 1, v: 2, theta: 0.1, omega: -0.3 });
  assertEquals(arr.length, 4);
  assertAlmostEquals(arr[0], 1, 1e-6);
  assertAlmostEquals(arr[1], 2, 1e-6);
  assertAlmostEquals(arr[2], 0.1, 1e-6);
  assertAlmostEquals(arr[3], -0.3, 1e-6);
});
