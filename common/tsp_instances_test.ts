import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";

import {
  boundingBoxDiagonal,
  euclideanDistance,
  loadInstance,
  nearestNeighbourTour,
  tourLength,
  type TspCity,
} from "./tsp_instances.ts";

Deno.test("loadInstance returns burma14 with 14 cities and optimum 3323", () => {
  const inst = loadInstance("burma14");
  assertEquals(inst.name, "burma14");
  assertEquals(inst.cities.length, 14);
  assertEquals(inst.optimum, 3323);
  for (const c of inst.cities) {
    assert(Number.isFinite(c.x) && Number.isFinite(c.y));
  }
});

Deno.test("loadInstance returns ulysses22 with 22 cities and optimum 7013", () => {
  const inst = loadInstance("ulysses22");
  assertEquals(inst.name, "ulysses22");
  assertEquals(inst.cities.length, 22);
  assertEquals(inst.optimum, 7013);
});

Deno.test("loadInstance returns pcb442 with 442 cities and optimum 50778", () => {
  const inst = loadInstance("pcb442");
  assertEquals(inst.name, "pcb442");
  assertEquals(inst.cities.length, 442);
  assertEquals(inst.optimum, 50778);
});

Deno.test("every pcb442 city has finite x and y", () => {
  const { cities } = loadInstance("pcb442");
  for (const c of cities) {
    assert(Number.isFinite(c.x), `non-finite x ${c.x}`);
    assert(Number.isFinite(c.y), `non-finite y ${c.y}`);
  }
});

Deno.test("tourLength is invariant under tour reversal (pcb442)", () => {
  const { cities } = loadInstance("pcb442");
  const forward = cities.map((_, i) => i);
  const reversed = [...forward].reverse();
  assertAlmostEquals(tourLength(cities, forward), tourLength(cities, reversed), 1e-6);
});

Deno.test("nearestNeighbourTour visits every pcb442 city exactly once", () => {
  const { cities } = loadInstance("pcb442");
  const tour = nearestNeighbourTour(cities, 0);
  assertEquals(tour.length, 442);
  assertEquals(tour[0], 0);
  const seen = new Set(tour);
  assertEquals(seen.size, 442);
  for (let i = 0; i < 442; i++) {
    assert(seen.has(i), `city ${i} missing from NN tour`);
  }
});

Deno.test("boundingBoxDiagonal is positive on pcb442", () => {
  assert(boundingBoxDiagonal(loadInstance("pcb442").cities) > 0);
});

Deno.test("loadInstance rejects an unknown instance name", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => loadInstance("does-not-exist" as any),
    Error,
    "Unknown TSPLIB instance",
  );
});

Deno.test("euclideanDistance is symmetric for every burma14 pair", () => {
  const { cities } = loadInstance("burma14");
  for (let i = 0; i < cities.length; i++) {
    for (let j = 0; j < cities.length; j++) {
      const ab = euclideanDistance(cities[i], cities[j]);
      const ba = euclideanDistance(cities[j], cities[i]);
      assertAlmostEquals(ab, ba, 1e-12);
    }
  }
});

Deno.test("tourLength computes the perimeter of a unit square", () => {
  const square: TspCity[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  // Going around the square and returning to start is exactly 4 units.
  assertAlmostEquals(tourLength(square, [0, 1, 2, 3]), 4, 1e-12);
  // A diagonal-crossing permutation is 2 + 2*sqrt(2).
  assertAlmostEquals(tourLength(square, [0, 2, 1, 3]), 2 + 2 * Math.sqrt(2), 1e-12);
});

Deno.test("tourLength is invariant under tour reversal (burma14)", () => {
  // Issue #489: this invariant is independent of the specific instance —
  // tour reversal symmetry is a property of `tourLength` itself, not of
  // any particular TSP problem. The duplicate `(ulysses22)` test was
  // removed because it asserts exactly the same observable behaviour
  // on the same equivalence class of inputs (any TSP tour).
  const { cities } = loadInstance("burma14");
  const forward = cities.map((_, i) => i);
  const reversed = [...forward].reverse();
  assertAlmostEquals(tourLength(cities, forward), tourLength(cities, reversed), 1e-9);
});

Deno.test("tourLength rejects a tourOrder of the wrong length", () => {
  const { cities } = loadInstance("burma14");
  assertThrows(() => tourLength(cities, [0, 1, 2]), Error, "does not match");
});

Deno.test("tourLength returns 0 for an empty city list", () => {
  assertEquals(tourLength([], []), 0);
});

Deno.test("boundingBoxDiagonal computes the diagonal of the enclosing box", () => {
  const cities: TspCity[] = [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 0, y: 4 },
  ];
  // Bounding box is 3 wide by 4 tall — classic 3-4-5 triangle, diagonal 5.
  assertAlmostEquals(boundingBoxDiagonal(cities), 5, 1e-12);
});

Deno.test("boundingBoxDiagonal returns 0 for an empty city list", () => {
  assertEquals(boundingBoxDiagonal([]), 0);
});

Deno.test("boundingBoxDiagonal is positive on the embedded instances", () => {
  assert(boundingBoxDiagonal(loadInstance("burma14").cities) > 0);
  assert(boundingBoxDiagonal(loadInstance("ulysses22").cities) > 0);
});

Deno.test("nearestNeighbourTour visits every burma14 city exactly once", () => {
  const { cities } = loadInstance("burma14");
  const tour = nearestNeighbourTour(cities, 0);
  assertEquals(tour.length, cities.length);
  assertEquals(tour[0], 0);
  const seen = new Set(tour);
  assertEquals(seen.size, cities.length);
  for (let i = 0; i < cities.length; i++) {
    assert(seen.has(i), `city ${i} missing from NN tour`);
  }
});

Deno.test("nearestNeighbourTour is deterministic for the same start", () => {
  const { cities } = loadInstance("ulysses22");
  const a = nearestNeighbourTour(cities, 3);
  const b = nearestNeighbourTour(cities, 3);
  assertEquals(a, b);
});

Deno.test("nearestNeighbourTour picks the obvious neighbour on a known layout", () => {
  // Cities arranged in a straight line; from index 0 the NN tour is just
  // the indices in order.
  const line: TspCity[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
  ];
  assertEquals(nearestNeighbourTour(line, 0), [0, 1, 2, 3]);
  assertEquals(nearestNeighbourTour(line, 3), [3, 2, 1, 0]);
});

Deno.test("nearestNeighbourTour rejects an out-of-range start index", () => {
  const { cities } = loadInstance("burma14");
  assertThrows(() => nearestNeighbourTour(cities, -1), Error, "out of range");
  assertThrows(() => nearestNeighbourTour(cities, cities.length), Error, "out of range");
});

Deno.test("nearestNeighbourTour returns an empty tour for no cities", () => {
  assertEquals(nearestNeighbourTour([], 0), []);
});
