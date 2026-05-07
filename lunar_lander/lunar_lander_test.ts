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
import { DEFAULT_TERRAIN, initialState, type LanderState } from "./physics.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

/**
 * A fast, deterministic configuration suitable for unit tests.
 *
 * Issue #72: with the lander now entering off-pad and drifting, random
 * members of the population are more prone to drift out-of-bounds
 * (heavy fixed penalty), so a slightly larger population and a few
 * extra generations are needed to keep the mean score reliably above
 * the free-fall baseline.
 */
const TEST_EVOLVE_OPTIONS = {
  seed: 42,
  populationSize: 28,
  maxGenerations: 24,
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
  "evolveLanderController finds a non-trivial controller (champion exceeds free-fall baseline)",
  () => {
    // Issue #72: the lander now enters off-pad and drifting, so a
    // sizeable fraction of mutated children drift past the world
    // bounds (heavy fixed penalty) — the population mean is no longer
    // a reliable signal of progress. The meaningful claim is that the
    // CHAMPION beats free fall by a wide margin, so that's what we
    // assert. Mean is checked to be finite (sanity).
    const baseline = freeFallBaselineScore();
    const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
    assert(
      Number.isFinite(result.finalMeanScore),
      `expected finite mean, got ${result.finalMeanScore}`,
    );
    assertGreater(
      result.bestScore,
      baseline,
      `champion best score should exceed baseline=${baseline}, got ${result.bestScore}`,
    );
    // The champion should beat baseline by a substantial margin —
    // otherwise it has not learnt anything meaningful.
    assertGreater(
      result.bestScore - baseline,
      300,
      `champion should beat baseline by > 300 points, got delta=${
        result.bestScore - baseline
      } (best=${result.bestScore}, baseline=${baseline})`,
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
  // Issue #72: the lander now starts off-pad with horizontal drift, so
  // the first frame's x matches the configured default rather than 0.
  const json = randomCreatureJSON(createDeterministicRandom(5));
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 50);
  const seed = initialState();
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(
    trace[0].state.x,
    seed.x,
    `first frame should match the configured initial x = ${seed.x}`,
  );
  assertEquals(
    trace[0].state.vx,
    seed.vx,
    `first frame should match the configured initial vx = ${seed.vx}`,
  );
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

Deno.test("renderRunSVG embeds SMIL animation elements that loop", () => {
  // Issue #70: the lander screenshot is now an animated SVG showing
  // the descent in motion. The static pose markers remain for static
  // viewers, but additional SMIL `<animate>` elements drive a moving
  // lander icon along the trajectory.
  const json = randomCreatureJSON(createDeterministicRandom(13));
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace);
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 4);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
  assert(
    svg.includes('class="animated-lander"'),
    "expected an animated-lander group",
  );
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

Deno.test("renderRunSVG animates all three thruster flames", () => {
  // Issue #72: the controls (main, left RCS, right RCS) must be visible
  // in the animation, not only in the static pose markers, so the user
  // can see the controller's decisions while watching the descent.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: true, left: true, right: true },
    },
    {
      state: {
        x: -10,
        y: 40,
        vx: 1,
        vy: -2,
        angle: 0.1,
        angularV: 0,
        fuel: 50,
      } as LanderState,
      action: { main: false, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="anim-flame main"'), "expected animated main-thruster flame");
  assert(svg.includes('class="anim-flame left"'), "expected animated left-RCS flame");
  assert(svg.includes('class="anim-flame right"'), "expected animated right-RCS flame");
});

Deno.test("renderRunSVG rotates the animated lander to reflect angle", () => {
  // Issue #72: the lander tilts as the controller fires its RCS
  // thrusters. The animation should mirror that rotation so viewers
  // can connect a tilt to its cause.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: false, left: true, right: false },
    },
    {
      state: {
        x: -10,
        y: 60,
        vx: 1,
        vy: -3,
        angle: 0.2,
        angularV: 0.1,
        fuel: 70,
      } as LanderState,
      action: { main: true, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(
    svg.includes('class="lander-rotor"'),
    "expected an inner rotation group for the animated lander",
  );
  assert(
    svg.includes('type="rotate"'),
    "expected an animateTransform rotation driving the lander tilt",
  );
});

Deno.test("renderRunSVG renders an animated fuel HUD bar", () => {
  // Issue #72: surface the "fighting fuel" budget so the viewer can
  // see fuel drain during the descent.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: true, left: false, right: false },
    },
    {
      state: {
        x: 0,
        y: 0,
        vx: 0,
        vy: -1,
        angle: 0,
        angularV: 0,
        fuel: 30,
      } as LanderState,
      action: { main: false, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="hud-fuel-bar"'), "expected an animated fuel bar element");
  assert(svg.includes(">FUEL<"), "expected a 'FUEL' label on the HUD");
});

Deno.test("renderRunSVG marks the landing pad with a TARGET indicator", () => {
  // Issue #72: the lander must aim for a specific location — make the
  // pad's role as the destination unmistakable with an arrow + label.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: false, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="target-marker"'), "expected a target-marker group");
  assert(svg.includes(">TARGET<"), "expected a 'TARGET' label on the pad indicator");
});
