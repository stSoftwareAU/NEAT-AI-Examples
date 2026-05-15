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
  DEFAULT_START_ALTITUDE,
  DEFAULT_START_FUEL,
  DEFAULT_START_VX,
  DEFAULT_START_X,
  DEFAULT_TERRAIN,
  encodeState,
  initialState,
  isTerminal,
  type LanderAction,
  type LanderState,
  NO_ACTION,
  perturbedInitialState,
  perturbedScenario,
  SAFE_LANDING_ANGLE,
  SAFE_LANDING_VX_MAGNITUDE,
  SAFE_LANDING_VY_MAGNITUDE,
  step,
  WIDE_RANGES,
} from "./physics.ts";

import { createDeterministicRandom } from "../common/deterministic_random.ts";

const FIRE_MAIN: LanderAction = { main: true, left: false, right: false };
const FIRE_LEFT: LanderAction = { main: false, left: true, right: false };
const FIRE_RIGHT: LanderAction = { main: false, left: false, right: true };

// Issue #72: the lander now enters the scene off-pad and drifting so
// the controller is forced to fight gravity, fuel, AND lateral motion
// just like the classic Atari Lunar Lander. The original assertion
// (x===0, vx===0) is updated below to reflect the new entry profile.
Deno.test("initialState places the lander off the pad, drifting, upright", () => {
  const s = initialState();
  assert(s.x !== 0, `should start off-pad (got x=${s.x})`);
  assert(
    Math.abs(s.x) < DEFAULT_TERRAIN.worldHalfWidth,
    `should start within world bounds (got x=${s.x})`,
  );
  assert(
    Math.abs(s.x) > DEFAULT_TERRAIN.padHalfWidth,
    `should start outside the landing pad (got x=${s.x})`,
  );
  assert(s.y > 0, "should start above the ground");
  assert(s.vx !== 0, `should start drifting horizontally (got vx=${s.vx})`);
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

Deno.test("encodeState produces 7 bounded values using pad-relative x", () => {
  const terrain = { ...DEFAULT_TERRAIN, padX: 11 };
  const arr = encodeState({
    x: 1,
    y: 50,
    vx: 3,
    vy: -4,
    angle: 0.5,
    angularV: -0.25,
    fuel: 60,
  }, terrain);
  assertEquals(arr.length, 7);
  assertAlmostEquals(arr[0], -0.2, 1e-6);
  assertAlmostEquals(arr[1], 0.5, 1e-6);
  assertAlmostEquals(arr[2], 0.12, 1e-6);
  assertAlmostEquals(arr[3], -0.16, 1e-6);
  assertAlmostEquals(arr[4], 0.5 / Math.PI, 1e-6);
  assertAlmostEquals(arr[5], -0.05, 1e-6);
  assertAlmostEquals(arr[6], 0.5, 1e-6);
  for (const value of arr) {
    assert(value >= -1 && value <= 1, `encoded value out of range: ${value}`);
  }
});

Deno.test("perturbedInitialState centres on initialState within the widened ranges", () => {
  // Issue #195: the perturbed-start distribution was widened so a
  // champion cannot win by memorising a single trajectory. At
  // magnitude=1 the per-component half-ranges are taken from
  // WIDE_RANGES (x±25 m, y±20 m, vx±3 m/s, vy±2 m/s, angle±0.25 rad,
  // fuel±20). Angular velocity is still held fixed at 0.
  const random = createDeterministicRandom(11);
  for (let i = 0; i < 100; i++) {
    const s = perturbedInitialState(random, 1.0);
    assert(Math.abs(s.x - DEFAULT_START_X) <= WIDE_RANGES.x);
    assert(Math.abs(s.y - DEFAULT_START_ALTITUDE) <= WIDE_RANGES.y);
    assert(Math.abs(s.vx - DEFAULT_START_VX) <= WIDE_RANGES.vx);
    assert(Math.abs(s.vy) <= WIDE_RANGES.vy);
    assert(Math.abs(s.angle) <= WIDE_RANGES.angle);
    assertEquals(s.angularV, 0);
    assert(Math.abs(s.fuel - DEFAULT_START_FUEL) <= WIDE_RANGES.fuel);
  }
});

Deno.test("perturbedInitialState is deterministic for the same seed", () => {
  const a = perturbedInitialState(createDeterministicRandom(7), 1.0);
  const b = perturbedInitialState(createDeterministicRandom(7), 1.0);
  assertEquals(a, b);
});

Deno.test("perturbedScenario varies padX within WIDE_RANGES.padX", () => {
  const random = createDeterministicRandom(23);
  let minPadX = Infinity;
  let maxPadX = -Infinity;
  for (let i = 0; i < 200; i++) {
    const { state, terrain } = perturbedScenario(random, 1.0);
    assert(Math.abs(terrain.padX) <= WIDE_RANGES.padX);
    minPadX = Math.min(minPadX, terrain.padX);
    maxPadX = Math.max(maxPadX, terrain.padX);
    // The state still respects the same per-component bounds as
    // perturbedInitialState.
    assert(Math.abs(state.x - DEFAULT_START_X) <= WIDE_RANGES.x);
    assert(state.y > DEFAULT_TERRAIN.groundY, `should start above ground (y=${state.y})`);
    assert(
      Math.abs(state.x) < DEFAULT_TERRAIN.worldHalfWidth,
      `should start inside world (x=${state.x})`,
    );
  }
  // Smoke-check that padX is actually swept rather than near-constant.
  assert(
    maxPadX - minPadX > WIDE_RANGES.padX,
    `padX did not span its range: [${minPadX}, ${maxPadX}]`,
  );
});

Deno.test("perturbedScenario is deterministic for the same seed", () => {
  const a = perturbedScenario(createDeterministicRandom(3), 1.0);
  const b = perturbedScenario(createDeterministicRandom(3), 1.0);
  assertEquals(a, b);
});

Deno.test("DEFAULT_PARAMS uses lunar-scale gravity", () => {
  // Lunar gravity ≈ 1.62 m/s² — sanity-check the constant so an
  // accidental edit to Earth gravity (9.8) is caught.
  assert(
    DEFAULT_PARAMS.gravity > 0 && DEFAULT_PARAMS.gravity < 5,
    `expected lunar-scale gravity, got ${DEFAULT_PARAMS.gravity}`,
  );
});
