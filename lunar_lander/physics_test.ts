/**
 * Tests for the deterministic lunar-lander physics module. "What" tests
 * only — each case calls a real function, runs the simulator, and
 * asserts on the observable outputs (positions, velocities, fuel,
 * outcomes) rather than how they are computed.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import {
  classifyOutcome,
  DEFAULT_PARAMS,
  DEFAULT_TERRAIN,
  encodeState,
  initialState,
  isTerminal,
  type LanderAction,
  type LanderState,
  NO_ACTION,
  SAFE_LANDING_ANGLE,
  SAFE_LANDING_VX_MAGNITUDE,
  SAFE_LANDING_VY_MAGNITUDE,
  step,
} from "./physics.ts";

const FIRE_MAIN: LanderAction = { main: true, left: false, right: false };
const FIRE_LEFT: LanderAction = { main: false, left: true, right: false };
const FIRE_RIGHT: LanderAction = { main: false, left: false, right: true };

Deno.test("initialState places the lander above the pad, stationary, upright", () => {
  const s = initialState();
  assertEquals(s.x, 0);
  assert(s.y > 0, "should start above the ground");
  assertEquals(s.vx, 0);
  assertEquals(s.vy, 0);
  assertEquals(s.angle, 0);
  assertEquals(s.angularV, 0);
  assert(s.fuel > 0, "should start with fuel available");
});

Deno.test("initialState honours overrides", () => {
  const s = initialState({ x: 5, y: 50, fuel: 10 });
  assertEquals(s.x, 5);
  assertEquals(s.y, 50);
  assertEquals(s.fuel, 10);
});

Deno.test("step returns a new object — input state is not mutated", () => {
  const s = initialState();
  const next = step(s, NO_ACTION);
  assertEquals(s.y, initialState().y, "input y should be unchanged");
  assert(next !== s, "step must return a new state object");
});

Deno.test("free-fall accelerates the lander downward without thrust", () => {
  let s: LanderState = initialState();
  for (let i = 0; i < 20; i++) {
    s = step(s, NO_ACTION);
  }
  assert(s.vy < 0, `expected vy < 0 in free fall, got ${s.vy}`);
  assert(
    s.y < initialState().y,
    `expected y to decrease in free fall, got ${s.y}`,
  );
});

Deno.test("free-fall consumes no fuel", () => {
  let s: LanderState = initialState();
  for (let i = 0; i < 50; i++) {
    s = step(s, NO_ACTION);
  }
  assertEquals(s.fuel, initialState().fuel);
});

Deno.test("main thrust on an upright lander decelerates a fall", () => {
  // Begin already falling; without thrust vy continues to drop.
  const start: LanderState = initialState({ vy: -5 });

  let withoutThrust = start;
  let withThrust = start;
  for (let i = 0; i < 10; i++) {
    withoutThrust = step(withoutThrust, NO_ACTION);
    withThrust = step(withThrust, FIRE_MAIN);
  }
  assert(
    withThrust.vy > withoutThrust.vy,
    `main thrust should slow descent: with=${withThrust.vy} without=${withoutThrust.vy}`,
  );
});

Deno.test("main thrust burns fuel", () => {
  let s: LanderState = initialState();
  for (let i = 0; i < 5; i++) {
    s = step(s, FIRE_MAIN);
  }
  assert(s.fuel < initialState().fuel, `expected fuel to drop, got ${s.fuel}`);
});

Deno.test("left RCS rotates anti-clockwise (positive angle)", () => {
  let s: LanderState = initialState();
  for (let i = 0; i < 5; i++) s = step(s, FIRE_LEFT);
  assert(s.angle > 0, `expected positive angle, got ${s.angle}`);
});

Deno.test("right RCS rotates clockwise (negative angle)", () => {
  let s: LanderState = initialState();
  for (let i = 0; i < 5; i++) s = step(s, FIRE_RIGHT);
  assert(s.angle < 0, `expected negative angle, got ${s.angle}`);
});

Deno.test("thrusters silently no-op when fuel is exhausted", () => {
  // Burn all fuel.
  let s: LanderState = initialState({ fuel: 0 });
  const before = step(s, NO_ACTION);
  s = step(initialState({ fuel: 0 }), FIRE_MAIN);
  // Without thrust effect, the only acceleration is gravity, so
  // vy should match the no-action step.
  assertAlmostEquals(s.vy, before.vy, 1e-9);
  assertEquals(s.fuel, 0);
});

Deno.test("step is deterministic for identical inputs", () => {
  const start: LanderState = {
    x: 1,
    y: 50,
    vx: 0.5,
    vy: -1.5,
    angle: 0.1,
    angularV: 0.05,
    fuel: 30,
  };
  const a = step(start, FIRE_MAIN);
  const b = step(start, FIRE_MAIN);
  assertEquals(a, b);
});

Deno.test(
  "free-fall from the default starting altitude crashes (vy magnitude exceeds safe limit)",
  () => {
    let s: LanderState = initialState();
    let outcome = classifyOutcome(s);
    let stepCount = 0;
    while (outcome === "flying" && stepCount < 1000) {
      s = step(s, NO_ACTION);
      outcome = classifyOutcome(s);
      stepCount++;
    }
    assertEquals(outcome, "crashed", `expected crash from free fall, got ${outcome}`);
    assert(
      Math.abs(s.vy) > SAFE_LANDING_VY_MAGNITUDE,
      `expected impact vy magnitude > ${SAFE_LANDING_VY_MAGNITUDE}, got ${s.vy}`,
    );
  },
);

Deno.test("classifyOutcome detects a safe landing on the pad", () => {
  // Crafted touchdown: on the pad, upright, slow.
  const safe: LanderState = {
    x: DEFAULT_TERRAIN.padX,
    y: DEFAULT_TERRAIN.groundY,
    vx: 0,
    vy: -1,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  assertEquals(classifyOutcome(safe), "landed");
});

Deno.test("classifyOutcome flags a fast vertical impact as a crash", () => {
  const fast: LanderState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: -SAFE_LANDING_VY_MAGNITUDE * 5,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  assertEquals(classifyOutcome(fast), "crashed");
});

Deno.test("classifyOutcome flags a tilted touchdown as a crash", () => {
  const tilted: LanderState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: -1,
    angle: SAFE_LANDING_ANGLE * 5,
    angularV: 0,
    fuel: 50,
  };
  assertEquals(classifyOutcome(tilted), "crashed");
});

Deno.test("classifyOutcome flags a landing off the pad as a crash", () => {
  const offPad: LanderState = {
    x: DEFAULT_TERRAIN.padX + DEFAULT_TERRAIN.padHalfWidth + 5,
    y: 0,
    vx: 0,
    vy: -1,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  assertEquals(classifyOutcome(offPad), "crashed");
});

Deno.test("classifyOutcome flags out-of-bounds drift", () => {
  const drifted: LanderState = {
    x: DEFAULT_TERRAIN.worldHalfWidth + 10,
    y: 50,
    vx: 0,
    vy: 0,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  assertEquals(classifyOutcome(drifted), "out_of_bounds");
});

Deno.test("classifyOutcome ignores horizontal velocity above the safe limit", () => {
  const fastSideways: LanderState = {
    x: 0,
    y: 0,
    vx: SAFE_LANDING_VX_MAGNITUDE * 5,
    vy: -1,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  assertEquals(classifyOutcome(fastSideways), "crashed");
});

Deno.test("isTerminal distinguishes flying from final outcomes", () => {
  assertEquals(isTerminal(initialState()), false);
  const grounded: LanderState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: -100,
    angle: 0,
    angularV: 0,
    fuel: 0,
  };
  assertEquals(isTerminal(grounded), true);
});

Deno.test("encodeState produces a 7-element Float32Array of [x, y, vx, vy, angle, angularV, fuel]", () => {
  const arr = encodeState({
    x: 1,
    y: 2,
    vx: 3,
    vy: -4,
    angle: 0.5,
    angularV: -0.25,
    fuel: 99,
  });
  assertEquals(arr.length, 7);
  assertAlmostEquals(arr[0], 1, 1e-6);
  assertAlmostEquals(arr[1], 2, 1e-6);
  assertAlmostEquals(arr[2], 3, 1e-6);
  assertAlmostEquals(arr[3], -4, 1e-6);
  assertAlmostEquals(arr[4], 0.5, 1e-6);
  assertAlmostEquals(arr[5], -0.25, 1e-6);
  assertAlmostEquals(arr[6], 99, 1e-6);
});

Deno.test("DEFAULT_PARAMS uses lunar-scale gravity", () => {
  // Lunar gravity ≈ 1.62 m/s² — sanity-check the constant so an
  // accidental edit to Earth gravity (9.8) is caught.
  assert(
    DEFAULT_PARAMS.gravity > 0 && DEFAULT_PARAMS.gravity < 5,
    `expected lunar-scale gravity, got ${DEFAULT_PARAMS.gravity}`,
  );
});
