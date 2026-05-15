/**
 * Unit tests for the lunar-lander NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 *
 * Migration notes:
 * - Issue #240 — the controller now evolves through
 *   `Creature.evolveRL()`, so the tests for the removed
 *   `buildRandomPopulation` and `mutateCreatureExport` internal helpers
 *   have been dropped in favour of direct {@link LanderAdapter} and
 *   controller tests.
 * - Issue #292 — per-generation telemetry, snapshot capture, and the
 *   evolution / fitness / evolution-progress strip artefacts were
 *   replaced by the milestone-statistics chart from #287.
 * - Issue #324 — the single-run milestone chart is itself superseded by
 *   the multi-run error + complexity chart pair. Tests covering the
 *   retired `MILESTONE_SVG_PATH` constant and the
 *   `renderMilestoneChartSVG` round-trip have been deleted; new tests
 *   exercise the resume code path, the `--fresh` wipe, and the
 *   end-to-end multi-run runner.
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
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import {
  appendFinalMilestone,
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  DEFAULT_MULTI_RUN_TARGET_ERROR,
  DEFAULT_MULTI_RUN_TIMEOUT_MINUTES,
  evolveLanderController,
  EXAMPLE_SLUG,
  freeFallBaselineScore,
  gradedTerminalReward,
  INPUT_COUNT,
  isQuickMode,
  LanderAdapter,
  MAX_STEPS,
  milestoneToMultiRunSample,
  MULTI_RUN_COMPLEXITY_SVG_PATH,
  MULTI_RUN_ERROR_SVG_PATH,
  OUTPUT_COUNT,
  pickValidationSvgIndex,
  QUICK_ITERATIONS,
  QUICK_TARGET_ERROR,
  QUICK_TIMEOUT_MINUTES,
  replayController,
  runMultiRunLunarLander,
  SCORE_NORMALISERS,
  scoreController,
  scoreFinalState,
  TERMINAL_REWARD_FLOORS,
  validateChampion,
  VALIDATION_BASE_SEED,
  type ValidationScenarioResult,
} from "./lunar_lander.ts";
import { renderRunSVG } from "./svg.ts";
import {
  DEFAULT_START_X,
  DEFAULT_TERRAIN,
  encodeState,
  initialState,
  type LanderState,
} from "./physics.ts";
import { generateScenarioPools } from "./scenarios.ts";
import { appendMultiRunRun, loadMultiRunState } from "../common/multi_run_state.ts";

/**
 * A fast, deterministic configuration suitable for unit tests. Under
 * the new `Creature.evolveRL()`-driven loop, sub-minute wall-clock
 * budgets are no longer expressible (NEAT-AI 5.0.0 requires
 * `timeoutMinutes` to be an integer ≥ 1). Tests use `iterations` as
 * the deterministic short-circuit instead. `targetError = -1` is
 * unreachable (landed-rate is bounded by 1), so the iterations cap
 * always drives exit.
 */
const TEST_EVOLVE_OPTIONS = {
  seed: 42,
  populationSize: 6,
  targetError: -1,
  timeoutMinutes: 5,
  iterations: 2,
  mutationStrength: 0.5,
  mutationRate: 0.4,
  addNeuronRate: 0,
  trials: 3,
  trialSeed: 1,
  initialPerturbation: 1.0,
};

Deno.test("LanderAdapter advertises 7 inputs and the default 400-step cap", () => {
  const adapter = new LanderAdapter();
  assertEquals(adapter.observationLength, INPUT_COUNT);
  assertEquals(adapter.maxSteps(), MAX_STEPS);
  // The library default wall-clock budget is preserved.
  assert(adapter.wallClockMs() > 0);
});

Deno.test("LanderAdapter.reset is deterministic for the same seed", () => {
  const adapter = new LanderAdapter({ initialPerturbation: 1.0 });
  const a = adapter.reset(7);
  const b = adapter.reset(7);
  assertEquals(Array.from(a.observation), Array.from(b.observation));
  assertEquals(a.state.x, b.state.x);
  assertEquals(a.state.y, b.state.y);
  assertEquals(adapter.currentTerrain.padX, adapter.currentTerrain.padX);
});

Deno.test("LanderAdapter.reset uses the canonical start when perturbation is zero", () => {
  const adapter = new LanderAdapter();
  const a = adapter.reset(1);
  const canonical = initialState();
  assertEquals(a.state.x, canonical.x);
  assertEquals(a.state.y, canonical.y);
  assertEquals(a.state.fuel, canonical.fuel);
});

Deno.test(
  "LanderAdapter.step emits zero reward until the terminal step",
  () => {
    const adapter = new LanderAdapter();
    let state: LanderState = adapter.reset(1).state;
    // No thrusters — the lander free-falls and either crashes or
    // drifts out-of-bounds. The terminal reward is now graded in
    // `[-1, 0]` via {@link gradedTerminalReward}, so we assert
    // (a) every non-terminal step emits reward 0, (b) the terminal
    // step's reward is in `[-1, 0]`, and (c) for this free-fall
    // scenario (impacts off-pad at high speed) the terminal reward is
    // strictly less than 0.
    let priorReward = 0;
    let terminatedStep = -1;
    for (let i = 0; i < MAX_STEPS + 5; i++) {
      const result = adapter.step(state, { main: false, left: false, right: false });
      state = result.state;
      if (result.terminated) {
        terminatedStep = i + 1;
        assertEquals(priorReward, 0);
        assertGreaterOrEqual(result.reward, -1);
        assertGreaterOrEqual(0, result.reward);
        assert(
          result.reward < 0,
          `free-fall terminal reward must be strictly < 0, got ${result.reward}`,
        );
        break;
      }
      assertEquals(result.reward, 0);
      priorReward = result.reward;
    }
    assertGreater(terminatedStep, 0, "expected the lander to terminate");
  },
);

