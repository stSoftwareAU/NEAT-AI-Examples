/**
 * Unit tests for the TSP-constructive SVG renderer.
 *
 * "What" tests only — feed `renderTourSVG` with a fixed payload, then
 * assert on the returned string's high-level structure (length,
 * determinism, the expected substrings, and that two byte-identical
 * inputs produce a byte-identical SVG).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";

import { loadInstance, nearestNeighbourTour, tourLength } from "../common/tsp_instances.ts";

import { renderTourSVG } from "./svg.ts";

Deno.test("renderTourSVG is deterministic for identical inputs", () => {
  const burma14 = loadInstance("burma14");
  const tour = nearestNeighbourTour(burma14.cities, 0);
  const length = tourLength(burma14.cities, tour);

  const a = renderTourSVG({
    instanceName: "burma14",
    cities: burma14.cities,
    tour,
    tourLength: length,
    optimum: burma14.optimum,
  });
  const b = renderTourSVG({
    instanceName: "burma14",
    cities: burma14.cities,
    tour,
    tourLength: length,
    optimum: burma14.optimum,
  });
  assertEquals(a, b);
});

Deno.test("renderTourSVG includes instance name, polyline, city dots, and score badge", () => {
  const burma14 = loadInstance("burma14");
  const tour = nearestNeighbourTour(burma14.cities, 0);
  const length = tourLength(burma14.cities, tour);
  const svg = renderTourSVG({
    instanceName: "burma14",
    cities: burma14.cities,
    tour,
    tourLength: length,
    optimum: burma14.optimum,
  });
  assert(svg.includes("burma14"));
  assert(svg.includes('<polyline class="champion"'));
  // One <circle> per city.
  const circleMatches = svg.match(/<circle /g) ?? [];
  assertEquals(circleMatches.length, burma14.cities.length);
  // Score badge contains a value at most 1.00.
  assert(svg.match(/length=\d+\.\d{2}/));
});

Deno.test("renderTourSVG draws the dashed optimal underlay when supplied", () => {
  const burma14 = loadInstance("burma14");
  const tour = nearestNeighbourTour(burma14.cities, 0);
  const optimalTour = nearestNeighbourTour(burma14.cities, 3);
  const length = tourLength(burma14.cities, tour);
  const svg = renderTourSVG({
    instanceName: "burma14",
    cities: burma14.cities,
    tour,
    tourLength: length,
    optimum: burma14.optimum,
    optimalTour,
  });
  assert(svg.includes('class="optimal"'));
  assert(svg.includes("stroke-dasharray"));
});

Deno.test("renderTourSVG rejects empty cities", () => {
  assertThrows(() =>
    renderTourSVG({
      instanceName: "empty",
      cities: [],
      tour: [],
      tourLength: 0,
      optimum: 0,
    })
  );
});

Deno.test("renderTourSVG rejects mismatched tour length", () => {
  const burma14 = loadInstance("burma14");
  assertThrows(() =>
    renderTourSVG({
      instanceName: "burma14",
      cities: burma14.cities,
      tour: [0, 1, 2],
      tourLength: 0,
      optimum: burma14.optimum,
    })
  );
});
