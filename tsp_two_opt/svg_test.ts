/**
 * Unit tests for tsp_two_opt/svg.ts.
 *
 * The side-by-side SVG output must be deterministic given the same
 * tours — both panels should round-trip to identical bytes across runs.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderSideBySideTours } from "./svg.ts";
import { loadInstance, nearestNeighbourTour, tourLength } from "../common/tsp_instances.ts";

Deno.test("renderSideBySideTours — deterministic byte output", () => {
  const instance = loadInstance("burma14");
  const seed = nearestNeighbourTour(instance.cities, 0);
  // Mock "improved" tour: reverse a sub-segment to differ from the seed.
  const improved = seed.slice();
  improved.reverse();

  const opts = {
    cities: instance.cities,
    left: {
      title: "Nearest-neighbour seed",
      tour: seed,
      length: tourLength(instance.cities, seed),
    },
    right: {
      title: "Post-evolution improved",
      tour: improved,
      length: tourLength(instance.cities, improved),
    },
    optimum: instance.optimum,
    instanceName: instance.name,
    proposalBudget: 200,
  };

  const svg1 = renderSideBySideTours(opts);
  const svg2 = renderSideBySideTours(opts);
  assertEquals(svg1, svg2);
});

Deno.test("renderSideBySideTours — header includes instance name + optimum", () => {
  const instance = loadInstance("burma14");
  const seed = nearestNeighbourTour(instance.cities, 0);
  const svg = renderSideBySideTours({
    cities: instance.cities,
    left: {
      title: "NN seed",
      tour: seed,
      length: tourLength(instance.cities, seed),
    },
    right: {
      title: "Improved",
      tour: seed,
      length: tourLength(instance.cities, seed),
    },
    optimum: instance.optimum,
    instanceName: instance.name,
    proposalBudget: 200,
  });
  assertStringIncludes(svg, "tsp_two_opt");
  assertStringIncludes(svg, "burma14");
  assertStringIncludes(svg, String(instance.optimum));
});

Deno.test("renderSideBySideTours — SVG document is well-formed (opens/closes once)", () => {
  const instance = loadInstance("ulysses22");
  const seed = nearestNeighbourTour(instance.cities, 0);
  const svg = renderSideBySideTours({
    cities: instance.cities,
    left: { title: "NN", tour: seed, length: 100 },
    right: { title: "Improved", tour: seed, length: 90 },
    optimum: instance.optimum,
    instanceName: instance.name,
    proposalBudget: 200,
  });
  // Exactly one <svg ...> opening and </svg> closing tag.
  assertEquals((svg.match(/<svg /g) ?? []).length, 1);
  assertEquals((svg.match(/<\/svg>/g) ?? []).length, 1);
  // No NaN or Infinity coordinates.
  assert(!svg.includes("NaN"), "SVG must not contain NaN coordinates");
  assert(!svg.includes("Infinity"), "SVG must not contain Infinity coordinates");
});
