/**
 * Unit tests for the TSP-constructive episode runner.
 *
 * "What" tests only — drive `runConstructiveEpisode` with hand-rolled
 * stub `activate` functions and assert on the returned tour, length,
 * and fitness.
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";

import { loadInstance, type TspCity } from "../common/tsp_instances.ts";

import { K_NEAREST, OUTPUT_COUNT } from "./agent.ts";
import {
  geoDistance,
  geoTourLength,
  isCompleteTour,
  runConstructiveEpisode,
} from "./environment.ts";

const TINY_CITIES: ReadonlyArray<TspCity> = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 3, y: 0 },
];

/**
 * Build a stub activate that always picks slot 0 (the nearest unvisited
 * city). This is the classic nearest-neighbour tour, which our
 * `runConstructiveEpisode` must reproduce exactly when given this stub.
 */
function nearestNeighbourStub(): (input: Float32Array) => Float32Array {
  return () => {
    const out = new Float32Array(OUTPUT_COUNT);
    out[0] = 1;
    return out;
  };
}

Deno.test("runConstructiveEpisode — nearest-neighbour stub builds the canonical NN order", () => {
  // Nearest-neighbour from city 0 over TINY_CITIES gives [0, 1, 2, 3]
  // regardless of distance metric (every step the smallest-x unvisited
  // city is the nearest).
  const result = runConstructiveEpisode(nearestNeighbourStub(), TINY_CITIES, 1);
  assertEquals(result.tour, [0, 1, 2, 3]);
  assertEquals(result.steps, TINY_CITIES.length - 1);
});

Deno.test("runConstructiveEpisode — full episode visits every city exactly once", () => {
  const burma14 = loadInstance("burma14");
  const result = runConstructiveEpisode(nearestNeighbourStub(), burma14.cities, burma14.optimum);
  assert(isCompleteTour(result.tour, burma14.cities.length));
  assertEquals(result.steps, burma14.cities.length - 1);
});

Deno.test("runConstructiveEpisode — fitness equals 1.0 when optimum matches the achieved length", () => {
  // The deterministic NN-stub builds the same tour every time. Take
  // its GEO length, declare *that* the optimum, and verify the
  // returned fitness is exactly 1.0.
  const burma14 = loadInstance("burma14");
  const nn = runConstructiveEpisode(nearestNeighbourStub(), burma14.cities, burma14.optimum);
  const synthetic = runConstructiveEpisode(nearestNeighbourStub(), burma14.cities, nn.tourLength);
  assertAlmostEquals(synthetic.fitness, 1, 1e-9);
  assertAlmostEquals(synthetic.tourLength, nn.tourLength, 1e-9);
});

Deno.test("runConstructiveEpisode — fitness < 1.0 on a deliberately bad tour", () => {
  // Force the agent to pick the *furthest* of the K nearest candidates
  // every step — the tour will be longer than the published optimum.
  const farthestStub = () => {
    const out = new Float32Array(OUTPUT_COUNT);
    out[OUTPUT_COUNT - 1] = 1;
    return out;
  };
  const burma14 = loadInstance("burma14");
  const result = runConstructiveEpisode(farthestStub, burma14.cities, burma14.optimum);
  assert(result.fitness < 1, `expected fitness < 1, got ${result.fitness}`);
  assert(result.fitness > 0, `expected fitness > 0, got ${result.fitness}`);
});

Deno.test("runConstructiveEpisode — declared length matches geoTourLength() of the visit order", () => {
  const burma14 = loadInstance("burma14");
  const result = runConstructiveEpisode(nearestNeighbourStub(), burma14.cities, burma14.optimum);
  const recomputed = geoTourLength(burma14.cities, result.tour);
  assertAlmostEquals(result.tourLength, recomputed, 1e-9);
});

Deno.test("runConstructiveEpisode — startCity override threads through", () => {
  const result = runConstructiveEpisode(nearestNeighbourStub(), TINY_CITIES, 1, { startCity: 2 });
  // NN from city 2: 2→1→0 (then back to 3 which is the only unvisited)
  assertEquals(result.tour[0], 2);
  assert(isCompleteTour(result.tour, TINY_CITIES.length));
});

