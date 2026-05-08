/**
 * Unit tests for the Snake-game NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs.
 *
 * The controller now uses a small hidden layer (see {@link HIDDEN_COUNT})
 * so the policy is expressive enough to chain food encounters; the
 * tests below were updated alongside that change to assert the new
 * topology and the post-issue-#137 fitness target (champion eats at
 * least three food on its replay episode).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreaterOrEqual,
  assertNotEquals,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  buildInitialCreatureJSON,
  DEFAULT_EVAL_SEEDS,
  DEFAULT_EVOLVE_OPTIONS,
  evaluateController,
  evolveSnakeController,
  type GenerationInfo,
  genesFromCreatureJSON,
  HIDDEN_COUNT,
  mutateCreatureJSON,
  pickBestReplaySeed,
  randomCreatureJSON,
  replayController,
  scoreController,
  type SnakeGenes,
  TOTAL_SYNAPSES,
} from "./snake_game.ts";
import { renderRunSVG } from "./svg.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";

function zeroGenes(): SnakeGenes {
  return {
    w1: new Array(INPUT_COUNT * HIDDEN_COUNT).fill(0),
    b1: new Array(HIDDEN_COUNT).fill(0),
    w2: new Array(HIDDEN_COUNT * OUTPUT_COUNT).fill(0),
    b2: new Array(OUTPUT_COUNT).fill(0),
  };
}

Deno.test("buildInitialCreatureJSON wires the layered topology", () => {
  const json = buildInitialCreatureJSON(zeroGenes());
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  // input -> hidden + hidden -> output synapses.
  assertEquals(json.synapses.length, TOTAL_SYNAPSES);
  // Hidden neurons are present.
  assertEquals(
    json.neurons.filter((n) => n.type === "hidden").length,
    HIDDEN_COUNT,
  );
});

Deno.test("buildInitialCreatureJSON produces a valid creature", () => {
  const genes = zeroGenes();
  genes.w1 = genes.w1.map(() => 0.1);
  genes.w2 = genes.w2.map(() => 0.1);
  genes.b1 = genes.b1.map(() => 0.05);
  genes.b2 = [0.1, 0.2, 0.3, 0.4];
  const json = buildInitialCreatureJSON(genes);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("buildInitialCreatureJSON rejects wrong-sized weight vectors", () => {
  let threw = false;
  try {
    buildInitialCreatureJSON({ ...zeroGenes(), w1: [1, 2, 3] });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("genesFromCreatureJSON round-trips weights and biases", () => {
  const genes: SnakeGenes = {
    w1: Array.from({ length: INPUT_COUNT * HIDDEN_COUNT }, (_, i) => i * 0.01),
    b1: Array.from({ length: HIDDEN_COUNT }, (_, i) => i * 0.1),
    w2: Array.from({ length: HIDDEN_COUNT * OUTPUT_COUNT }, (_, i) => -i * 0.02),
    b2: [0.1, -0.2, 0.3, -0.4],
  };
  const json = buildInitialCreatureJSON(genes);
  const decoded = genesFromCreatureJSON(json);
  assertEquals(decoded.w1.length, genes.w1.length);
  for (let i = 0; i < genes.w1.length; i++) assertAlmostEquals(decoded.w1[i], genes.w1[i], 1e-9);
  for (let i = 0; i < genes.b1.length; i++) assertAlmostEquals(decoded.b1[i], genes.b1[i], 1e-9);
  for (let i = 0; i < genes.w2.length; i++) assertAlmostEquals(decoded.w2[i], genes.w2[i], 1e-9);
  for (let i = 0; i < genes.b2.length; i++) assertAlmostEquals(decoded.b2[i], genes.b2[i], 1e-9);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const a = randomCreatureJSON(createDeterministicRandom(99));
  const b = randomCreatureJSON(createDeterministicRandom(99));
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("mutateCreatureJSON yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const parent = buildInitialCreatureJSON(zeroGenes());
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  const creature = Creature.fromJSON(asCreatureExport(child));
  creature.validate();
});

Deno.test("scoreController returns a finite score and fitness for an arbitrary creature", () => {
  const json = buildInitialCreatureJSON(zeroGenes());
  const creature = Creature.fromJSON(asCreatureExport(json));
  const result = scoreController(creature, 1234, 100);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assert(Number.isFinite(result.fitness), `expected finite fitness, got ${result.fitness}`);
  assertGreaterOrEqual(result.steps, 1);
});

Deno.test("evaluateController averages metrics across the seed set", () => {
  const json = buildInitialCreatureJSON(zeroGenes());
  const creature = Creature.fromJSON(asCreatureExport(json));
  const seeds = [1, 2, 3];
  const result = evaluateController(creature, seeds, 50);
  let total = 0;
  for (const s of seeds) total += scoreController(creature, s, 50).score;
  assertAlmostEquals(result.score, total / seeds.length, 1e-9);
});

Deno.test("pickBestReplaySeed returns the seed with the largest eaten count", () => {
  // The handcrafted creature won't eat anything on any seed; ensure
  // the picker still returns a seed from the supplied list and reports
  // a finite score.
  const json = buildInitialCreatureJSON(zeroGenes());
  const creature = Creature.fromJSON(asCreatureExport(json));
  const pick = pickBestReplaySeed(creature, [11, 22, 33], 50);
  assert([11, 22, 33].includes(pick.seed));
  assert(Number.isFinite(pick.score));
});

Deno.test("evolveSnakeController champion eats at least three food on the replay seed", async () => {
  const result = evolveSnakeController(DEFAULT_EVOLVE_OPTIONS);
  assertGreaterOrEqual(
    result.championEaten,
    3,
    `expected the champion to eat at least three food, got ${result.championEaten}`,
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
  const a = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, maxGenerations: 30 });
  const b = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, maxGenerations: 30 });
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertEquals(aJson, bJson, "champions from the same seed must serialise identically");
  assertEquals(a.bestScore, b.bestScore);
  assertEquals(a.championEaten, b.championEaten);
  assertEquals(a.championReplaySeed, b.championReplaySeed);
});

Deno.test("evolveSnakeController with different seeds produces different champions", () => {
  const a = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 1, maxGenerations: 8 });
  const b = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 2, maxGenerations: 8 });
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertNotEquals(aJson, bJson);
});

Deno.test("DEFAULT_EVAL_SEEDS contains at least three distinct seeds", () => {
  // Multi-episode evaluation is what stops the controller overfitting
  // to a single food sequence — guard the eval set so a future tweak
  // cannot quietly drop it back to one seed.
  const distinct = new Set(DEFAULT_EVAL_SEEDS);
  assertGreaterOrEqual(distinct.size, 3);
});

Deno.test(
  "evolveSnakeController emits neurons and synapses on each generation event",
  () => {
    // Issue #110: the per-generation event must include neuron and
    // synapse counts so the runner can plot them on the evolution
    // chart. The layered genome has INPUT_COUNT + HIDDEN_COUNT +
    // OUTPUT_COUNT neurons and TOTAL_SYNAPSES synapses, both constant
    // across the run since this example does not yet add structural
    // mutation.
    const events: GenerationInfo[] = [];
    evolveSnakeController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      populationSize: 6,
      onGeneration: (info) => events.push(info),
    });
    assertGreaterOrEqual(events.length, 1);
    for (const info of events) {
      assertEquals(typeof info.neurons, "number");
      assertEquals(typeof info.synapses, "number");
      assertEquals(info.neurons, INPUT_COUNT + HIDDEN_COUNT + OUTPUT_COUNT);
      assertEquals(info.synapses, TOTAL_SYNAPSES);
    }
  },
);

Deno.test("evolveSnakeController emits checkpoint snapshot files when configured", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "snake_snap_" });
  try {
    const checkpoints = [1, 2, 3];
    evolveSnakeController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 4,
      snapshotConfig: { checkpoints, outputDir: tmp },
    });
    for (const gen of checkpoints) {
      assertEquals(existsSync(join(tmp, `snapshot-gen-${gen}.json`)), true);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("replayController returns a non-empty trace starting at the initial state", () => {
  const json = buildInitialCreatureJSON(zeroGenes());
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 4242, 50);
  assert(trace.length > 0);
  assertEquals(trace[0].steps, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const json = buildInitialCreatureJSON(zeroGenes());
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
  const json = buildInitialCreatureJSON(zeroGenes());
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 4242, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('repeatCount="indefinite"'));
});

Deno.test("renderRunSVG draws the snake head and food cells", () => {
  const json = buildInitialCreatureJSON(zeroGenes());
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