Deno.test("gradedTerminalReward returns exactly 0 for a clean landing", () => {
  // Landed = on-pad, near-upright, slow vertical, slow horizontal —
  // every safe-landing predicate from classifyOutcome must hold.
  const landed: LanderState = {
    x: DEFAULT_TERRAIN.padX,
    y: DEFAULT_TERRAIN.groundY,
    vx: 0,
    vy: -0.5,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  assertEquals(gradedTerminalReward(landed, DEFAULT_TERRAIN), 0);
});

Deno.test("gradedTerminalReward returns a value in [-1, 0) for every non-landed state", () => {
  // Sweep a representative grid of non-landed terminal states and assert
  // the reward stays inside `[-1, 0)` for each. Each component varies
  // independently so multiple normaliser-corner cases get touched.
  const states: LanderState[] = [
    // Soft crash off-pad, no spin, upright.
    { x: 20, y: 0, vx: 0.5, vy: -1, angle: 0, angularV: 0, fuel: 0 },
    // Hard crash on-pad, tilted.
    { x: 0, y: 0, vx: 5, vy: -10, angle: 0.6, angularV: 0.5, fuel: 0 },
    // Out-of-bounds.
    { x: 80, y: 30, vx: -10, vy: -2, angle: 0, angularV: 0, fuel: 0 },
    // Tumbling crash off-pad.
    { x: -40, y: 0, vx: 0, vy: -5, angle: 1.5, angularV: 4, fuel: 0 },
    // Worst case — far from pad, fast, fully inverted, fast spin.
    { x: 49, y: 0, vx: 30, vy: -30, angle: Math.PI, angularV: 10, fuel: 0 },
  ];
  for (const s of states) {
    const r = gradedTerminalReward(s, DEFAULT_TERRAIN);
    assertGreaterOrEqual(r, -1);
    assertGreaterOrEqual(0, r);
    assert(r < 0, `expected non-landed reward to be strictly < 0, got ${r}`);
  }
});

Deno.test("gradedTerminalReward: softer crash > harder crash (less negative)", () => {
  const soft: LanderState = {
    x: 5,
    y: 0,
    vx: 1,
    vy: -2,
    angle: 0,
    angularV: 0,
    fuel: 0,
  };
  const hard: LanderState = {
    x: 5,
    y: 0,
    vx: 10,
    vy: -20,
    angle: 0,
    angularV: 0,
    fuel: 0,
  };
  const rSoft = gradedTerminalReward(soft, DEFAULT_TERRAIN);
  const rHard = gradedTerminalReward(hard, DEFAULT_TERRAIN);
  assertGreater(rSoft, rHard);
});

Deno.test("gradedTerminalReward: closer to pad > farther from pad", () => {
  // Hold every other signal constant so the distance contribution
  // alone drives the difference.
  const near: LanderState = {
    x: 2,
    y: 0,
    vx: 3,
    vy: -3,
    angle: 0.3,
    angularV: 0,
    fuel: 0,
  };
  const far: LanderState = { ...near, x: 40 };
  const rNear = gradedTerminalReward(near, DEFAULT_TERRAIN);
  const rFar = gradedTerminalReward(far, DEFAULT_TERRAIN);
  assertGreater(rNear, rFar);
});

Deno.test("gradedTerminalReward: upright > tilted (less negative)", () => {
  const upright: LanderState = {
    x: 10,
    y: 0,
    vx: 3,
    vy: -3,
    angle: 0,
    angularV: 0,
    fuel: 0,
  };
  const tilted: LanderState = { ...upright, angle: 1.2 };
  const rUp = gradedTerminalReward(upright, DEFAULT_TERRAIN);
  const rTilt = gradedTerminalReward(tilted, DEFAULT_TERRAIN);
  assertGreater(rUp, rTilt);
});

Deno.test("gradedTerminalReward: non-spinning > spinning (less negative)", () => {
  const still: LanderState = {
    x: 10,
    y: 0,
    vx: 3,
    vy: -3,
    angle: 0,
    angularV: 0,
    fuel: 0,
  };
  const spinning: LanderState = { ...still, angularV: 4 };
  const rStill = gradedTerminalReward(still, DEFAULT_TERRAIN);
  const rSpin = gradedTerminalReward(spinning, DEFAULT_TERRAIN);
  assertGreater(rStill, rSpin);
});

Deno.test("gradedTerminalReward respects [-1, 0] bounds across a state sweep", () => {
  // Exhaustively sweep each component well past the normaliser upper
  // bounds — the clamp must keep the result inside `[-1, 0]`.
  const sweep = [-1e6, -1000, -50, -5, 0, 5, 50, 1000, 1e6];
  for (const x of sweep) {
    for (const vx of sweep) {
      for (const angle of [-10, -Math.PI, 0, Math.PI, 10]) {
        const state: LanderState = {
          x,
          y: 0,
          vx,
          vy: -Math.abs(vx),
          angle,
          angularV: vx,
          fuel: 0,
        };
        const r = gradedTerminalReward(state, DEFAULT_TERRAIN);
        assertGreaterOrEqual(r, -1);
        assertGreaterOrEqual(0, r);
      }
    }
  }
});

Deno.test("gradedTerminalReward handles out_of_bounds states (non-positive, bounded)", () => {
  // Beyond worldHalfWidth = 50 the state classifies as out_of_bounds.
  const oob: LanderState = {
    x: 200,
    y: 40,
    vx: 5,
    vy: -1,
    angle: 0.1,
    angularV: 0,
    fuel: 10,
  };
  const r = gradedTerminalReward(oob, DEFAULT_TERRAIN);
  assertGreaterOrEqual(r, -1);
  assertGreaterOrEqual(0, r);
  assert(r < 0, `out_of_bounds reward must be strictly < 0, got ${r}`);
});

Deno.test("gradedTerminalReward keeps soft non-landed outcomes meaningfully below landing", () => {
  const softNearMiss: LanderState = {
    x: DEFAULT_TERRAIN.padX + DEFAULT_TERRAIN.padHalfWidth + 0.1,
    y: DEFAULT_TERRAIN.groundY,
    vx: 0.1,
    vy: -0.1,
    angle: 0,
    angularV: 0,
    fuel: 20,
  };
  const reward = gradedTerminalReward(softNearMiss, DEFAULT_TERRAIN);
  assertGreaterOrEqual(
    -TERMINAL_REWARD_FLOORS.crashed,
    reward,
    `soft crash must keep at least the crash floor penalty, got ${reward}`,
  );
  assertGreater(0, reward);
});

Deno.test("gradedTerminalReward penalises unresolved hover timeout by altitude", () => {
  const lowHover: LanderState = {
    x: DEFAULT_TERRAIN.padX,
    y: 5,
    vx: 0,
    vy: 0,
    angle: 0,
    angularV: 0,
    fuel: 20,
  };
  const highHover: LanderState = { ...lowHover, y: 80 };
  const lowReward = gradedTerminalReward(lowHover, DEFAULT_TERRAIN);
  const highReward = gradedTerminalReward(highHover, DEFAULT_TERRAIN);
  assertGreater(lowReward, highReward);
  assertGreaterOrEqual(
    -TERMINAL_REWARD_FLOORS.flying,
    lowReward,
    `timeout hover must keep at least the flying floor penalty, got ${lowReward}`,
  );
});

Deno.test("SCORE_NORMALISERS weights sum to 1", () => {
  const sum = SCORE_NORMALISERS.weightDistance + SCORE_NORMALISERS.weightSpeed +
    SCORE_NORMALISERS.weightTilt + SCORE_NORMALISERS.weightSpin;
  assertAlmostEquals(sum, 1, 1e-9);
});

Deno.test("encodeState gives the controller bounded pad-relative observations", () => {
  const terrain = { ...DEFAULT_TERRAIN, padX: 12 };
  const state = initialState({ x: 2, y: 50, fuel: 60 });
  const encoded = encodeState(state, terrain);
  assertEquals(encoded.length, INPUT_COUNT);
  assertAlmostEquals(encoded[0], -0.2, 1e-6);
  for (const value of encoded) {
    assert(value >= -1 && value <= 1, `encoded value out of range: ${value}`);
  }
});

Deno.test("LanderAdapter.decodeAction matches the public decodeAction", () => {
  const adapter = new LanderAdapter();
  const state = adapter.reset(0).state;
  assertEquals(
    adapter.decodeAction(Float32Array.from([0.6, 0.4, 0.55]), state),
    { main: true, left: false, right: true },
  );
  assertEquals(
    adapter.decodeAction(Float32Array.from([0, 0, 0]), state),
    { main: false, left: false, right: false },
  );
});

Deno.test("LanderAdapter.assertContract passes for a well-formed adapter", () => {
  const adapter = new LanderAdapter();
  // Must not throw — the abstract contract is satisfied.
  adapter.assertContract(0);
});

Deno.test("decodeAction thresholds main at 0.5 and picks the winning rotation thruster", () => {
  // Issue #253: rotation is mutually exclusive — left and right can never
  // both fire on the same step. A naive independent-threshold decoding
  // let evolution settle on outputs that always exceed 0.5 for both
  // rotation channels, cancelling the torques while still burning fuel,
  // which made rotation an ineffective control surface. The new rule:
  // among `left` (idx 1) and `right` (idx 2), fire the strictly-higher
  // one only when it is at or above 0.5; otherwise neither rotation
  // thruster fires.
  assertEquals(decodeAction([0.6, 0.4, 0.55]), { main: true, left: false, right: true });
  // Both rotation outputs above threshold but `left` strictly higher → only left fires.
  assertEquals(decodeAction([0.6, 0.9, 0.6]), { main: true, left: true, right: false });
  // Tied rotation outputs → no rotation fires (cancellation removed).
  assertEquals(decodeAction([0.5, 0.5, 0.5]), { main: true, left: false, right: false });
  assertEquals(decodeAction([0, 0, 0]), { main: false, left: false, right: false });
});

Deno.test("decodeAction never fires both rotation thrusters simultaneously (issue #253)", () => {
  // Sweep the rotation output space and assert the mutual-exclusion
  // invariant for every combination — a controller can no longer hide
  // behind cancelling torques.
  for (let l = 0; l <= 1; l += 0.1) {
    for (let r = 0; r <= 1; r += 0.1) {
      const action = decodeAction([0, l, r]);
      assert(
        !(action.left && action.right),
        `left and right must be mutually exclusive (left=${l}, right=${r})`,
      );
    }
  }
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
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const result = scoreController(creature, MAX_STEPS);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assert(
    ["flying", "landed", "crashed", "out_of_bounds"].includes(result.outcome),
    `unknown outcome: ${result.outcome}`,
  );
  assertGreaterOrEqual(result.landedRate, 0);
  assertGreaterOrEqual(1, result.landedRate);
});

Deno.test(
  "scoreController with multiple perturbed trials returns the mean and is deterministic",
  () => {
    // Sanity: same inputs produce the same mean score and the same
    // landed rate. Both must be finite and in range.
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const a = scoreController(creature, MAX_STEPS, {
      trials: 5,
      trialSeed: 11,
      initialPerturbation: 1.0,
    });
    const b = scoreController(creature, MAX_STEPS, {
      trials: 5,
      trialSeed: 11,
      initialPerturbation: 1.0,
    });
    assertEquals(a.score, b.score);
    assertEquals(a.landedRate, b.landedRate);
    assert(Number.isFinite(a.score));
    assertEquals(a.trials.length, 5);
  },
);

Deno.test(
  "scoreController with perturbation varies the pad position across trials (issue #253)",
  () => {
    // Issue #253: the README's training-pipeline diagram promises that
    // perturbedScenario (state + terrain, including padX) drives training.
    // With a moving pad in training, a controller cannot win by memorising
    // "pad at zero" — the scoring function must surface terrain variation
    // so different trials touch down on different pad centres.
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const result = scoreController(creature, MAX_STEPS, {
      trials: 20,
      trialSeed: 7,
      initialPerturbation: 1.0,
    });
    const xs = result.trials.map((t) => t.finalState.x);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    assert(
      xMax - xMin > 5,
      `expected final-state x to span > 5 m across trials, got [${xMin}, ${xMax}]`,
    );
  },
);

Deno.test("freeFallBaselineScore corresponds to a crash (negative score)", () => {
  const baseline = freeFallBaselineScore();
  // Free fall from ~80 m with lunar gravity reaches ~16 m/s downward —
  // far above the safe-landing limit, so the outcome must be a crash.
  assert(baseline < 0, `expected negative baseline (crash), got ${baseline}`);
});

Deno.test({
  name: "evolveLanderController gen-1 milestone sits well below the solved threshold",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise: a fresh `new Creature(input, output)` seed
    // and the library's uniform-random structural mutations cannot
    // already solve lunar lander. Per #298 the only available telemetry
    // is the milestone payload at generation 1.
    const result = await evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      populationSize: 30,
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
    // The minimal seed has `INPUT_COUNT + OUTPUT_COUNT` neurons; NEAT-AI
    // may grow topology under its own mutation policy, so the count can
    // only be asserted as ≥ the seed value.
    assertGreaterOrEqual(first.bestNeurons, INPUT_COUNT + OUTPUT_COUNT);
    assertGreaterOrEqual(first.bestSynapses, 1);
  },
});

