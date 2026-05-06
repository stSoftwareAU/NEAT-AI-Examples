/**
 * Unit tests for the lunar-lander NEAT controller. "What" tests only —
 * each test calls real functions, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import {
  buildInitialCreatureJSON,
  decodeAction,
  evolveLanderController,
  freeFallBaselineScore,
  genesFromCreatureJSON,
  INPUT_COUNT,
  MAX_STEPS,
  mutateCreatureJSON,
  OUTPUT_COUNT,
  randomCreatureJSON,
  replayController,
  scoreController,
  scoreFinalState,
} from "./lunar_lander.ts";
import { renderRunSVG } from "./svg.ts";
import { DEFAULT_TERRAIN, type LanderState } from "./physics.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

/** A fast, deterministic configuration suitable for unit tests. */
const TEST_EVOLVE_OPTIONS = {
  seed: 42,
  populationSize: 18,
  maxGenerations: 18,
  mutationStrength: 0.5,
  mutationRate: 0.4,
};

Deno.test("buildInitialCreatureJSON has 7 inputs and 3 outputs", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0.1);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0]);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  assertEquals(json.synapses.length, INPUT_COUNT * OUTPUT_COUNT);
});

Deno.test("buildInitialCreatureJSON produces a valid creature", () => {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0.1);
  const json = buildInitialCreatureJSON(weights, [0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("genesFromCreatureJSON round-trips weights and biases", () => {
  const weights = Array.from({ length: INPUT_COUNT * OUTPUT_COUNT }, (_, i) => i * 0.01);
  const biases: [number, number, number] = [0.1, -0.2, 0.3];
  const json = buildInitialCreatureJSON(weights, biases);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights.length, weights.length);
  for (let i = 0; i < weights.length; i++) {
    assertAlmostEquals(genes.weights[i], weights[i], 1e-9);
  }
  assertEquals(genes.biases, biases);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const r1 = createDeterministicRandom(7);
  const r2 = createDeterministicRandom(7);
  assertEquals(randomCreatureJSON(r1), randomCreatureJSON(r2));
});

Deno.test("mutateCreatureJSON yields a valid creature", () => {
  const random = createDeterministicRandom(11);
  const parent = randomCreatureJSON(createDeterministicRandom(1));
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  const creature = Creature.fromJSON(asCreatureExport(child));
  creature.validate();
});

Deno.test("decodeAction thresholds outputs at 0.5", () => {
  assertEquals(decodeAction([0.6, 0.4, 0.55]), { main: true, left: false, right: true });
  assertEquals(decodeAction([0.5, 0.5, 0.5]), { main: true, left: true, right: true });
  assertEquals(decodeAction([0, 0, 0]), { main: false, left: false, right: false });
});

Deno.test("scoreFinalState rewards a clean landing more than a crash", () => {
  const cleanLanding: LanderState = {
    x: DEFAULT_TERRAIN.padX,
    y: DEFAULT_TERRAIN.groundY,
    vx: 0,
    vy: -0.5,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  const fastCrash: LanderState = {
    x: DEFAULT_TERRAIN.padX + 30,
    y: DEFAULT_TERRAIN.groundY,
    vx: 5,
    vy: -20,
    angle: 1,
    angularV: 0,
    fuel: 0,
  };
  const cleanScore = scoreFinalState(cleanLanding, "landed");
  const crashScore = scoreFinalState(fastCrash, "crashed");
  assertGreater(cleanScore, crashScore);
  assertGreater(cleanScore, 0);
});

Deno.test("scoreController returns a finite score and a recognised outcome", () => {
  const json = randomCreatureJSON(createDeterministicRandom(3));
  const creature = Creature.fromJSON(asCreatureExport(json));
  const result = scoreController(creature, MAX_STEPS);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assert(
    ["flying", "landed", "crashed", "out_of_bounds"].includes(result.outcome),
    `unknown outcome: ${result.outcome}`,
  );
});

Deno.test("freeFallBaselineScore corresponds to a crash (negative score)", () => {
  const baseline = freeFallBaselineScore();
  // Free fall from ~80 m with lunar gravity reaches ~16 m/s downward —
  // far above the safe-landing limit, so the outcome must be a crash.
  assert(baseline < 0, `expected negative baseline (crash), got ${baseline}`);
});

Deno.test(
  "evolveLanderController finds a non-trivial controller (final mean exceeds free-fall baseline)",
  () => {
    const baseline = freeFallBaselineScore();
    const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
    assertGreater(
      result.finalMeanScore,
      baseline,
      `expected mean reward > free-fall baseline=${baseline}, ` +
        `got mean=${result.finalMeanScore} (best=${result.bestScore})`,
    );
    assertGreater(
      result.bestScore,
      baseline,
      `champion best score should exceed baseline=${baseline}, got ${result.bestScore}`,
    );
  },
);

Deno.test("evolveLanderController is reproducible for the same seed", () => {
  const r1 = evolveLanderController(TEST_EVOLVE_OPTIONS);
  const r2 = evolveLanderController(TEST_EVOLVE_OPTIONS);
  assertEquals(r1.bestScore, r2.bestScore);
  assertEquals(r1.championOutcome, r2.championOutcome);
});

Deno.test("champion JSON exports cleanly to disk", async () => {
  const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
  const tmp = await Deno.makeTempDir({ prefix: "lunar_lander_test_" });
  try {
    const path = join(tmp, "champion.json");
    await safeWriteJson(path, result.champion.exportJSON());
    assertEquals(existsSync(path), true);
    const written = await Deno.readTextFile(path);
    const parsed = JSON.parse(written);
    assert("neurons" in parsed, "exported champion should contain neurons");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("replayController returns a non-empty trace whose first frame is the initial state", () => {
  const json = randomCreatureJSON(createDeterministicRandom(5));
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 50);
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(trace[0].state.x, 0, "first frame should be the initial x = 0");
});

Deno.test("renderRunSVG emits a well-formed SVG with trajectory polyline and pose markers", () => {
  const json = randomCreatureJSON(createDeterministicRandom(13));
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace);

  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");

  // Trajectory polyline
  const polylineMatches = svg.match(/<polyline class="trajectory"/g) ?? [];
  assertEquals(polylineMatches.length, 1, "expected exactly one trajectory polyline");

  // Pose markers (start + mid + end, deduplicated when trace is very short).
  const poseMatches = svg.match(/<g class="pose"/g) ?? [];
  assertGreaterOrEqual(poseMatches.length, 1);
  assert(poseMatches.length <= 3, `expected at most 3 pose groups, got ${poseMatches.length}`);

  // Landing pad is rendered.
  assert(svg.includes('class="pad"'), "expected the pad to be rendered");
});

Deno.test("renderRunSVG draws a flame when the main thruster fires", () => {
  // Hand-craft a single trace frame that fires only the main thruster.
  const trace = [
    {
      state: {
        x: 0,
        y: 80,
        vx: 0,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: true, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="flame main"'), "expected a main-thruster flame marker");
});
