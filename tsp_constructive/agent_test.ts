/**
 * Unit tests for the TSP-constructive agent.
 *
 * "What" tests only — call the encoder/decoder with known inputs and
 * assert on the returned values. No grepping or implementation peeking.
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";

import { boundingBoxDiagonal, loadInstance, type TspCity } from "../common/tsp_instances.ts";

import {
  type Candidate,
  decodeAction,
  encodeObservation,
  INPUT_COUNT,
  K_NEAREST,
  kNearestUnvisited,
  OUTPUT_COUNT,
} from "./agent.ts";

const TINY_CITIES: ReadonlyArray<TspCity> = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 5, y: 0 },
];

Deno.test("INPUT_COUNT layout = 2*K + padded + 2 (prev heading)", () => {
  assertEquals(INPUT_COUNT, K_NEAREST * 2 + 1 + 2);
  assertEquals(OUTPUT_COUNT, K_NEAREST);
});

Deno.test("kNearestUnvisited returns nearest cities in ascending distance order", () => {
  // From city 0, the order (by distance) is 1, 2, 3.
  const visited = [true, false, false, false];
  const result = kNearestUnvisited(TINY_CITIES, 0, visited);
  assertEquals(result.map((c) => c.cityIndex), [1, 2, 3]);
  assertAlmostEquals(result[0].distance, 1, 1e-9);
  assertAlmostEquals(result[1].distance, 2, 1e-9);
  assertAlmostEquals(result[2].distance, 5, 1e-9);
});

Deno.test("kNearestUnvisited skips visited and current cities", () => {
  // From city 0, with 1 already visited, the order is 2, 3.
  const visited = [true, true, false, false];
  const result = kNearestUnvisited(TINY_CITIES, 0, visited);
  assertEquals(result.map((c) => c.cityIndex), [2, 3]);
});

Deno.test("kNearestUnvisited caps at K", () => {
  const cities = Array.from(
    { length: 20 },
    (_, i): TspCity => ({ x: i, y: 0 }),
  );
  const visited = cities.map(() => false);
  visited[0] = true;
  const result = kNearestUnvisited(cities, 0, visited);
  assertEquals(result.length, K_NEAREST);
  // Closest five to city 0 (x=0) are 1..5.
  assertEquals(result.map((c) => c.cityIndex), [1, 2, 3, 4, 5]);
});

Deno.test("kNearestUnvisited breaks distance ties by lower city index", () => {
  const cities: TspCity[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 }, // same distance from city 0 as city 1
  ];
  const visited = [true, false, false];
  const result = kNearestUnvisited(cities, 0, visited);
  assertEquals(result.map((c) => c.cityIndex), [1, 2]);
});

Deno.test("encodeObservation produces INPUT_COUNT values", () => {
  const visited = [true, false, false, false];
  const candidates = kNearestUnvisited(TINY_CITIES, 0, visited);
  const obs = encodeObservation(TINY_CITIES, 0, candidates, [0, 0]);
  assertEquals(obs.length, INPUT_COUNT);
});

Deno.test("encodeObservation — dx/dy normalised by diagonal, sign reflects direction", () => {
  // Use TINY_CITIES with diagonal sqrt(25) = 5.
  const visited = [true, false, false, false];
  const candidates = kNearestUnvisited(TINY_CITIES, 0, visited);
  const diag = boundingBoxDiagonal(TINY_CITIES);
  const obs = encodeObservation(TINY_CITIES, 0, candidates, [0, 0], diag);
  // Slot 0 → city 1 at (1,0), current (0,0): dx=1/5=0.2, dy=0.
  assertAlmostEquals(obs[0], 1 / 5, 1e-6);
  assertAlmostEquals(obs[1], 0, 1e-6);
  // Slot 1 → city 2 at (2,0): dx=2/5=0.4, dy=0.
  assertAlmostEquals(obs[2], 2 / 5, 1e-6);
  // Padded flag — three candidates fit into K_NEAREST=5 with two padded slots → 1.
  assertEquals(obs[K_NEAREST * 2], 1);
});

Deno.test("encodeObservation — symmetric inputs produce symmetric channels", () => {
  // Two configurations that are mirror images about the y-axis must
  // produce sign-flipped `dx` channels and identical `dy` channels.
  const left: TspCity[] = [
    { x: 0, y: 0 },
    { x: -1, y: 1 },
    { x: -2, y: 0 },
    { x: -3, y: -1 },
  ];
  const right: TspCity[] = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 0 },
    { x: 3, y: -1 },
  ];
  const visited = [true, false, false, false];
  const lc = kNearestUnvisited(left, 0, visited);
  const rc = kNearestUnvisited(right, 0, visited);
  const obsL = encodeObservation(left, 0, lc, [0, 0]);
  const obsR = encodeObservation(right, 0, rc, [0, 0]);
  for (let slot = 0; slot < K_NEAREST; slot++) {
    assertAlmostEquals(obsL[slot * 2], -obsR[slot * 2], 1e-6, `dx slot ${slot}`);
    assertAlmostEquals(obsL[slot * 2 + 1], obsR[slot * 2 + 1], 1e-6, `dy slot ${slot}`);
  }
});

Deno.test("encodeObservation — padded flag is 0 when K candidates exist", () => {
  const burma14 = loadInstance("burma14");
  const visited = new Array(burma14.cities.length).fill(false);
  visited[0] = true;
  const cands = kNearestUnvisited(burma14.cities, 0, visited);
  assertEquals(cands.length, K_NEAREST);
  const obs = encodeObservation(burma14.cities, 0, cands, [0, 0]);
  assertEquals(obs[K_NEAREST * 2], 0);
});

Deno.test("encodeObservation — previous heading normalised, zero on first step", () => {
  const visited = [true, false, false, false];
  const candidates = kNearestUnvisited(TINY_CITIES, 0, visited);
  const diag = boundingBoxDiagonal(TINY_CITIES);
  const obs = encodeObservation(TINY_CITIES, 0, candidates, [0, 0], diag);
  assertEquals(obs[INPUT_COUNT - 2], 0);
  assertEquals(obs[INPUT_COUNT - 1], 0);
  const obs2 = encodeObservation(TINY_CITIES, 0, candidates, [diag, 0], diag);
  assertAlmostEquals(obs2[INPUT_COUNT - 2], 1, 1e-6);
  assertAlmostEquals(obs2[INPUT_COUNT - 1], 0, 1e-6);
});

Deno.test("encodeObservation rejects zero or non-finite diagonal", () => {
  const visited = [true, false, false, false];
  const candidates = kNearestUnvisited(TINY_CITIES, 0, visited);
  assertThrows(() => encodeObservation(TINY_CITIES, 0, candidates, [0, 0], 0));
  assertThrows(() => encodeObservation(TINY_CITIES, 0, candidates, [0, 0], -1));
  assertThrows(() => encodeObservation(TINY_CITIES, 0, candidates, [0, 0], NaN));
});

Deno.test("decodeAction picks the argmax slot over real candidates only", () => {
  const candidates: Candidate[] = [
    { cityIndex: 1, distance: 1 },
    { cityIndex: 2, distance: 2 },
    { cityIndex: 3, distance: 3 },
  ];
  // Output for slot 2 is highest among the first three; slot 4 is padded
  // and must be ignored even when its value is the global max.
  const outputs = [0.1, 0.5, 0.9, 0.0, 99.0];
  assertEquals(decodeAction(outputs, candidates), 2);
});

Deno.test("decodeAction is deterministic on ties (lowest slot wins)", () => {
  const candidates: Candidate[] = [
    { cityIndex: 1, distance: 1 },
    { cityIndex: 2, distance: 2 },
    { cityIndex: 3, distance: 3 },
  ];
  // All equal → slot 0.
  assertEquals(decodeAction([0.5, 0.5, 0.5], candidates), 0);
});

Deno.test("decodeAction throws when no candidates are available", () => {
  assertThrows(() => decodeAction([0.1, 0.2, 0.3, 0.4, 0.5], []));
});

Deno.test("decodeAction picks every slot when given a one-hot input", () => {
  const candidates: Candidate[] = [
    { cityIndex: 1, distance: 1 },
    { cityIndex: 2, distance: 2 },
    { cityIndex: 3, distance: 3 },
    { cityIndex: 4, distance: 4 },
    { cityIndex: 5, distance: 5 },
  ];
  for (let slot = 0; slot < K_NEAREST; slot++) {
    const outputs = new Array(K_NEAREST).fill(0);
    outputs[slot] = 1;
    assertEquals(decodeAction(outputs, candidates), slot);
  }
});

Deno.test("kNearestUnvisited rejects mismatched visited length", () => {
  assertThrows(() => kNearestUnvisited(TINY_CITIES, 0, [false, false]));
});

Deno.test("kNearestUnvisited rejects out-of-range currentIndex", () => {
  assertThrows(() => kNearestUnvisited(TINY_CITIES, 99, [false, false, false, false]));
});

Deno.test("burma14 has at least K_NEAREST cities within reach from every city", () => {
  // Sanity-check the action-space envelope: at step 1 there are 13
  // unvisited cities, well above K_NEAREST=5.
  const burma14 = loadInstance("burma14");
  const visited = new Array(burma14.cities.length).fill(false);
  for (let start = 0; start < burma14.cities.length; start++) {
    visited[start] = true;
    const cands = kNearestUnvisited(burma14.cities, start, visited);
    assertEquals(cands.length, K_NEAREST, `start=${start}`);
    visited[start] = false;
  }
});

Deno.test("first softmax-argmax on the noise seed produces deterministic, in-range action", () => {
  // The encoder is fully deterministic, so any random output vector
  // picks a single deterministic slot. Smoke-test that the slot index
  // is always within `[0, candidates.length)`.
  const burma14 = loadInstance("burma14");
  const visited = new Array(burma14.cities.length).fill(false);
  visited[0] = true;
  const cands = kNearestUnvisited(burma14.cities, 0, visited);
  for (let trial = 0; trial < 20; trial++) {
    const outputs = Array.from({ length: K_NEAREST }, (_, i) => Math.sin(trial * 7 + i));
    const slot = decodeAction(outputs, cands);
    assert(slot >= 0 && slot < cands.length);
  }
});