Deno.test("geoDistance — symmetric, and identical cities are 1 km apart per TSPLIB GEO", () => {
  const burma14 = loadInstance("burma14");
  const a = burma14.cities[0];
  const b = burma14.cities[1];
  assertAlmostEquals(geoDistance(a, b), geoDistance(b, a), 1e-9);
  // TSPLIB95 §2.4 defines GEO as `dij = (int) (RRR * acos(q1 * q2 * q3) + 1.0)`.
  // For coincident cities the arc term is acos(1) = 0, so the required answer
  // is trunc(0 + 1.0) = 1 km — not 0. The +1.0 is part of the spec's integer
  // rounding, so a self-distance of 1 is required behaviour, not an artefact.
  assertEquals(geoDistance(a, a), 1);
});

// Replaces the HOW test that re-summed `geoDistance` inline (issue #490).
// These property-based WHAT tests assert observable invariants of
// `geoTourLength` — cyclic invariance and reversal invariance follow
// from "closed tour" + "symmetric edge" and would survive any future
// re-implementation that preserves the contract.
Deno.test("geoTourLength — closed-tour length is invariant under cyclic rotation", () => {
  const burma14 = loadInstance("burma14");
  const tour = [0, 7, 12, 6, 5, 3, 13, 2, 4, 11, 8, 10, 9, 1];
  const rotated = [...tour.slice(5), ...tour.slice(0, 5)];
  assertAlmostEquals(
    geoTourLength(burma14.cities, tour),
    geoTourLength(burma14.cities, rotated),
    1e-9,
  );
});

Deno.test("geoTourLength — reversed tour has the same length (symmetric edges)", () => {
  const burma14 = loadInstance("burma14");
  const tour = [0, 7, 12, 6, 5, 3, 13, 2, 4, 11, 8, 10, 9, 1];
  const reversed = [...tour].reverse();
  assertAlmostEquals(
    geoTourLength(burma14.cities, tour),
    geoTourLength(burma14.cities, reversed),
    1e-9,
  );
});

Deno.test("geoTourLength — throws when tour length differs from cities length", () => {
  const burma14 = loadInstance("burma14");
  assertThrows(() => geoTourLength(burma14.cities, [0, 1, 2]));
});

Deno.test("geoTourLength — empty cities returns 0", () => {
  assertEquals(geoTourLength([], []), 0);
});

Deno.test("runConstructiveEpisode — empty city list returns the empty tour", () => {
  const result = runConstructiveEpisode(nearestNeighbourStub(), [], 0);
  assertEquals(result.tour, []);
  assertEquals(result.tourLength, 0);
  assertEquals(result.steps, 0);
});

Deno.test("runConstructiveEpisode rejects out-of-range startCity", () => {
  assertThrows(() =>
    runConstructiveEpisode(nearestNeighbourStub(), TINY_CITIES, 1, {
      startCity: 99,
    })
  );
});

Deno.test("runConstructiveEpisode rejects activate functions with too few outputs", () => {
  const skinny = () => new Float32Array(K_NEAREST - 1);
  assertThrows(() => runConstructiveEpisode(skinny, TINY_CITIES, 1));
});

Deno.test("isCompleteTour — true for a permutation, false otherwise", () => {
  assert(isCompleteTour([0, 1, 2, 3], 4));
  assert(!isCompleteTour([0, 1, 1, 3], 4));
  assert(!isCompleteTour([0, 1, 2], 4));
  assert(!isCompleteTour([0, 1, 2, 5], 4));
});

Deno.test("burma14 nearest-neighbour fitness is within the documented envelope", () => {
  // The nearest-neighbour heuristic on burma14 (GEO distance) lands
  // within ~30% of the published optimum 3,323. Anything in [0.6, 1.0]
  // is consistent with NN — the example evolves to do better.
  const burma14 = loadInstance("burma14");
  const result = runConstructiveEpisode(nearestNeighbourStub(), burma14.cities, burma14.optimum);
  assert(result.fitness >= 0.6, `NN fitness ${result.fitness} below 0.6`);
  assert(result.fitness <= 1.0, `NN fitness ${result.fitness} above 1.0`);
});
