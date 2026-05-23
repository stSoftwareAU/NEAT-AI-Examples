/**
 * Unit tests for tsp_two_opt/environment.ts.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  applyTwoOptSwap,
  DEFAULT_PROPOSAL_BUDGET,
  runEpisode,
  twoOptDelta,
} from "./environment.ts";
import { OUTPUT_COUNT } from "./agent.ts";
import { loadInstance, nearestNeighbourTour, tourLength } from "../common/tsp_instances.ts";

Deno.test("nearest-neighbour seed length matches tourLength(seedTour)", () => {
  const instance = loadInstance("burma14");
  const seed = nearestNeighbourTour(instance.cities, 0);
  const expected = tourLength(instance.cities, seed);

  // Pull seedLength out of an episode that issues zero proposals so the
  // seed value is the only thing the runner reports.
  const noopPolicy = {
    activate(): Float32Array {
      return new Float32Array(OUTPUT_COUNT);
    },
  };
  const result = runEpisode(noopPolicy, instance, { proposalBudget: 0 });
  assertEquals(result.proposalsIssued, 0);
  assertEquals(result.seedLength, expected);
  assertEquals(result.finalLength, expected);
});

Deno.test("applyTwoOptSwap — reverses the sub-tour between i+1 and j", () => {
  const tour = [0, 1, 2, 3, 4, 5];
  applyTwoOptSwap(tour, 1, 4);
  // After: tour[0] = 0, tour[1] = 1, then reversed [2,3,4] → [4,3,2], tour[5] = 5.
  assertEquals(tour, [0, 1, 4, 3, 2, 5]);
});

Deno.test("twoOptDelta — beneficial swap reports negative delta and tourLength agrees", () => {
  // Hand-construct a 4-city instance shaped like an "X" so the nearest-
  // neighbour tour visits the corners in a crossing order. Swapping the
  // crossing pair uncrosses the path and shortens the tour.
  const cities = [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  // Crossing tour: 0 → 3 → 1 → 2 → 0 (diagonals).
  const tour = [0, 3, 1, 2];
  const before = tourLength(cities, tour);
  // Reverse tour[1..2] = [3, 1] → [1, 3] → tour becomes [0, 1, 3, 2] (no crossings).
  const delta = twoOptDelta(cities, tour, 0, 2);
  assert(delta < 0, `delta should be negative, got ${delta}`);
  const swapped = tour.slice();
  applyTwoOptSwap(swapped, 0, 2);
  assertEquals(swapped, [0, 1, 3, 2]);
  const after = tourLength(cities, swapped);
  assertAlmostEquals(after - before, delta, 1e-6);
  assert(after < before, "uncrossed tour must be strictly shorter");
});

Deno.test("runEpisode — respects the swap budget", () => {
  const instance = loadInstance("burma14");
  const constantPolicy = {
    activate(): Float32Array {
      // Always argmax to (0, 0) — no-op proposal — but still consumes budget.
      return new Float32Array(OUTPUT_COUNT);
    },
  };
  const budget = 17;
  const result = runEpisode(constantPolicy, instance, { proposalBudget: budget });
  assertEquals(result.proposalsIssued, budget);
});

Deno.test("runEpisode — improvement ratio bounded in [0, 1]", () => {
  const instance = loadInstance("burma14");
  const randomPolicy = {
    activate(): Float32Array {
      const out = new Float32Array(OUTPUT_COUNT);
      // Random uniform values — deterministic per call via simple hash.
      for (let i = 0; i < OUTPUT_COUNT; i++) {
        out[i] = Math.sin(i * 0.123 + 1) * 0.5 + 0.5;
      }
      return out;
    },
  };
  const result = runEpisode(randomPolicy, instance, { proposalBudget: 50 });
  assert(result.improvementRatio >= 0);
  assert(result.improvementRatio <= 1);
});

Deno.test("DEFAULT_PROPOSAL_BUDGET — matches the issue's documented 200 figure", () => {
  assertEquals(DEFAULT_PROPOSAL_BUDGET, 200);
});
