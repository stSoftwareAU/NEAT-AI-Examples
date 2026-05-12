/**
 * Unit tests for the cart-pole NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 *
 * Migration notes:
 * - Issue #236 — the controller now evolves through
 *   `Creature.evolveRL()`, so the tests for the removed
 *   `buildRandomPopulation` and `mutateCreatureExport` internal helpers
 *   have been dropped in favour of direct adapter and controller tests.
 * - Issue #288 — per-generation telemetry, snapshot capture, and the
 *   evolution / fitness / topology charts have been replaced by the
 *   milestone-statistics chart from #287. Tests covering the removed
 *   surfaces have been deleted; a new test asserts the milestone-chart
 *   SVG round-trip via `evolveRL` + `renderMilestoneChartSVG`.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import {
  CartPoleAdapter,
  type CartPoleEpisodeState,
  DEFAULT_EVOLVE_OPTIONS,
  evolveCartPoleController,
  INPUT_COUNT,
  MAX_STEPS,
  MILESTONE_SVG_PATH,
  OUTPUT_COUNT,
  replayController,
  scoreController,
  scoreTiltDirectionPolicy,
  SOLVED_THRESHOLD,
  SVG_FRAME_COUNT,
} from "./cart_pole.ts";
import { renderRunSVG } from "./svg.ts";
import { renderMilestoneChartSVG } from "../common/milestone_chart.ts";

Deno.test("CartPoleAdapter advertises 4 inputs and the default 500-step cap", () => {
  const adapter = new CartPoleAdapter();
  assertEquals(adapter.observationLength, INPUT_COUNT);
  assertEquals(adapter.maxSteps(), MAX_STEPS);
  // The library default wall-clock budget is preserved.
  assert(adapter.wallClockMs() > 0);
});

Deno.test("CartPoleAdapter.reset is deterministic for the same seed", () => {
  const adapter = new CartPoleAdapter({ initialPerturbation: 0.1 });
  const a = adapter.reset(7);
  const b = adapter.reset(7);
  assertEquals(Array.from(a.observation), Array.from(b.observation));
  assertEquals(a.state.physics.x, b.state.physics.x);
  assertEquals(a.state.physics.theta, b.state.physics.theta);
  assertEquals(a.state.stepIdx, 0);
});

Deno.test(
  "CartPoleAdapter.step emits zero reward until the terminal failure step",
  () => {
    const adapter = new CartPoleAdapter();
    let state: CartPoleEpisodeState = adapter.reset(1).state;
    // Push hard right every tick — the pole eventually falls past the
    // failure threshold. While it has not failed, reward MUST be zero.
    let priorReward = 0;
    let terminatedStep = -1;
    for (let i = 0; i < MAX_STEPS; i++) {
      const result = adapter.step(state, 1);
      state = result.state;
      if (result.terminated) {
        terminatedStep = i + 1;
        assertEquals(priorReward, 0);
        assert(
          result.reward < 0,
          `expected negative reward on the terminal step, got ${result.reward}`,
        );
        // Reward equals -(MAX_STEPS - stepIdx) / MAX_STEPS, normalised
        // into `[-1, 0]` so `defaultRewardToError` produces a `[0, 1]`
        // error.
        assertEquals(
          result.reward,
          -(MAX_STEPS - terminatedStep) / MAX_STEPS,
        );
        break;
      }
      assertEquals(result.reward, 0);
      priorReward = result.reward;
    }
    assertGreater(terminatedStep, 0, "expected the pole to fall");
  },
);

Deno.test(
  "CartPoleAdapter.decodeAction follows the HARD_TANH sign convention",
  () => {
    const adapter = new CartPoleAdapter();
    const state = adapter.reset(0).state;
    assertEquals(adapter.decodeAction(Float32Array.from([0.7]), state), 1);
    assertEquals(adapter.decodeAction(Float32Array.from([-0.5]), state), -1);
    // Exactly zero is treated as "push right" — matches the legacy
    // scoring path so behaviour stays consistent.
    assertEquals(adapter.decodeAction(Float32Array.from([0]), state), 1);
  },
);

Deno.test("CartPoleAdapter.assertContract passes for a well-formed adapter", () => {
  const adapter = new CartPoleAdapter();
  // Must not throw — the abstract contract is satisfied.
  adapter.assertContract(0);
});

Deno.test("scoreTiltDirectionPolicy beats a 'do nothing' baseline", () => {
  const score = scoreTiltDirectionPolicy(MAX_STEPS);
  assertGreater(
    score,
    50,
    `tilt-direction policy should survive >50 steps, got ${score}`,
  );
});

Deno.test("scoreController returns a value between 0 and MAX_STEPS", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const score = scoreController(creature, MAX_STEPS);
  assertGreaterOrEqual(score, 0);
  assertGreaterOrEqual(MAX_STEPS, score);
});

Deno.test(
  "scoreController with multiple trials returns the mean across trials",
  () => {
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const a = scoreController(creature, MAX_STEPS, {
      trials: 3,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    const b = scoreController(creature, MAX_STEPS, {
      trials: 3,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    assertEquals(a, b);
    assertGreaterOrEqual(a, 0);
    assertGreaterOrEqual(MAX_STEPS, a);
  },
);

Deno.test({
  name: "evolveCartPoleController gen-1 milestone sits well below the threshold",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise: a fresh `new Creature(input, output)` seed
    // and the library's uniform-random structural mutations cannot solve
    // cart-pole under the default wobble regime. Per #298 the only
    // available telemetry is the milestone payload at generation 1.
    const result = await evolveCartPoleController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
    });
    assertGreater(
      result.milestones.length,
      0,
      "expected at least the gen-1 milestone to be collected",
    );
    const first = result.milestones[0];
    assertEquals(
      first.generation,
      1,
      `expected the first milestone to live at generation 1, got ${first.generation}`,
    );
    assert(
      first.meanEpisodeSteps < SOLVED_THRESHOLD / 2,
      `expected the gen-1 mean episode steps to sit below half the threshold ` +
        `(${SOLVED_THRESHOLD / 2}), got ${first.meanEpisodeSteps}`,
    );
    assert(
      first.bestScore < SOLVED_THRESHOLD,
      `expected the gen-1 best score to sit below SOLVED_THRESHOLD=${SOLVED_THRESHOLD} ` +
        `under the wobble regime, got ${first.bestScore}`,
    );
  },
});

Deno.test({
  name: "evolveCartPoleController honours the iterations cap",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // NEAT-AI 5.0.0 requires `timeoutMinutes` to be an integer ≥ 1, so
    // sub-minute wall-clock budgets are no longer expressible there.
    // The standard short-circuit for unit tests is the `iterations`
    // cap. We assert the cap is honoured and the run finishes well
    // inside the surrounding test timeout.
    const start = Date.now();
    const result = await evolveCartPoleController({
      seed: 999,
      populationSize: 4,
      targetError: 0.04,
      timeoutMinutes: 5,
      iterations: 1,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.2,
    });
    const elapsedMs = Date.now() - start;
    assertGreaterOrEqual(
      1,
      result.generations,
      `expected the iterations cap to bound generations to 1, got ${result.generations}`,
    );
    assert(
      elapsedMs < 60_000,
      `expected the run to finish well under 60 seconds, took ${elapsedMs} ms`,
    );
  },
});

Deno.test({
  name: "evolveCartPoleController finds a controller above SOLVED_THRESHOLD with the default seed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion's mean score to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
        `got ${result.bestScore} after ${result.generations} generations`,
    );
    assertGreaterOrEqual(result.bestScore, SOLVED_THRESHOLD);

    const tmp = await Deno.makeTempDir({ prefix: "cart_pole_test_" });
    try {
      const path = join(tmp, "champion.json");
      await safeWriteJson(path, result.champion.exportJSON());
      assertEquals(existsSync(path), true);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "evolveCartPoleController champion generalises to unseen perturbed initial states",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    const independentScore = scoreController(result.champion, MAX_STEPS, {
      trials: 10,
      trialSeed: 987654,
      initialPerturbation: 0.05,
      disturbanceMagnitude: DEFAULT_EVOLVE_OPTIONS.disturbanceMagnitude,
      disturbanceProbability: DEFAULT_EVOLVE_OPTIONS.disturbanceProbability,
      disturbanceSeed: 246813,
    });
    const generalisationThreshold = SOLVED_THRESHOLD * 0.8;
    assertGreaterOrEqual(
      independentScore,
      generalisationThreshold,
      `champion must generalise to unseen perturbed starts and wobble ` +
        `patterns at ≥${generalisationThreshold}; got ${independentScore}`,
    );
  },
});

Deno.test("replayController returns a non-empty trace with the initial state first", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 50);
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(trace[0].x, 0);
  assertEquals(trace[0].theta, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 4);
  const cartXAnim = svg.match(/<animate attributeName="x" values="([^"]+)"/);
  assert(cartXAnim, "expected the cart's x animation");
  const valueCount = cartXAnim![1].split(";").length;
  assertEquals(valueCount, Math.min(SVG_FRAME_COUNT, trace.length));
});

Deno.test("renderRunSVG output renders both cart and pole primitives", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace, 4);
  assert(svg.includes('class="cart"'), "expected the cart rectangle");
  assert(svg.includes('class="pole"'), "expected the pole line");
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
});

Deno.test({
  name: "evolveCartPoleController collects milestone samples and the chart SVG round-trips",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Per #287/#288 the milestone chart is the only fitness-progression
    // artefact the cart-pole example emits. The first milestone fires at
    // generation 1, so even a single-iteration run must collect at least
    // one sample, and the chart must render to a well-formed SVG.
    const result = await evolveCartPoleController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
    });
    assertGreater(
      result.milestones.length,
      0,
      "expected at least one milestone sample after iterations=1",
    );
    for (const m of result.milestones) {
      assertGreater(m.generation, 0);
      assertGreaterOrEqual(m.bestNeurons, INPUT_COUNT + OUTPUT_COUNT);
      assertGreaterOrEqual(m.bestSynapses, 1);
      assertGreaterOrEqual(m.meanEpisodeSteps, 0);
      assertGreaterOrEqual(m.generationWallClockMs, 0);
    }

    const tmp = await Deno.makeTempDir({ prefix: "cart_pole_milestone_" });
    try {
      const svg = renderMilestoneChartSVG(result.milestones, {
        title: "Cart-Pole — evolveRL Milestones",
        logX: true,
        caption: true,
      });
      const path = join(tmp, "cart_pole_milestones.svg");
      await Deno.writeTextFile(path, svg);
      const written = await Deno.readTextFile(path);
      assert(written.startsWith("<svg"), "must start with <svg>");
      assert(written.includes("</svg>"), "must contain </svg>");
      assert(
        written.includes("Cart-Pole &#x2014; evolveRL Milestones") ||
          written.includes("Cart-Pole — evolveRL Milestones"),
        "expected the chart title to appear in the SVG",
      );
      // The chart should reference each milestone series.
      assert(
        written.includes("best-score-line"),
        "expected the best-score series",
      );
      assert(
        written.includes("mean-steps-line"),
        "expected the mean-steps series",
      );
      assert(
        written.includes("neurons-line"),
        "expected the neurons series",
      );
      assert(
        written.includes("synapses-line"),
        "expected the synapses series",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test("MILESTONE_SVG_PATH points at the documented milestone chart", () => {
  assertEquals(MILESTONE_SVG_PATH, "docs/screenshots/cart_pole_milestones.svg");
});

Deno.test({
  name: "running cart_pole.ts via run.sh-style execution emits champion.json and SVG",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "cart_pole_smoke_" });
    try {
      ensureDirSync(join(tmp, "screenshots"));
      const result = await evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
      const trace = replayController(result.champion);
      const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
      const svgPath = join(tmp, "screenshots", "cart_pole.svg");
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
});
