/**
 * Tests for the lunar-lander scenario sampler. "What" tests only —
 * each case calls the public API and asserts on observable outputs
 * (seed-pool contents, scenario classifications, distribution span).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";

import {
  classifyOutcome,
  DEFAULT_START_ALTITUDE,
  DEFAULT_START_FUEL,
  DEFAULT_START_VX,
  DEFAULT_START_X,
  DEFAULT_TERRAIN,
  WIDE_RANGES,
} from "./physics.ts";

import {
  DEFAULT_TRAINING_COUNT,
  DEFAULT_VALIDATION_COUNT,
  generateScenarioPools,
  type SeededScenario,
} from "./scenarios.ts";

Deno.test("generateScenarioPools produces the requested counts", () => {
  const pools = generateScenarioPools(42, 50, 10);
  assertEquals(pools.trainingSeeds.length, 50);
  assertEquals(pools.validationSeeds.length, 10);
  assertEquals(pools.training.length, 50);
  assertEquals(pools.validation.length, 10);
});

Deno.test("generateScenarioPools default counts are 1000 / 200", () => {
  // Avoid the heavy lift in unit tests but verify the constants the
  // issue calls for so they cannot drift accidentally.
  assertEquals(DEFAULT_TRAINING_COUNT, 1000);
  assertEquals(DEFAULT_VALIDATION_COUNT, 200);
});

Deno.test("generateScenarioPools is deterministic for the same base seed", () => {
  const a = generateScenarioPools(7, 100, 25);
  const b = generateScenarioPools(7, 100, 25);
  assertEquals(a.trainingSeeds, b.trainingSeeds);
  assertEquals(a.validationSeeds, b.validationSeeds);
  assertEquals(a.training, b.training);
  assertEquals(a.validation, b.validation);
});

Deno.test("generateScenarioPools differs between distinct base seeds", () => {
  const a = generateScenarioPools(1, 50, 20);
  const b = generateScenarioPools(2, 50, 20);
  // Sanity: the two seed pools should not be identical.
  let differ = false;
  for (let i = 0; i < a.trainingSeeds.length; i++) {
    if (a.trainingSeeds[i] !== b.trainingSeeds[i]) {
      differ = true;
      break;
    }
  }
  assert(differ, "different base seeds should produce different training seeds");
});

Deno.test("generateScenarioPools yields disjoint training and validation seed pools", () => {
  const pools = generateScenarioPools(99, 500, 100);
  const trainingSet = new Set(pools.trainingSeeds);
  // Training seeds are themselves unique.
  assertEquals(trainingSet.size, pools.trainingSeeds.length);
  // Validation seeds are unique.
  const validationSet = new Set(pools.validationSeeds);
  assertEquals(validationSet.size, pools.validationSeeds.length);
  // No seed appears in both pools.
  for (const seed of pools.validationSeeds) {
    assert(!trainingSet.has(seed), `validation seed ${seed} also appears in training pool`);
  }
});

Deno.test("every generated scenario starts in a flying state", () => {
  const pools = generateScenarioPools(123, 200, 50);
  for (const scenario of [...pools.training, ...pools.validation]) {
    const outcome = classifyOutcome(scenario.state, scenario.terrain);
    assertEquals(
      outcome,
      "flying",
      `seed=${scenario.seed} produced non-flying outcome ${outcome} (state=${
        JSON.stringify(scenario.state)
      })`,
    );
    // The classification is the headline assertion, but additionally
    // confirm fuel is non-negative — an "impossible launch" with no
    // propellant defeats the purpose of a varied scenario.
    assert(scenario.state.fuel > 0, `seed=${scenario.seed} started with no fuel`);
  }
});

Deno.test("scenario distribution actually spans the wider range", () => {
  // Smoke-check: with a few hundred draws every component should reach
  // close to its half-range on both sides. We require at least 60% of
  // the configured half-range to ensure we are not collapsed near the
  // centre.
  const pools = generateScenarioPools(2026, 500, 100);
  const all: SeededScenario[] = [...pools.training, ...pools.validation];

  type Spread = { min: number; max: number };
  const init = (): Spread => ({ min: Infinity, max: -Infinity });
  const update = (s: Spread, value: number) => {
    s.min = Math.min(s.min, value);
    s.max = Math.max(s.max, value);
  };

  const xSpread = init();
  const ySpread = init();
  const vxSpread = init();
  const vySpread = init();
  const angleSpread = init();
  const fuelSpread = init();
  const padXSpread = init();

  for (const sc of all) {
    update(xSpread, sc.state.x);
    update(ySpread, sc.state.y);
    update(vxSpread, sc.state.vx);
    update(vySpread, sc.state.vy);
    update(angleSpread, sc.state.angle);
    update(fuelSpread, sc.state.fuel);
    update(padXSpread, sc.terrain.padX);
  }

  const requireSpan = (label: string, s: Spread, halfRange: number, centre: number) => {
    const low = centre - halfRange;
    const high = centre + halfRange;
    // All draws stay inside the configured range.
    assert(s.min >= low - 1e-9, `${label} min=${s.min} below configured low=${low}`);
    assert(s.max <= high + 1e-9, `${label} max=${s.max} above configured high=${high}`);
    // And the observed span covers a healthy fraction of the range —
    // this is the "actually spans the wider range" smoke check.
    const observedSpan = s.max - s.min;
    const minSpan = 2 * halfRange * 0.6;
    assert(
      observedSpan >= minSpan,
      `${label} span ${observedSpan.toFixed(3)} < ${minSpan.toFixed(3)} (range ±${halfRange})`,
    );
  };

  requireSpan("x", xSpread, WIDE_RANGES.x, DEFAULT_START_X);
  requireSpan("y", ySpread, WIDE_RANGES.y, DEFAULT_START_ALTITUDE);
  requireSpan("vx", vxSpread, WIDE_RANGES.vx, DEFAULT_START_VX);
  requireSpan("vy", vySpread, WIDE_RANGES.vy, 0);
  requireSpan("angle", angleSpread, WIDE_RANGES.angle, 0);
  requireSpan("fuel", fuelSpread, WIDE_RANGES.fuel, DEFAULT_START_FUEL);
  requireSpan("padX", padXSpread, WIDE_RANGES.padX, 0);
});

Deno.test("each scenario's seed reproduces its state and terrain", () => {
  // The pool's published seed is the contract — re-seeding from it
  // must reconstruct the exact same scenario.
  const pools = generateScenarioPools(555, 30, 5);
  for (const scenario of pools.training) {
    const reproduced = generateScenarioPools(555, 30, 5).training.find((s) =>
      s.seed === scenario.seed
    );
    assertEquals(reproduced, scenario);
  }
});

Deno.test("scenarios stay inside world bounds", () => {
  const pools = generateScenarioPools(7777, 300, 60);
  for (const sc of [...pools.training, ...pools.validation]) {
    assert(
      Math.abs(sc.state.x) < DEFAULT_TERRAIN.worldHalfWidth,
      `seed=${sc.seed} state.x=${sc.state.x} outside world bounds`,
    );
    // Pad must remain inside the world too — otherwise scenarios are
    // unreachable.
    assert(
      Math.abs(sc.terrain.padX) + sc.terrain.padHalfWidth <
        DEFAULT_TERRAIN.worldHalfWidth,
      `seed=${sc.seed} pad at padX=${sc.terrain.padX} extends past world bounds`,
    );
  }
});

Deno.test("generateScenarioPools rejects invalid arguments", () => {
  assertThrows(() => generateScenarioPools(Number.NaN, 10, 5));
  assertThrows(() => generateScenarioPools(0, -1, 5));
  assertThrows(() => generateScenarioPools(0, 10, -5));
  assertThrows(() => generateScenarioPools(0, 1.5, 5));
  assertThrows(() => generateScenarioPools(0, 10, 5, 0));
  assertThrows(() => generateScenarioPools(0, 10, 5, -1));
});

Deno.test("zero-count pools are allowed and disjoint by definition", () => {
  const pools = generateScenarioPools(0, 0, 0);
  assertEquals(pools.trainingSeeds.length, 0);
  assertEquals(pools.validationSeeds.length, 0);
  assertEquals(pools.training.length, 0);
  assertEquals(pools.validation.length, 0);
});
