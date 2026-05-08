/**
 * Unit tests for the Mountain-Car NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 */
import {
  assert,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertNotEquals,
} from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import {
  buildInitialCreatureJSON,
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  evolveMountainCarController,
  type GenerationInfo,
  genesFromCreatureJSON,
  INPUT_COUNT,
  MAX_STEPS,
  mutateCreatureJSON,
  OUTPUT_COUNT,
  randomCreatureJSON,
  replayController,
  scoreController,
  scoreSwingUpPolicy,
  SUCCESS_BONUS,
} from "./mountain_car.ts";
import { renderRunSVG } from "./svg.ts";
import { GOAL_POSITION } from "./physics.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

Deno.test("buildInitialCreatureJSON has 2 inputs and 3 outputs", () => {
  const json = buildInitialCreatureJSON([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [0.1, 0.2, 0.3]);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  assertEquals(json.synapses.length, INPUT_COUNT * OUTPUT_COUNT);
});

Deno.test("buildInitialCreatureJSON produces a valid creature", () => {
  const json = buildInitialCreatureJSON([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [0.1, 0.2, 0.3]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("buildInitialCreatureJSON rejects wrong-sized weight vectors", () => {
  let threw = false;
  try {
    buildInitialCreatureJSON([1, 2, 3], [0, 0, 0]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "expected an error for the wrong number of weights");
});

Deno.test("genesFromCreatureJSON round-trips the weights and biases", () => {
  const weights = [0.11, -0.22, 0.33, -0.44, 0.55, -0.66];
  const biases: [number, number, number] = [0.1, -0.2, 0.3];
  const json = buildInitialCreatureJSON(weights, biases);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights, weights);
  assertEquals(genes.biases, biases);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const r1 = createDeterministicRandom(99);
  const r2 = createDeterministicRandom(99);
  assertEquals(randomCreatureJSON(r1), randomCreatureJSON(r2));
});

Deno.test("mutateCreatureJSON yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const parent = buildInitialCreatureJSON([0, 0, 0, 0, 0, 0], [0, 0, 0]);
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  const creature = Creature.fromJSON(asCreatureExport(child));
  creature.validate();
});

Deno.test("decodeAction picks the argmax over the three outputs", () => {
  // Index 0 highest → push left.
  assertEquals(decodeAction([0.9, 0.1, 0.2]), -1);
  // Index 1 highest → coast.
  assertEquals(decodeAction([0.1, 0.9, 0.2]), 0);
  // Index 2 highest → push right.
  assertEquals(decodeAction([0.1, 0.2, 0.9]), 1);
});

Deno.test("scoreSwingUpPolicy solves the task with a score above the failure baseline", () => {
  const result = scoreSwingUpPolicy(MAX_STEPS);
  assertEquals(result.solved, true, "swing-up policy should solve the task");
  assertGreater(result.score, 0, "successful run must score above the failure baseline");
  // Successful run scores SUCCESS_BONUS minus a per-step penalty < SUCCESS_BONUS.
  assertGreaterOrEqual(SUCCESS_BONUS, result.score);
});

Deno.test("scoreController returns a finite score for an arbitrary creature", () => {
  const json = buildInitialCreatureJSON([0, 0, 0, 0, 0, 0], [0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const result = scoreController(creature, MAX_STEPS);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assertGreaterOrEqual(result.steps, 0);
  assertGreaterOrEqual(MAX_STEPS, result.steps);
});

Deno.test(
  "evolveMountainCarController finds a champion that crosses x >= 0.5 with the default seed",
  async () => {
    const result = evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion to solve the task, got score=${result.bestScore} ` +
        `after ${result.generations} generations`,
    );
    // Champion must serialise cleanly for downstream consumption.
    const tmp = await Deno.makeTempDir({ prefix: "mountain_car_test_" });
    try {
      const path = join(tmp, "champion.json");
      await safeWriteJson(path, result.champion.exportJSON());
      assertEquals(existsSync(path), true);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveMountainCarController is reproducible — fixed seed yields a byte-identical champion",
  () => {
    const a = evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
    const b = evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
    const aJson = JSON.stringify(a.champion.exportJSON());
    const bJson = JSON.stringify(b.champion.exportJSON());
    assertEquals(aJson, bJson, "champions from the same seed must serialise identically");
    assertEquals(a.bestScore, b.bestScore);
    assertEquals(a.championSteps, b.championSteps);
  },
);

Deno.test(
  "evolveMountainCarController with a different seed produces a different champion",
  () => {
    const a = evolveMountainCarController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 1 });
    const b = evolveMountainCarController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 2 });
    const aJson = JSON.stringify(a.champion.exportJSON());
    const bJson = JSON.stringify(b.champion.exportJSON());
    assertNotEquals(aJson, bJson, "different seeds should explore different genomes");
  },
);

Deno.test(
  "evolveMountainCarController emits neurons and synapses on each generation event",
  () => {
    // Issue #109: the per-generation event must include neuron and
    // synapse counts so the runner can plot them on the evolution
    // chart. The linear genome has INPUT_COUNT + OUTPUT_COUNT neurons
    // and INPUT_COUNT * OUTPUT_COUNT synapses, both constant across the
    // run since this example does not yet add structural mutation.
    const events: GenerationInfo[] = [];
    evolveMountainCarController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      populationSize: 6,
      onGeneration: (info) => events.push(info),
    });
    assertGreaterOrEqual(events.length, 1);
    for (const info of events) {
      assertEquals(typeof info.neurons, "number");
      assertEquals(typeof info.synapses, "number");
      assertEquals(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertEquals(info.synapses, INPUT_COUNT * OUTPUT_COUNT);
    }
  },
);

Deno.test("replayController returns a non-empty trace starting at the initial state", () => {
  const json = buildInitialCreatureJSON([1, -1, 0, 0, -1, 1], [0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 50);
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(trace[0].x, -0.5);
  assertEquals(trace[0].v, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const json = buildInitialCreatureJSON([1, -1, 0, 0, -1, 1], [0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Three on the car (cx, cy, fill) plus one on the progress bar.
  assertGreaterOrEqual(animateMatches.length, 4);
});

Deno.test("renderRunSVG draws the goal flag", () => {
  const json = buildInitialCreatureJSON([1, -1, 0, 0, -1, 1], [0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="goal"'), "expected the goal flag group");
  assert(svg.includes('class="hill"'), "expected the hill profile path");
  assert(svg.includes('class="car"'), "expected the animated car");
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const json = buildInitialCreatureJSON([1, -1, 0, 0, -1, 1], [0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
});

Deno.test("renderRunSVG colour change appears once the trace crosses the flag line", () => {
  // Synthesise a trace that ends past the flag — we just want to
  // confirm the renderer emits the success colour somewhere in the
  // fill-keyframe list when the trace crosses the threshold.
  const trace = [
    { x: -0.5, v: 0 },
    { x: 0.0, v: 0.05 },
    { x: GOAL_POSITION, v: 0.06 },
    { x: 0.55, v: 0.06 },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes("#2ecc71"), "expected the success-green keyframe in the fill animation");
});

Deno.test(
  "running mountain_car.ts via run.sh-style execution emits champion.json and SVG",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mountain_car_smoke_" });
    try {
      ensureDirSync(join(tmp, "screenshots"));
      const result = evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
      const trace = replayController(result.champion);
      const svg = renderRunSVG(trace);
      const svgPath = join(tmp, "screenshots", "mountain_car.svg");
      await Deno.writeTextFile(svgPath, svg);
      const written = await Deno.readTextFile(svgPath);
      assert(written.startsWith("<svg"));
      const championPath = join(tmp, "champion.json");
      await safeWriteJson(championPath, result.champion.exportJSON());
      assertEquals(existsSync(championPath), true);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
