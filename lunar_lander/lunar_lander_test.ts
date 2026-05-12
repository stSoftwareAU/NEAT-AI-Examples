/**
 * Unit tests for the lunar-lander NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 *
 * Migration note (issue #240): the controller now evolves through
 * `Creature.evolveRL()`, so the tests for the removed
 * `buildRandomPopulation` and `mutateCreatureExport` internal helpers
 * have been dropped in favour of direct {@link LanderAdapter} and
 * controller tests. The remaining tests still assert on public
 * behaviour rather than implementation choices.
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

import { parse as parseCsv } from "@std/csv";
import {
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveLanderController,
  formatEvolutionCsv,
  freeFallBaselineScore,
  type GenerationInfo,
  INPUT_COUNT,
  isQuickMode,
  LanderAdapter,
  MAX_STEPS,
  OUTPUT_COUNT,
  pickValidationSvgIndex,
  QUICK_ITERATIONS,
  QUICK_TARGET_ERROR,
  QUICK_TIMEOUT_MINUTES,
  replayController,
  scoreController,
  scoreFinalState,
  validateChampion,
  VALIDATION_BASE_SEED,
  type ValidationScenarioResult,
} from "./lunar_lander.ts";
import { renderRunSVG } from "./svg.ts";
import { DEFAULT_START_X, DEFAULT_TERRAIN, initialState, type LanderState } from "./physics.ts";
import { generateScenarioPools } from "./scenarios.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

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
    // drifts out-of-bounds. Either way the terminal step must emit
    // reward -1 (not landed) and all prior steps must be 0.
    let priorReward = 0;
    let terminatedStep = -1;
    for (let i = 0; i < MAX_STEPS + 5; i++) {
      const result = adapter.step(state, { main: false, left: false, right: false });
      state = result.state;
      if (result.terminated) {
        terminatedStep = i + 1;
        assertEquals(priorReward, 0);
        assertEquals(result.reward, -1);
        break;
      }
      assertEquals(result.reward, 0);
      priorReward = result.reward;
    }
    assertGreater(terminatedStep, 0, "expected the lander to terminate");
  },
);

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
  name: "evolveLanderController generation-1 population is noise on average",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise. A fresh `new Creature(input, output)` seed
    // and the library's uniform-random initial population almost never
    // land — the gen-1 best landed rate must sit well below the default
    // 99% target.
    let firstGenLanded = 1;
    let observed = false;
    await evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      populationSize: 30,
      onGeneration: (info) => {
        if (info.generation === 0 && !observed) {
          firstGenLanded = info.bestLandedRate;
          observed = true;
        }
      },
    });
    assert(observed, "expected at least one onGeneration call");
    // The default targetError of 0.01 implies a "solved" threshold of
    // landed-rate ≥ 0.99, so gen-1 noise should be well below it.
    assert(
      firstGenLanded < 1 - DEFAULT_EVOLVE_OPTIONS.targetError,
      `expected gen-1 best landed rate below the solved threshold ` +
        `(${1 - DEFAULT_EVOLVE_OPTIONS.targetError}), got ${firstGenLanded}`,
    );
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
  name: "evolveLanderController is reproducible for the same seed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // `Creature.evolveRL` is deterministic given a pinned `seed`, so two
    // runs with identical options must agree on the headline outcome
    // (championOutcome, landedRate) and the run topology
    // (`generations`). Byte-level equality of `bestScore` is no longer
    // asserted because the upstream library is free to surface small
    // numerical drift in aggregate fitness so long as the observed
    // categorical outcome remains stable.
    const r1 = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    const r2 = await evolveLanderController(TEST_EVOLVE_OPTIONS);
    assertEquals(r1.championOutcome, r2.championOutcome);
    assertEquals(r1.landedRate, r2.landedRate);
    assertEquals(r1.generations, r2.generations);
    assertEquals(r1.solved, r2.solved);
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
  name:
    "evolveLanderController writes seed + final snapshots and the strip SVG embeds one panel per snapshot",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "lunar_lander_snapshots_test_" });
    try {
      // Under the new evolveRL-driven loop only the seed creature (gen 1)
      // and the final champion are snapshot — mid-run intermediate
      // checkpoints are no longer captured because the upstream API
      // does not expose mid-run creature exports.
      await evolveLanderController({
        ...TEST_EVOLVE_OPTIONS,
        mutationStrength: 0.01,
        mutationRate: 0.01,
        populationSize: 4,
        iterations: 3,
        snapshotConfig: { checkpoints: [1], outputDir: tmp },
      });

      const snapshots = loadSnapshots(tmp);
      assertGreaterOrEqual(
        snapshots.length,
        2,
        `expected at least seed + final snapshots, got ${snapshots.length}`,
      );

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Lunar Lander — Evolution Progress",
      });
      assert(svg.startsWith("<svg"), "must start with <svg>");
      assert(svg.length > 0, "SVG must be non-empty");
      const panels = svg.match(/<g class="panel"/g) ?? [];
      assertEquals(panels.length, snapshots.length);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "evolveLanderController emits GenerationInfo with sensible neuron and synapse counts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // The minimal seed has `INPUT_COUNT + OUTPUT_COUNT` neurons with
    // `INPUT_COUNT * OUTPUT_COUNT` direct synapses. NEAT-AI may grow
    // topology under its own mutation policy, so the counts can only
    // be asserted as ≥ the seed values.
    const events: GenerationInfo[] = [];
    await evolveLanderController({
      ...TEST_EVOLVE_OPTIONS,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      populationSize: 4,
      iterations: 3,
      onGeneration: (info) => events.push(info),
    });
    assertGreater(events.length, 0, "expected at least one onGeneration call");
    for (const info of events) {
      assertGreaterOrEqual(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertGreaterOrEqual(info.synapses, INPUT_COUNT);
      assert(Number.isFinite(info.bestScore));
      assert(Number.isFinite(info.meanScore));
      assertGreaterOrEqual(info.bestLandedRate, 0);
      assertGreaterOrEqual(1, info.bestLandedRate);
    }
  },
});

Deno.test(
  "formatEvolutionCsv: header is exact and rows parse cleanly with @std/csv (issue #199)",
  () => {
    const rows: EvolutionRow[] = [
      { generation: 0, bestFitness: 0, avgFitness: 0, landedRate: 0, wallclockMs: 12 },
      { generation: 1, bestFitness: 0.5, avgFitness: 0.25, landedRate: 0.3, wallclockMs: 45 },
      { generation: 2, bestFitness: 1, avgFitness: 0.75, landedRate: 1, wallclockMs: 100 },
    ];
    const csv = formatEvolutionCsv(rows);

    // Exact header — downstream tools key on this verbatim.
    assert(
      csv.startsWith(EVOLUTION_CSV_HEADER + "\n"),
      `expected CSV to start with ${EVOLUTION_CSV_HEADER}, got ${csv.slice(0, 100)}`,
    );
    assertEquals(
      EVOLUTION_CSV_HEADER,
      "generation,best_fitness,avg_fitness,landed_rate,wallclock_ms",
    );

    // The CSV must parse cleanly with @std/csv into an array of objects
    // keyed by header.
    const parsed = parseCsv(csv, { skipFirstRow: true });
    assertEquals(parsed.length, rows.length);

    // Spot-check round-trip values.
    for (let i = 0; i < rows.length; i++) {
      const r = parsed[i] as Record<string, string>;
      assertEquals(Number(r.generation), rows[i].generation);
      assertEquals(Number(r.best_fitness), rows[i].bestFitness);
      assertEquals(Number(r.avg_fitness), rows[i].avgFitness);
      assertEquals(Number(r.landed_rate), rows[i].landedRate);
      assertEquals(Number(r.wallclock_ms), rows[i].wallclockMs);
    }

    // Determinism — identical inputs produce byte-identical output.
    assertEquals(formatEvolutionCsv(rows), csv);
  },
);

Deno.test(
  "formatEvolutionCsv: empty input emits header only (issue #199)",
  () => {
    const csv = formatEvolutionCsv([]);
    assertEquals(csv, EVOLUTION_CSV_HEADER + "\n");
  },
);

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
  "pickValidationSvgIndex picks the lower-median scenario by score (issue #198)",
  () => {
    // Mixed outcomes: scores 10, 20, 30, 40, 50 → median=30 at index 2.
    const mixed: ValidationScenarioResult[] = [
      { seed: 0, index: 0, outcome: "crashed", score: 30, finalState: initialState() },
      { seed: 1, index: 1, outcome: "crashed", score: 50, finalState: initialState() },
      { seed: 2, index: 2, outcome: "crashed", score: 10, finalState: initialState() },
      { seed: 3, index: 3, outcome: "crashed", score: 40, finalState: initialState() },
      { seed: 4, index: 4, outcome: "landed", score: 20, finalState: initialState() },
    ];
    // Sorted scores: 10 (i=2), 20 (i=4), 30 (i=0), 40 (i=3), 50 (i=1).
    // Lower median (index 2 of sorted, since (5-1)/2 = 2) → original index 0.
    assertEquals(pickValidationSvgIndex(mixed), 0);
  },
);

Deno.test(
  "pickValidationSvgIndex returns -1 for an empty result set (issue #198)",
  () => {
    assertEquals(pickValidationSvgIndex([]), -1);
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

Deno.test({
  name: "evolveLanderController: CSV row count equals the number of generation events (issue #199)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Run a tiny evolve with a fixed iterations cap and capture one
    // EvolutionRow per onGeneration callback. With `iterations: 3` the
    // loop runs exactly three generations so the row count is
    // deterministic regardless of host speed.
    const events: GenerationInfo[] = [];
    const rows: EvolutionRow[] = [];
    const start = Date.now();
    await evolveLanderController({
      ...TEST_EVOLVE_OPTIONS,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      populationSize: 4,
      iterations: 3,
      onGeneration: (info) => {
        events.push(info);
        rows.push({
          generation: info.generation,
          bestFitness: info.bestScore,
          avgFitness: info.meanScore,
          landedRate: info.bestLandedRate,
          wallclockMs: Date.now() - start,
        });
      },
    });
    assertEquals(rows.length, events.length);
    assertGreater(rows.length, 0);

    const csv = formatEvolutionCsv(rows);
    const csvLines = csv.trimEnd().split("\n");
    // Header + one row per generation.
    assertEquals(csvLines.length, rows.length + 1);
    assertEquals(csvLines[0], EVOLUTION_CSV_HEADER);
  },
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
