/**
 * Unit tests for the maze-navigation NEAT controller. "What" tests
 * only — each test calls a real function, runs the simulator or
 * evolver, and asserts on the observable outputs.
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
  evolveMazeController,
  genesFromCreatureJSON,
  mutateCreatureJSON,
  randomCreatureJSON,
  replayController,
  scoreController,
} from "./maze_navigation.ts";
import { renderRunSVG } from "./svg.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";

Deno.test("buildInitialCreatureJSON has 5 inputs and 4 outputs", () => {
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
  const result = scoreController(creature, 50);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assertGreaterOrEqual(result.steps, 1);
});

Deno.test("evolveMazeController champion reaches the goal within the step cap", async () => {
  const result = evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
  assertEquals(
    result.championReached,
    true,
    `expected the champion to reach the goal, got finalDistance=${result.championFinalDistance}`,
  );
  // Champion must serialise cleanly for downstream consumption.
  const tmp = await Deno.makeTempDir({ prefix: "maze_test_" });
  try {
    const path = join(tmp, "champion.json");
    await safeWriteJson(path, result.champion.exportJSON());
    assertEquals(existsSync(path), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("evolveMazeController is reproducible — fixed seed produces byte-identical champions", () => {
  const a = evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
  const b = evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertEquals(aJson, bJson, "champions from the same seed must serialise identically");
  assertEquals(a.bestScore, b.bestScore);
  assertEquals(a.championReached, b.championReached);
});

Deno.test("evolveMazeController with different seeds produces different champions", () => {
  const a = evolveMazeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 1, maxGenerations: 5 });
  const b = evolveMazeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 2, maxGenerations: 5 });
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertNotEquals(aJson, bJson);
});

Deno.test("replayController returns a non-empty trace starting at the start cell", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 50);
  assert(trace.length > 0);
  assertEquals(trace[0].steps, 0);
  assertEquals(trace[0].position, trace[0].maze.start);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Agent cx/cy, goal pulse opacity, progress bar width.
  assertGreaterOrEqual(animateMatches.length, 4);
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('repeatCount="indefinite"'));
});

Deno.test("renderRunSVG draws the agent circle, footprint polyline, and goal pulse", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="agent"'), "expected the agent circle");
  assert(svg.includes('class="footprint"'), "expected the footprint polyline");
  assert(svg.includes('class="goal-pulse"'), "expected the goal pulse overlay");
  assert(svg.includes('class="walls"'), "expected the walls group");
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