Deno.test({
  name: "evolveLanderController honours the iterations generation cap",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // NEAT-AI 5.0.0 requires `timeoutMinutes` to be an integer ≥ 1, so
    // sub-minute wall-clock budgets are no longer expressible. The
    // standard short-circuit for unit tests is the `iterations` cap.
    // With an unreachable targetError and a tiny iterations budget the
    // run must stop at the cap and report `solved=false`.
    const cap = 2;
    const start = Date.now();
    const result = await evolveLanderController({
      seed: 999,
      populationSize: 4,
      targetError: -1, // unreachable: landed-rate is bounded by 1
      timeoutMinutes: 5,
      iterations: cap,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 1.0,
    });
    const elapsedMs = Date.now() - start;
    assertGreaterOrEqual(
      cap,
      result.generations,
      `expected the iterations cap of ${cap} to bound generations, got ${result.generations}`,
    );
    assert(
      Number.isFinite(result.wallclockMs),
      `expected finite wallclockMs, got ${result.wallclockMs}`,
    );
    assertGreater(result.generations, 0);
    assert(
      elapsedMs < 60_000,
      `expected the run to finish well under 60 seconds, took ${elapsedMs} ms`,
    );
  },
});

Deno.test({
  name: "evolveLanderController stops on target when targetError is generous",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // targetError=1 means the threshold is `landed-rate ≥ 0` — every
    // population member meets that on gen 0, so target wins the race.
    const result = await evolveLanderController({
      seed: 7,
      populationSize: 6,
      targetError: 1,
      timeoutMinutes: 5,
      iterations: 2,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 1.0,
    });
    assertEquals(result.stopReason, "target");
    assertEquals(result.solved, true);
    assertGreater(result.generations, 0);
    assert(
      Number.isFinite(result.wallclockMs),
      `expected finite wallclockMs, got ${result.wallclockMs}`,
    );
  },
});

Deno.test({
  name: "evolveLanderController solved flag follows measured landed rate",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const targetError = 0.25;
    const result = await evolveLanderController({
      ...TEST_EVOLVE_OPTIONS,
      targetError,
      iterations: 1,
      populationSize: 6,
    });
    assertEquals(result.solved, result.landedRate >= 1 - targetError);
  },
});

