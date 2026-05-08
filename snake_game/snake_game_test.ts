/**
 * Unit tests for the Snake-game NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs.
 */
import { assert, assertEquals, assertGreaterOrEqual, assertNotEquals } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  buildInitialCreatureJSON,
  DEFAULT_EVOLVE_OPTIONS,
  evolveSnakeController,
  genesFromCreatureJSON,
  mutateCreatureJSON,
  randomCreatureJSON,
  replayController,
  scoreController,
} from "./snake_game.ts";
import { renderRunSVG } from "./svg.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";

Deno.test("buildInitialCreatureJSON has 8 inputs and 4 outputs", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  assertEquals(json.synapses.length, INPUT_COUNT * OUTPUT_COUNT);
});

Deno.test("buildInitialCreatureJSON produces a valid creature", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0.1);
  const json = buildInitialCreatureJSON(weights, [0.1, 0.2, 0.3, 0.4]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("buildInitialCreatureJSON rejects wrong-sized weight vectors", () => {
  let threw = false;
  try {
    buildInitialCreatureJSON([1, 2, 3], [0, 0, 0, 0]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("genesFromCreatureJSON round-trips weights and biases", () => {
  const weights: number[] = [];
  for (let i = 0; i < INPUT_COUNT * OUTPUT_COUNT; i++) weights.push(i * 0.01);
  const biases: [number, number, number, number] = [0.1, -0.2, 0.3, -0.4];
  const json = buildInitialCreatureJSON(weights, biases);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights, weights);
  assertEquals(genes.biases, biases);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const a = randomCreatureJSON(createDeterministicRandom(99));
  const b = randomCreatureJSON(createDeterministicRandom(99));
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("mutateCreatureJSON yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const parent = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  const creature = Creature.fromJSON(asCreatureExport(child));
  creature.validate();
});

Deno.test("scoreController returns a finite score for an arbitrary creature", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const result = scoreController(creature, 1234, 100);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assertGreaterOrEqual(result.steps, 1);
});

Deno.test("evolveSnakeController champion eats at least one food item", async () => {
  const result = evolveSnakeController(DEFAULT_EVOLVE_OPTIONS);
  assertGreaterOrEqual(
    result.championEaten,
    1,
    `expected the champion to eat at least one food, got ${result.championEaten}`,
  );
  // Champion must serialise cleanly for downstream consumption.
  const tmp = await Deno.makeTempDir({ prefix: "snake_test_" });
  try {
    const path = join(tmp, "champion.json");
    await safeWriteJson(path, result.champion.exportJSON());
    assertEquals(existsSync(path), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("evolveSnakeController is reproducible — fixed seed, identical champion", () => {
  const a = evolveSnakeController(DEFAULT_EVOLVE_OPTIONS);
  const b = evolveSnakeController(DEFAULT_EVOLVE_OPTIONS);
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertEquals(aJson, bJson, "champions from the same seed must serialise identically");
  assertEquals(a.bestScore, b.bestScore);
  assertEquals(a.championEaten, b.championEaten);
});

Deno.test("evolveSnakeController with different seeds produces different champions", () => {
  const a = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 1, maxGenerations: 8 });
  const b = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 2, maxGenerations: 8 });
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertNotEquals(aJson, bJson);
});

Deno.test("replayController returns a non-empty trace starting at the initial state", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 4242, 50);
  assert(trace.length > 0);
  assertEquals(trace[0].steps, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 4242, 30);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Many animate nodes — food x/y/opacity, score colour, progress bar,
  // and one trio per snake segment.
  assertGreaterOrEqual(animateMatches.length, 6);
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 4242, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('repeatCount="indefinite"'));
});

Deno.test("renderRunSVG draws the snake head and food cells", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 4242, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="snake-head"'), "expected the snake head element");
  assert(svg.includes('class="food"'), "expected the food element");
  assert(svg.includes('class="board"'), "expected the checker board background");
});

Deno.test("renderRunSVG rejects an empty trace", () => {
  let threw = false;
  try {
    renderRunSVG([]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
