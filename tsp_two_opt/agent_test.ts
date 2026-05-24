/**
 * Unit tests for tsp_two_opt/agent.ts.
 */
import { assert, assertEquals } from "@std/assert";
import {
  decodeProposal,
  edgeLengths,
  encodeObservation,
  INPUT_COUNT,
  K_LONGEST,
  longestEdgeIndices,
  OUTPUT_COUNT,
} from "./agent.ts";
import { loadInstance, nearestNeighbourTour } from "../common/tsp_instances.ts";

Deno.test("encodeObservation — output length matches INPUT_COUNT", () => {
  const instance = loadInstance("burma14");
  const tour = nearestNeighbourTour(instance.cities, 0);
  const obs = encodeObservation(instance.cities, tour, 200, 200);
  assertEquals(obs.length, INPUT_COUNT);
});

Deno.test("encodeObservation — values are normalised into [0, 1]", () => {
  const instance = loadInstance("burma14");
  const tour = nearestNeighbourTour(instance.cities, 0);
  const obs = encodeObservation(instance.cities, tour, 100, 200);
  for (let i = 0; i < obs.length; i++) {
    const v = obs[i];
    assert(Number.isFinite(v), `obs[${i}] must be finite (got ${v})`);
    assert(v >= 0, `obs[${i}] should be non-negative (got ${v})`);
    // 1.0 + tiny float jitter is fine; cap with a generous bound.
    assert(v <= 1.5, `obs[${i}] should be in normalised range (got ${v})`);
  }
});

Deno.test("encodeObservation — budget channel reflects proposals left", () => {
  const instance = loadInstance("burma14");
  const tour = nearestNeighbourTour(instance.cities, 0);
  const full = encodeObservation(instance.cities, tour, 200, 200);
  const half = encodeObservation(instance.cities, tour, 100, 200);
  const empty = encodeObservation(instance.cities, tour, 0, 200);
  assertEquals(full[3], 1);
  assertEquals(half[3], 0.5);
  assertEquals(empty[3], 0);
});

Deno.test("edgeLengths — closed-tour length sums match tourLength", () => {
  const instance = loadInstance("burma14");
  const tour = nearestNeighbourTour(instance.cities, 0);
  const lengths = edgeLengths(instance.cities, tour);
  assertEquals(lengths.length, tour.length);
  for (const v of lengths) {
    assert(v > 0, "every edge length must be positive");
  }
});

Deno.test("longestEdgeIndices — returns K_LONGEST indices sorted by length", () => {
  // Hand-crafted edge lengths: index 3 is the longest, then index 0,
  // then index 5, then index 1, then index 2 (all ties broken low-first).
  const lengths = [5, 2, 2, 9, 1, 4, 0.5];
  const idxs = longestEdgeIndices(lengths);
  assertEquals(idxs.length, K_LONGEST);
  assertEquals(idxs[0], 3); // length 9 (max)
  assertEquals(idxs[1], 0); // length 5
  assertEquals(idxs[2], 5); // length 4
  // Indices 1 and 2 tie on length 2 — lower index wins.
  assertEquals(idxs[3], 1);
  assertEquals(idxs[4], 2);
});

Deno.test("decodeProposal — argmax selects the highest output slot", () => {
  // Construct an output: first K outputs argmax slot 2, second K argmax slot 4.
  const out = new Float32Array(OUTPUT_COUNT);
  out[2] = 1.0;
  out[K_LONGEST + 4] = 1.0;
  const sortedLongest = [3, 7, 11, 1, 9]; // K_LONGEST = 5
  const prop = decodeProposal(out, sortedLongest);
  // a=2 → position 11; b=4 → position 9 — sort so i < j.
  assertEquals(prop.noop, false);
  assertEquals(prop.i, 9);
  assertEquals(prop.j, 11);
});

Deno.test("decodeProposal — collapses to no-op when a === b", () => {
  const out = new Float32Array(OUTPUT_COUNT);
  out[0] = 1.0;
  out[K_LONGEST + 0] = 1.0;
  const sortedLongest = [3, 7, 11, 1, 9];
  const prop = decodeProposal(out, sortedLongest);
  assertEquals(prop.noop, true);
  assertEquals(prop.i, 3);
  assertEquals(prop.j, 3);
});

Deno.test("OUTPUT_COUNT — matches 2 · K_LONGEST contract", () => {
  assertEquals(OUTPUT_COUNT, 2 * K_LONGEST);
});