Deno.test({
  name: "evolveLanderController returns bounded headline metrics for a fixed seed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // NEAT-AI's internal training path can apply non-byte-stable
    // fine-tuning, so this test asserts the public result contract
    // rather than exact equality between two training trajectories.
    const result = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    assert(
      ["flying", "landed", "crashed", "out_of_bounds"].includes(result.championOutcome),
      `unexpected champion outcome: ${result.championOutcome}`,
    );
    assertGreaterOrEqual(result.landedRate, 0);
    assertGreaterOrEqual(1, result.landedRate);
    assertEquals(
      result.solved,
      result.landedRate >= 1 - Math.max(0, TEST_EVOLVE_OPTIONS.targetError),
    );
    assertGreater(result.generations, 0);
  },
});

Deno.test({
  name: "champion JSON exports cleanly to disk",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveLanderController(TEST_EVOLVE_OPTIONS);
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
  },
});

Deno.test("replayController returns a non-empty trace whose first frame is the initial state", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 50);
  const seed = initialState();
  assert(trace.length > 0, "trace must not be empty");
  assertAlmostEquals(
    trace[0].state.x,
    seed.x,
    1e-9,
    `first frame should match the configured initial x = ${seed.x}`,
  );
  assertAlmostEquals(
    trace[0].state.vx,
    seed.vx,
    1e-9,
    `first frame should match the configured initial vx = ${seed.vx}`,
  );
});

Deno.test("renderRunSVG emits a well-formed SVG with trajectory polyline and pose markers", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
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
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
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

Deno.test({
  name: "evolveLanderController collects milestone samples with the documented shape",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Per #287/#292/#298/#324 milestone statistics are the only telemetry
    // channel NEAT-AI exposes. The first milestone fires at generation
    // 1, so even a single-iteration run must collect at least one
    // sample with the documented fields populated.
    const result = await evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      populationSize: 6,
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
  },
});

// Issue #324 retired the legacy single-run `MILESTONE_SVG_PATH` constant
// in favour of the multi-run chart pair under `docs/screenshots/lunar_lander/`.
Deno.test("multi-run chart paths sit under the lunar_lander slug directory", () => {
  assertEquals(MULTI_RUN_ERROR_SVG_PATH, "docs/screenshots/lunar_lander/milestones.svg");
  assertEquals(
    MULTI_RUN_COMPLEXITY_SVG_PATH,
    "docs/screenshots/lunar_lander/complexity.svg",
  );
  assertEquals(EXAMPLE_SLUG, "lunar_lander");
  assertEquals(DEFAULT_MULTI_RUN_TARGET_ERROR, 0.01);
  assertEquals(DEFAULT_MULTI_RUN_TIMEOUT_MINUTES, 5);
});

Deno.test({
  // Issue #351: when evolution stops between two canonical milestone
  // generations (e.g. iterations=3 sits between schedule points 2 and
  // 5), the multi-run chart used to truncate at the previous schedule
  // point. The fix appends a synthetic final-generation milestone so
  // the chart's x-axis reflects the true terminal generation.
  name:
    "evolveLanderController appends a synthetic milestone at the actual final generation (#351)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const iterations = 3; // sits between canonical schedule points 2 and 5
    const result = await evolveLanderController({
      ...TEST_EVOLVE_OPTIONS,
      iterations,
    });

    assertEquals(
      result.generations,
      iterations,
      "expected the iterations cap to drive run termination",
    );
    const last = result.milestones[result.milestones.length - 1];
    assertEquals(
      last.generation,
      iterations,
      `expected the final milestone to match result.generations=${iterations}, ` +
        `got ${last.generation}`,
    );
    assertGreaterOrEqual(last.bestNeurons, INPUT_COUNT + OUTPUT_COUNT);
    assertGreaterOrEqual(last.bestSynapses, 1);
  },
});

Deno.test("appendFinalMilestone appends synthetic milestone when run ends past last schedule point", () => {
  // Build a synthetic milestone history that stops at the canonical
  // schedule point 1000, simulating a real run that fired the timeout
  // at generation 1487 — between 1000 and the next schedule point of
  // 10000. Without the fix the chart would truncate at 1000.
  const milestones = [
    {
      generation: 1,
      bestScore: -0.4,
      bestNeurons: 10,
      bestSynapses: 21,
      meanEpisodeSteps: 100,
      generationWallClockMs: 50,
    },
    {
      generation: 1000,
      bestScore: -0.13,
      bestNeurons: 33,
      bestSynapses: 51,
      meanEpisodeSteps: 127,
      generationWallClockMs: 93,
    },
  ];
  const champion = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const augmented = appendFinalMilestone(milestones, 1487, 0.08, champion);
  assertEquals(augmented.length, milestones.length + 1);
  const tail = augmented[augmented.length - 1];
  assertEquals(tail.generation, 1487);
  // `bestScore = -error`, mirroring the adapter's sign convention.
  assertAlmostEquals(tail.bestScore, -0.08, 1e-12);
  assertEquals(tail.bestNeurons, champion.neurons.length);
  assertEquals(tail.bestSynapses, champion.synapses.length);
  // Carry the previous milestone's meanEpisodeSteps forward — the
  // library does not surface a terminal-step value.
  assertEquals(tail.meanEpisodeSteps, milestones[milestones.length - 1].meanEpisodeSteps);
  // No per-generation wall-clock cost is available at termination.
  assertEquals(tail.generationWallClockMs, 0);
});

Deno.test("appendFinalMilestone is a no-op when final generation matches the last milestone", () => {
  // Run terminates exactly on a canonical schedule point (e.g.
  // generation 1000 hit precisely). No synthetic milestone is needed.
  const milestones = [
    {
      generation: 1,
      bestScore: -0.4,
      bestNeurons: 10,
      bestSynapses: 21,
      meanEpisodeSteps: 100,
      generationWallClockMs: 50,
    },
    {
      generation: 1000,
      bestScore: -0.13,
      bestNeurons: 33,
      bestSynapses: 51,
      meanEpisodeSteps: 127,
      generationWallClockMs: 93,
    },
  ];
  const champion = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const result = appendFinalMilestone(milestones, 1000, 0.13, champion);
  assertEquals(result.length, milestones.length);
  assertEquals(result[result.length - 1].generation, 1000);
});

Deno.test("appendFinalMilestone returns input unchanged when milestones list is empty", () => {
  // Defensive: if statistics were disabled or zero iterations ran the
  // helper has nothing to anchor against and must not invent state.
  const champion = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const result = appendFinalMilestone([], 500, 0.1, champion);
  assertEquals(result.length, 0);
});

Deno.test("appendFinalMilestone clamps the synthetic milestone's error into [0, 1]", () => {
  const milestones = [
    {
      generation: 100,
      bestScore: -0.2,
      bestNeurons: 12,
      bestSynapses: 24,
      meanEpisodeSteps: 110,
      generationWallClockMs: 40,
    },
  ];
  const champion = new Creature(INPUT_COUNT, OUTPUT_COUNT);

  // Defensive: a defensive overshoot (error > 1) is clamped to 1.
  const high = appendFinalMilestone(milestones, 250, 1.5, champion);
  assertEquals(high[high.length - 1].bestScore, -1);

  // Defensive: a defensive undershoot (error < 0) is clamped to 0.
  const low = appendFinalMilestone(milestones, 250, -0.3, champion);
  assertEquals(low[low.length - 1].bestScore, 0);
});

Deno.test("appendFinalMilestone attributes leftover wallclock to the synthetic milestone (#353)", () => {
  // Issue #353: the chart caption sums `generationWallClockMs` across
  // every milestone to display "X ms total". Without crediting the gap
  // between the last canonical milestone and the run's terminal
  // generation to the synthetic final milestone, a 5-minute run reads
  // as a sub-second total in the chart.
  const milestones = [
    {
      generation: 1,
      bestScore: -0.4,
      bestNeurons: 10,
      bestSynapses: 21,
      meanEpisodeSteps: 100,
      generationWallClockMs: 50,
    },
    {
      generation: 1000,
      bestScore: -0.13,
      bestNeurons: 33,
      bestSynapses: 51,
      meanEpisodeSteps: 127,
      generationWallClockMs: 100,
    },
  ];
  const champion = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  // Total run wallclock: 300_000 ms (5 minutes). Already attributed via
  // milestone wallclocks: 150 ms. Leftover the synthetic should carry:
  // 299_850 ms.
  const augmented = appendFinalMilestone(
    milestones,
    1487,
    0.08,
    champion,
    300_000,
  );
  const tail = augmented[augmented.length - 1];
  assertEquals(tail.generation, 1487);
  assertEquals(tail.generationWallClockMs, 299_850);
  // Sum of all milestone wallclocks should now equal the supplied total.
  const summed = augmented.reduce((acc, m) => acc + m.generationWallClockMs, 0);
  assertEquals(summed, 300_000);
});

Deno.test("appendFinalMilestone clamps wallclock attribution to >= 0 (#353)", () => {
  // Defensive: if accumulated milestone wallclocks somehow exceed the
  // supplied total (clock skew, pre-recorded fixtures), the synthetic
  // milestone must not contribute a negative duration.
  const milestones = [
    {
      generation: 1000,
      bestScore: -0.13,
      bestNeurons: 33,
      bestSynapses: 51,
      meanEpisodeSteps: 127,
      generationWallClockMs: 5_000,
    },
  ];
  const champion = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const augmented = appendFinalMilestone(milestones, 1487, 0.08, champion, 1_000);
  const tail = augmented[augmented.length - 1];
  assertEquals(tail.generationWallClockMs, 0);
});

Deno.test("milestoneToMultiRunSample maps cumulative reward to normalised error", () => {
  // The lunar-lander adapter emits graded terminal reward in `[-1, 0]`,
  // so `error = -bestScore` is an upper bound on `1 - landedRate`.
  // NEAT-AI surfaces the per-episode mean cumulative reward as
  // `bestScore` on the milestone payload.
  const sample = milestoneToMultiRunSample({
    generation: 10,
    bestScore: -0.4,
    bestNeurons: 12,
    bestSynapses: 24,
    meanEpisodeSteps: 200,
    generationWallClockMs: 300,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(sample.runGen, 10);
  assertEquals(sample.bestScore, -0.4);
  assertEquals(sample.error, 0.4); // -(-0.4)
  assertEquals(sample.neurons, 12);
  assertEquals(sample.synapses, 24);
  assertEquals(sample.meanEpisodeSteps, 200);
  assertEquals(sample.generationWallClockMs, 300);
});

Deno.test("milestoneToMultiRunSample clamps error into [0, 1]", () => {
  // bestScore = -1.5 (defensive undershoot) → 1.5 → clamped to 1.
  const high = milestoneToMultiRunSample({
    generation: 1,
    bestScore: -1.5,
    bestNeurons: 10,
    bestSynapses: 21,
    meanEpisodeSteps: 0,
    generationWallClockMs: 1,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(high.error, 1);

  // bestScore = 0.5 (above the adapter range) → -0.5 → clamped to 0.
  const low = milestoneToMultiRunSample({
    generation: 1,
    bestScore: 0.5,
    bestNeurons: 10,
    bestSynapses: 21,
    meanEpisodeSteps: MAX_STEPS,
    generationWallClockMs: 1,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(low.error, 0);

  // bestScore = 0 (every trial landed cleanly) → error = 0.
  const solved = milestoneToMultiRunSample({
    generation: 1,
    bestScore: 0,
    bestNeurons: 10,
    bestSynapses: 21,
    meanEpisodeSteps: 100,
    generationWallClockMs: 1,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(solved.error, 0);
});

Deno.test({
  name:
    "evolveLanderController honours seedCreatureExport — accepts the export and produces a valid run",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Resume-path smoke test: when `seedCreatureExport` is supplied the
    // call must succeed and produce a champion that round-trips back to
    // a `CreatureExport` with the same input/output channel counts as
    // the seed (i.e., the library accepted the supplied genome instead
    // of crashing on schema mismatch). End-to-end resume semantics are
    // exercised by the `runMultiRunLunarLander resume flow` integration
    // test below.
    const seedCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const seedExport: CreatureExport = seedCreature.exportJSON();
    assertEquals(seedExport.input, INPUT_COUNT);
    assertEquals(seedExport.output, OUTPUT_COUNT);

    const result = await evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      populationSize: 6,
      seedCreatureExport: seedExport,
    });
    assertGreater(result.milestones.length, 0);

    const championExport = result.champion.exportJSON();
    assertEquals(championExport.input, INPUT_COUNT);
    assertEquals(championExport.output, OUTPUT_COUNT);
    assert(Number.isFinite(result.bestScore));
  },
});

Deno.test({
  name:
    "runMultiRunLunarLander resume flow loads prior creature, appends milestones, and renders charts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "lunar_lander_resume_" });
    try {
      const slug = EXAMPLE_SLUG;

      // Pre-seed multi-run state with a prior champion + a synthetic
      // milestone so loadMultiRunState reports nextRunIndex=2.
      const priorCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      await appendMultiRunRun(slug, {
        creatureExport: priorCreature.exportJSON(),
        newSamples: [{
          runGen: 1,
          error: 0.5,
          bestScore: -0.5,
          neurons: INPUT_COUNT + OUTPUT_COUNT,
          synapses: INPUT_COUNT,
          meanEpisodeSteps: 200,
          generationWallClockMs: 100,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      // Drive the multi-run flow with an `iterations=1` cap so the test
      // completes in seconds and never depends on wall-clock timing.
      const outcome = await runMultiRunLunarLander({
        argv: [],
        baseDir: tmp,
        evolveOverrides: { iterations: 1, populationSize: 6 },
      });

      // Prior champion must have been reloaded as the evolveRL seed.
      assertEquals(outcome.resumed, true);
      assertEquals(outcome.runIndex, 2);

      // Persisted history now contains both the pre-seeded milestone and
      // the new run's milestones, all with monotonic cumulativeGen.
      const state = await loadMultiRunState(slug, tmp);
      assertGreater(state.milestones.length, 1);
      assertEquals(state.nextRunIndex, 3);
      assertEquals(state.creatureExport !== undefined, true);
      const newRunMilestones = state.milestones.filter((m) => m.runIndex === 2);
      assertGreater(newRunMilestones.length, 0);
      for (let i = 1; i < state.milestones.length; i++) {
        const prev = state.milestones[i - 1].cumulativeGen;
        const curr = state.milestones[i].cumulativeGen;
        assert(curr >= prev, `cumulativeGen must be monotonic (${prev} → ${curr})`);
      }

      // Both chart SVGs were written under the baseDir override.
      const errorSvg = join(tmp, "screenshots", slug, "milestones.svg");
      const complexitySvg = join(tmp, "screenshots", slug, "complexity.svg");
      assertEquals(existsSync(errorSvg), true, "error chart SVG should exist");
      assertEquals(existsSync(complexitySvg), true, "complexity chart SVG should exist");
      const errorText = await Deno.readTextFile(errorSvg);
      const complexityText = await Deno.readTextFile(complexitySvg);
      assert(errorText.startsWith("<svg"), "error chart must be an SVG");
      assert(complexityText.startsWith("<svg"), "complexity chart must be an SVG");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "runMultiRunLunarLander --fresh wipes prior artefacts before running",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "lunar_lander_fresh_" });
    try {
      const slug = EXAMPLE_SLUG;
      // Pre-seed with a prior run's state.
      await appendMultiRunRun(slug, {
        creatureExport: new Creature(INPUT_COUNT, OUTPUT_COUNT).exportJSON(),
        newSamples: [{
          runGen: 1,
          error: 0.5,
          bestScore: -0.5,
          neurons: INPUT_COUNT + OUTPUT_COUNT,
          synapses: INPUT_COUNT,
          meanEpisodeSteps: 200,
          generationWallClockMs: 100,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      const outcome = await runMultiRunLunarLander({
        argv: ["--fresh"],
        baseDir: tmp,
        evolveOverrides: { iterations: 1, populationSize: 6 },
      });

      // `--fresh` wiped the prior state, so this is run 1 and there was
      // no prior champion to resume from.
      assertEquals(outcome.resumed, false);
      assertEquals(outcome.runIndex, 1);

      const state = await loadMultiRunState(slug, tmp);
      assertEquals(state.nextRunIndex, 2);
      for (const m of state.milestones) {
        assertEquals(m.runIndex, 1);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "validateChampion produces one entry per validation scenario (issue #198)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 12);
    const report = validateChampion(result.champion, pools.validation);
    assertEquals(report.scenarios.length, pools.validation.length);
    for (const r of report.scenarios) {
      assert(
        ["flying", "landed", "crashed", "out_of_bounds"].includes(r.outcome),
        `unexpected outcome ${r.outcome}`,
      );
      assert(Number.isFinite(r.score), `expected finite score, got ${r.score}`);
    }
    // Aggregate counts must add up to the number of scenarios.
    const total = report.outcomeCounts.flying + report.outcomeCounts.landed +
      report.outcomeCounts.crashed + report.outcomeCounts.out_of_bounds;
    assertEquals(total, pools.validation.length);
    assertGreaterOrEqual(report.landedRate, 0);
    assertGreaterOrEqual(1, report.landedRate);
    assert(Number.isFinite(report.meanFitness));
  },
});

Deno.test({
  name: "validateChampion is deterministic for a fixed champion and scenarios (issue #198)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 8);
    const a = validateChampion(result.champion, pools.validation);
    const b = validateChampion(result.champion, pools.validation);
    // Per-scenario scores and outcomes match exactly.
    for (let i = 0; i < a.scenarios.length; i++) {
      assertEquals(a.scenarios[i].score, b.scenarios[i].score);
      assertEquals(a.scenarios[i].outcome, b.scenarios[i].outcome);
      assertEquals(a.scenarios[i].seed, b.scenarios[i].seed);
    }
    assertEquals(a.landedRate, b.landedRate);
    assertEquals(a.meanFitness, b.meanFitness);
    assertEquals(a.selectedIndex, b.selectedIndex);
  },
});

Deno.test({
  name: "validateChampion writes a JSON-serialisable report (issue #198)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 6);
    const report = validateChampion(result.champion, pools.validation);
    const tmp = await Deno.makeTempDir({ prefix: "lunar_lander_validation_test_" });
    try {
      const path = join(tmp, "results.json");
      await Deno.writeTextFile(path, JSON.stringify(report));
      const written = JSON.parse(await Deno.readTextFile(path));
      // The serialised JSON must have one scenario entry per validation scenario.
      assertEquals(written.scenarios.length, pools.validation.length);
      for (let i = 0; i < written.scenarios.length; i++) {
        const r = written.scenarios[i];
        assertEquals(r.seed, pools.validation[i].seed);
        assertEquals(r.index, i);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test(
  "pickValidationSvgIndex returns 0 when every scenario landed (issue #198)",
  () => {
    const allLanded: ValidationScenarioResult[] = Array.from({ length: 5 }, (_, i) => ({
      seed: i,
      index: i,
      outcome: "landed",
      score: 100 + i,
      finalState: initialState(),
    }));
    assertEquals(pickValidationSvgIndex(allLanded), 0);
  },
);

Deno.test(
  "pickValidationSvgIndex picks the lower-median score among landed scenarios when any land (issue #198)",
  () => {
    // Mixed outcomes: four crashed, one landed. Median over *all* scores
    // would sit on a crash; the descent SVG should still show a landing
    // when the champion clears at least one scenario.
    const mixed: ValidationScenarioResult[] = [
      { seed: 0, index: 0, outcome: "crashed", score: 30, finalState: initialState() },
      { seed: 1, index: 1, outcome: "crashed", score: 50, finalState: initialState() },
      { seed: 2, index: 2, outcome: "crashed", score: 10, finalState: initialState() },
      { seed: 3, index: 3, outcome: "crashed", score: 40, finalState: initialState() },
      { seed: 4, index: 4, outcome: "landed", score: 20, finalState: initialState() },
    ];
    assertEquals(pickValidationSvgIndex(mixed), 4);
  },
);

Deno.test(
  "pickValidationSvgIndex uses lower-median landed score when several land (issue #198)",
  () => {
    const rows: ValidationScenarioResult[] = [
      { seed: 0, index: 0, outcome: "crashed", score: -100, finalState: initialState() },
      { seed: 1, index: 1, outcome: "landed", score: 10, finalState: initialState() },
      { seed: 2, index: 2, outcome: "landed", score: 30, finalState: initialState() },
      { seed: 3, index: 3, outcome: "landed", score: 20, finalState: initialState() },
    ];
    // Landed scores sorted: 10 (i=1), 20 (i=3), 30 (i=2) → lower median → i=3.
    assertEquals(pickValidationSvgIndex(rows), 3);
  },
);

Deno.test(
  "pickValidationSvgIndex returns -1 for an empty result set (issue #198)",
  () => {
    assertEquals(pickValidationSvgIndex([]), -1);
  },
);

Deno.test(
  "pickValidationSvgIndex falls back to global median when nothing landed (issue #198)",
  () => {
    const rows: ValidationScenarioResult[] = [
      { seed: 0, index: 0, outcome: "crashed", score: 30, finalState: initialState() },
      { seed: 1, index: 1, outcome: "flying", score: 10, finalState: initialState() },
      { seed: 2, index: 2, outcome: "crashed", score: 50, finalState: initialState() },
    ];
    // Sorted scores: 10 (i=1), 30 (i=0), 50 (i=2) → lower median → i=0.
    assertEquals(pickValidationSvgIndex(rows), 0);
  },
);

Deno.test({
  name: "validateChampion's selected SVG-source scenario is non-canonical (issue #198)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // The selected scenario must differ from `initialState()` — the
    // SVG should demonstrate generalisation, so its starting x and/or
    // pad position must not match the canonical training launch.
    const result = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 16);
    const report = validateChampion(result.champion, pools.validation);
    const selected = pools.validation[report.selectedIndex];
    const matchesCanonicalX = Math.abs(selected.state.x - DEFAULT_START_X) < 1e-9;
    const matchesCanonicalPad = Math.abs(selected.terrain.padX) < 1e-9;
    assert(
      !(matchesCanonicalX && matchesCanonicalPad),
      `selected scenario matches canonical state (x=${selected.state.x}, ` +
        `padX=${selected.terrain.padX}) — SVG would not prove generalisation`,
    );
  },
});

Deno.test({
  name: "replayController honours scenario terrain for the SVG source (issue #198)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Build a scenario with a shifted pad and a non-canonical start;
    // the replay's first frame must reflect the scenario state, and
    // the trace must classify against the scenario terrain.
    const result = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 4);
    const report = validateChampion(result.champion, pools.validation);
    const selected = pools.validation[report.selectedIndex];
    const trace = replayController(
      result.champion,
      MAX_STEPS,
      selected.state,
      selected.terrain,
    );
    // The first-frame x must match the validation scenario's start, not
    // the canonical default — the assertable signal that the SVG is
    // sourced from a held-out scenario.
    assert(trace.length > 0, "trace must not be empty");
    assertEquals(trace[0].state.x, selected.state.x);
    assertEquals(trace[0].state.fuel, selected.state.fuel);
    // The trace should diverge from the canonical initialState's x —
    // the validation pool's draws are uniformly distributed away from -20.
    const startedAtCanonical = Math.abs(trace[0].state.x - DEFAULT_START_X) < 1e-9;
    const padShifted = Math.abs(selected.terrain.padX) > 1e-9;
    assert(
      !startedAtCanonical || padShifted,
      "validation-sourced replay must differ from the canonical launch",
    );
  },
});

Deno.test(
  "renderRunSVG draws an explosion when the run crashed (issue #177)",
  () => {
    // Hand-craft a trace whose final frame is a hard crash off the pad —
    // the renderer must visualise the wreck rather than showing the
    // resting-pose lander.
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
      {
        state: {
          // Far from the pad, fast horizontal speed, large tilt: classifies
          // as `crashed`.
          x: -30,
          y: 0,
          vx: 8,
          vy: -15,
          angle: 0.9,
          angularV: 0,
          fuel: 0,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);
    assert(
      svg.includes('class="explosion"'),
      "expected an explosion group on a crashed run",
    );
    assert(svg.includes(">EXPLODED<"), "expected an EXPLODED caption on the wreck");
    assert(
      svg.includes('class="starburst"'),
      "expected a starburst polygon as part of the explosion",
    );
    assert(
      svg.includes('class="outcome-badge"'),
      "expected an outcome badge identifying the run result",
    );
    assert(svg.includes(">✗ CRASHED<"), "expected the badge to label the run as CRASHED");
  },
);

Deno.test(
  "renderRunSVG draws an out-of-bounds explosion when the lander drifted off-world",
  () => {
    // Final state outside the world half-width — classifies as
    // `out_of_bounds`. The renderer should still show debris, but with
    // an "OUT OF BOUNDS" caption on the wreck and a matching badge.
    const trace = [
      {
        state: {
          x: -20,
          y: 80,
          vx: 0,
          vy: 0,
          angle: 0,
          angularV: 0,
          fuel: 100,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
      {
        state: {
          // Beyond DEFAULT_TERRAIN.worldHalfWidth = 50.
          x: -80,
          y: 30,
          vx: -10,
          vy: -2,
          angle: 0,
          angularV: 0,
          fuel: 0,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);
    assert(
      svg.includes('class="explosion"'),
      "expected an explosion group on out-of-bounds runs",
    );
    assert(
      svg.includes(">OUT OF BOUNDS<"),
      "expected an OUT OF BOUNDS caption on the wreck",
    );
    assert(
      svg.includes(">✗ OUT OF BOUNDS<"),
      "expected the outcome badge to label the run as OUT OF BOUNDS",
    );
  },
);

Deno.test(
  "renderRunSVG does NOT draw an explosion on a clean landing",
  () => {
    // Final state inside the pad with all safe-landing limits met —
    // classifies as `landed`. The renderer must keep the resting-pose
    // lander and omit the wreck graphic.
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
      {
        state: {
          x: 0,
          y: 0,
          vx: 0,
          vy: -0.5,
          angle: 0,
          angularV: 0,
          fuel: 50,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);
    assert(
      !svg.includes('class="explosion"'),
      "expected no explosion group on a successful landing",
    );
    assert(
      svg.includes(">✓ LANDED<"),
      "expected the outcome badge to label the run as LANDED",
    );
  },
);

Deno.test(
  "renderRunSVG accepts an explicit outcome override (issue #177)",
  () => {
    // The lunar-lander runner classifies the champion's run with the
    // multi-trial `championOutcome` and forwards that to the renderer.
    // The renderer must honour the override even if the trace's final
    // frame would classify differently.
    const trace = [
      {
        state: {
          x: 0,
          y: 0,
          vx: 0,
          vy: -0.5,
          angle: 0,
          angularV: 0,
          fuel: 50,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace, DEFAULT_TERRAIN, "crashed");
    assert(
      svg.includes('class="explosion"'),
      "expected an explosion group when the override outcome is `crashed`",
    );
    assert(svg.includes(">✗ CRASHED<"), "expected the badge to honour the override");
  },
);

Deno.test(
  "renderRunSVG keeps the lander body above the ground at touchdown (issue #181)",
  () => {
    // Issue #181: when the lander touches down (state.y = groundY) the
    // SVG must draw the lander resting ON the ground silhouette, not
    // half-buried in it. Both the static resting pose and the animated
    // lander icon's final position must place the lander's lowest point
    // at or above the projected ground line.
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
        action: { main: false, left: false, right: false },
      },
      {
        state: {
          x: 0,
          y: 0,
          vx: 0,
          vy: -0.5,
          angle: 0,
          angularV: 0,
          fuel: 50,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);

    // Top edge of the terrain silhouette rect — anything drawn at a
    // larger SVG y is below the ground line.
    const terrainMatch = svg.match(
      /<rect x="0" y="([\d.]+)" width="800" height="[\d.]+" fill="#3a2a1a"\/>/,
    );
    assert(terrainMatch, "expected a terrain silhouette rect");
    const groundSvg = parseFloat(terrainMatch[1]);

    // Every static-pose lander body line must sit at or above the ground.
    const bodyLineRegex =
      /<line class="body" x1="[\d.-]+" y1="([\d.-]+)" x2="[\d.-]+" y2="([\d.-]+)"/g;
    const bodyMatches = [...svg.matchAll(bodyLineRegex)];
    assert(
      bodyMatches.length > 0,
      "expected at least one resting-pose body line",
    );
    for (const m of bodyMatches) {
      const y1 = parseFloat(m[1]);
      const y2 = parseFloat(m[2]);
      const lowest = Math.max(y1, y2);
      assertGreaterOrEqual(
        groundSvg + 0.01,
        lowest,
        `static pose body extends below ground (lowest=${lowest}, ground=${groundSvg})`,
      );
    }

    // The animated lander's translate keyframes follow the trajectory.
    // The final keyframe must place the lander icon such that its
    // lowest body extent is at or above the ground.
    const animateMatch = svg.match(
      /<animateTransform attributeName="transform" type="translate" values="([^"]+)"/,
    );
    assert(animateMatch, "expected the animated-lander translate values");
    const lastFrame = animateMatch[1].split(";").pop()!;
    const [, lastY] = lastFrame.split(",").map(parseFloat);
    // Local body geometry extends from `-LANDER_HALF_LENGTH` to
    // `+LANDER_HALF_LENGTH` around the translate point. The lowest
    // visible y is therefore `lastY + LANDER_HALF_LENGTH`.
    const animLowest = lastY + 12; // LANDER_HALF_LENGTH
    assertGreaterOrEqual(
      groundSvg + 0.01,
      animLowest,
      `animated lander final position extends below ground ` +
        `(lowest=${animLowest}, ground=${groundSvg})`,
    );
  },
);

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

// ---------------------------------------------------------------------------
// Quick-mode (CI/quality budget) regression tests — issue #201.
// ---------------------------------------------------------------------------

Deno.test("isQuickMode trips on LUNAR_QUICK=1 env var (issue #201)", () => {
  assertEquals(isQuickMode([], "1"), true);
  assertEquals(isQuickMode([], "0"), false);
  assertEquals(isQuickMode([], undefined), false);
  // Stray values are treated as off — only the literal "1" counts.
  assertEquals(isQuickMode([], "true"), false);
  assertEquals(isQuickMode([], ""), false);
});

Deno.test("isQuickMode trips on --quick CLI flag (issue #201)", () => {
  assertEquals(isQuickMode(["--quick"], undefined), true);
  assertEquals(isQuickMode(["--target-error=0.05", "--quick"], undefined), true);
  assertEquals(isQuickMode(["--target-error=0.05"], undefined), false);
  // Either signal alone is enough; both together still resolve to true.
  assertEquals(isQuickMode(["--quick"], "1"), true);
});

Deno.test("quick-mode overrides force an unreachable target and a tight iterations cap (issue #201)", () => {
  // The quick-mode constants drive the runner's CI fast path. The
  // target-error must be unreachable so the iterations cap always
  // drives exit: `landed-rate` is bounded by 1, so a threshold > 1
  // (i.e. `1 - QUICK_TARGET_ERROR > 1`, equivalently
  // `QUICK_TARGET_ERROR < 0`) can never be met.
  assert(
    QUICK_TARGET_ERROR < 0,
    `QUICK_TARGET_ERROR must be < 0 to make the landed-rate threshold > 1, ` +
      `got ${QUICK_TARGET_ERROR}`,
  );
  // NEAT-AI 5.0.0 requires `timeoutMinutes` to be an integer ≥ 1 — keep
  // the field schema-valid as a fallback while iterations does the
  // short-circuiting work.
  assertGreaterOrEqual(QUICK_TIMEOUT_MINUTES, 1);
  assertGreater(QUICK_ITERATIONS, 0);
  assertGreaterOrEqual(10, QUICK_ITERATIONS);
});

// Issue #353: PR #352 added `appendFinalMilestone` so the multi-run chart
// stops at the run's true final generation rather than the previous
// canonical schedule point (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
// then powers of ten). The persisted artefact `docs/data/lunar_lander/
// milestones.json` must therefore reflect a non-canonical terminal
// generation (i.e. the synthetic final milestone has been appended).
//
// The user-reported bug was a chart whose caption read "1000 cumulative
// generations" — the exact value the canonical schedule emits — even
// after a multi-minute run. The probability of a real timeout-driven
// run terminating exactly at 1000 generations is ~1 in 100, so a
// persisted final cumulativeGen of 1000 is overwhelmingly diagnostic of
// a stale artefact: the appendFinalMilestone fix has not been applied.
//
// Fail the build when that happens. Closes #353.
Deno.test("persisted multi-run milestones.json reflects the true final generation (#353)", async () => {
  const path = "docs/data/lunar_lander/milestones.json";
  if (!existsSync(path)) {
    // Test is a no-op when the artefact has not yet been generated
    // (e.g. a fresh checkout that has never invoked the runner). The
    // canonical artefact ships with the repository, so the file is
    // present on every CI checkout.
    return;
  }
  const text = await Deno.readTextFile(path);
  const milestones = JSON.parse(text) as Array<{
    cumulativeGen: number;
    runGen: number;
    runIndex: number;
  }>;
  assertGreater(
    milestones.length,
    0,
    `expected at least one persisted milestone in ${path}`,
  );
  const last = milestones[milestones.length - 1];
  // The user-reported failure mode: the chart caption reads "1000
  // cumulative generations" because the synthetic final milestone was
  // never appended. A real run of any non-trivial length lands at a
  // non-canonical terminal generation in roughly 99% of cases, so a
  // persisted value of exactly 1000 is the tell-tale sign of staleness.
  assert(
    last.cumulativeGen !== 1000,
    `persisted milestones.json final cumulativeGen is 1000 — the chart still ` +
      `claims "1000 cumulative generations" because the appendFinalMilestone ` +
      `fix from PR #352 has not been applied to the persisted artefact. ` +
      `Re-run lunar_lander/run.sh to regenerate ${path}.`,
  );
  // Also reject any other canonical schedule point at the head of the
  // distribution — these are exactly the values evolveRL emits, so a
  // terminal cumulativeGen sitting on one of them is diagnostic of the
  // same staleness pattern. Powers of ten beyond 1000 (10000, 100000)
  // are excluded because a long run could legitimately fire its
  // milestone at that exact value while still terminating immediately
  // afterwards.
  const canonicalScheduleHead = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  assert(
    !canonicalScheduleHead.includes(last.cumulativeGen),
    `persisted milestones.json final cumulativeGen is ${last.cumulativeGen}, ` +
      `which is exactly a canonical evolveRL schedule point — the ` +
      `appendFinalMilestone fix from PR #352 has not been applied.`,
  );
});

Deno.test({
  name: "quick-mode budget: evolveLanderController with the quick overrides ends fast (issue #201)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Drive the evolver directly with the quick-mode overrides and
    // assert the run finishes well inside the 60-second regression
    // budget the issue asks for. This is the closest we can get to a
    // wall-clock assertion without spawning a subprocess.
    const start = Date.now();
    const result = await evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      populationSize: 6,
      targetError: QUICK_TARGET_ERROR,
      timeoutMinutes: QUICK_TIMEOUT_MINUTES,
      iterations: QUICK_ITERATIONS,
    });
    const elapsedMs = Date.now() - start;
    // The runner stops on iterations because targetError > 1 is unreachable.
    assertEquals(result.stopReason, "iterations");
    // Wall-clock must be well under the 60-second regression budget.
    assert(
      elapsedMs < 60_000,
      `quick-mode evolveLanderController took ${elapsedMs}ms, expected < 60000ms`,
    );
    assert(
      Number.isFinite(result.wallclockMs),
      `expected finite wallclockMs, got ${result.wallclockMs}`,
    );
  },
});
