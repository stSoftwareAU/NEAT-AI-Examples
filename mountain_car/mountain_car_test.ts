/**
 * Unit tests for the Mountain-Car NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 *
 * Migration notes:
 * - Issue #237 — the controller evolves through `Creature.evolveRL()`,
 *   so the tests for the removed `buildRandomPopulation` and
 *   `mutateCreatureExport` internal helpers have been dropped in favour
 *   of direct adapter and controller tests.
 * - Issue #290 — per-generation telemetry, snapshot capture, and the
 *   evolution / fitness / topology charts were replaced by the
 *   milestone-statistics chart from #287.
 * - Issue #323 — the single-run milestone chart is itself superseded by
 *   the multi-run error + complexity chart pair. Tests covering the
 *   retired `MILESTONE_SVG_PATH` constant have been deleted; new tests
 *   exercise the resume code path, the `--fresh` wipe, and the
 *   end-to-end multi-run runner.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import {
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  DEFAULT_MULTI_RUN_TARGET_ERROR,
  DEFAULT_MULTI_RUN_TIMEOUT_MINUTES,
  evolveMountainCarController,
  EXAMPLE_SLUG,
  INPUT_COUNT,
  MAX_STEPS,
  milestoneToMultiRunSample,
  MountainCarAdapter,
  type MountainCarEpisodeState,
  MULTI_RUN_COMPLEXITY_SVG_PATH,
  MULTI_RUN_ERROR_SVG_PATH,
  OUTPUT_COUNT,
  replayController,
  runMultiRunMountainCar,
  scoreController,
  scoreSwingUpPolicy,
  SOLVED_THRESHOLD,
  SUCCESS_BONUS,
} from "./mountain_car.ts";
import { renderRunSVG } from "./svg.ts";
import { GOAL_POSITION, MAX_EPISODE_STEPS } from "./physics.ts";
import { appendMultiRunRun, loadMultiRunState } from "../common/multi_run_state.ts";

Deno.test("MountainCarAdapter advertises 2 inputs and the canonical step cap", () => {
  const adapter = new MountainCarAdapter();
  assertEquals(adapter.observationLength, INPUT_COUNT);
  assertEquals(adapter.maxSteps(), MAX_STEPS);
  assertEquals(adapter.maxSteps(), MAX_EPISODE_STEPS);
  assert(adapter.wallClockMs() > 0);
});

Deno.test("MountainCarAdapter.reset is deterministic for the same seed", () => {
  const adapter = new MountainCarAdapter({ initialPerturbation: 0.05 });
  const a = adapter.reset(7);
  const b = adapter.reset(7);
  assertEquals(Array.from(a.observation), Array.from(b.observation));
  assertEquals(a.state.physics.x, b.state.physics.x);
  assertEquals(a.state.physics.v, b.state.physics.v);
  assertEquals(a.state.stepIdx, 0);
});

Deno.test("MountainCarAdapter.reset without perturbation produces the canonical start", () => {
  const adapter = new MountainCarAdapter();
  const { observation, state } = adapter.reset(42);
  assertEquals(state.physics.x, -0.5);
  assertEquals(state.physics.v, 0);
  assertEquals(observation.length, INPUT_COUNT);
});

Deno.test(
  "MountainCarAdapter.step emits zero reward until terminal summit or timeout",
  () => {
    // Push left every tick — the car never summits within MAX_STEPS so
    // the run must terminate on the step cap with reward -1.
    const adapter = new MountainCarAdapter({ maxStepsPerEpisode: 50 });
    let state: MountainCarEpisodeState = adapter.reset(1).state;
    let terminatedAt = -1;
    let terminalReward = 0;
    for (let i = 0; i < 50; i++) {
      const result = adapter.step(state, -1);
      state = result.state;
      if (result.terminated) {
        terminatedAt = i + 1;
        terminalReward = result.reward;
        break;
      }
      assertEquals(result.reward, 0);
    }
    assertEquals(terminatedAt, 50, "expected termination on the step cap");
    assertEquals(terminalReward, -1, "timeout must emit cumulative -1 reward");
  },
);

Deno.test("MountainCarAdapter.step emits zero reward on successful summit", () => {
  // Drive the adapter through a state that is already past the goal
  // line — the next step should terminate with reward 0 (no error).
  const adapter = new MountainCarAdapter();
  const state: MountainCarEpisodeState = {
    physics: { x: GOAL_POSITION - 0.01, v: 0.07 },
    stepIdx: 10,
  };
  const result = adapter.step(state, 1);
  assert(
    result.terminated,
    `expected terminated=true when summit reached, got ${result.terminated}`,
  );
  assertEquals(result.reward, 0, "summit must emit reward 0 → error 0 → solved");
  assert(result.state.physics.x >= GOAL_POSITION);
});

Deno.test("MountainCarAdapter.decodeAction follows the argmax convention", () => {
  const adapter = new MountainCarAdapter();
  const state = adapter.reset(0).state;
  assertEquals(adapter.decodeAction(Float32Array.from([0.9, 0.1, 0.2]), state), -1);
  assertEquals(adapter.decodeAction(Float32Array.from([0.1, 0.9, 0.2]), state), 0);
  assertEquals(adapter.decodeAction(Float32Array.from([0.1, 0.2, 0.9]), state), 1);
});

Deno.test("MountainCarAdapter.assertContract passes for a well-formed adapter", () => {
  const adapter = new MountainCarAdapter();
  adapter.assertContract(0);
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
  assertGreaterOrEqual(SUCCESS_BONUS, result.score);
});

Deno.test("scoreController returns a finite mean score and a summit fraction", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const result = scoreController(creature, MAX_STEPS);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assertGreaterOrEqual(result.summitRate, 0);
  assertGreaterOrEqual(1, result.summitRate);
});

Deno.test(
  "scoreController with multiple trials returns the mean across trials",
  () => {
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const a = scoreController(creature, MAX_STEPS, {
      trials: 4,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    const b = scoreController(creature, MAX_STEPS, {
      trials: 4,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    assertEquals(a.score, b.score);
    assertEquals(a.summitRate, b.summitRate);
    assertEquals(a.trials, 4);
    assertGreaterOrEqual(a.summitRate, 0);
    assertGreaterOrEqual(1, a.summitRate);
  },
);

Deno.test({
  name: "evolveMountainCarController gen-1 milestone sits well below the threshold",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise: a fresh `new Creature(input, output)` seed
    // and the library's uniform-random structural mutations cannot
    // already solve mountain-car. Per #298 the only available telemetry
    // is the milestone payload at generation 1.
    const result = await evolveMountainCarController({
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
    // The gen-1 best score is bounded by SUCCESS_BONUS (a perfect
    // summit) but for a noisy population dominated by timeouts must sit
    // well below the solved-rate equivalent.
    assert(
      first.bestScore < SUCCESS_BONUS * SOLVED_THRESHOLD,
      `expected the gen-1 best score to sit below SOLVED_THRESHOLD-equivalent ` +
        `(${SUCCESS_BONUS * SOLVED_THRESHOLD}), got ${first.bestScore}`,
    );
  },
});

Deno.test({
  name: "evolveMountainCarController honours the iterations cap",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // NEAT-AI 5.0.0 requires `timeoutMinutes` to be an integer ≥ 1, so
    // sub-minute wall-clock budgets are no longer expressible. The
    // standard short-circuit for unit tests is the `iterations` cap.
    const start = Date.now();
    const result = await evolveMountainCarController({
      seed: 999,
      populationSize: 4,
      // Unreachable target so the loop relies on `iterations` to stop.
      targetError: -1,
      timeoutMinutes: 5,
      iterations: 1,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.05,
    });
    const elapsedMs = Date.now() - start;
    assertGreaterOrEqual(
      1,
      result.generations,
      `expected the iterations cap to bound generations to 1, got ${result.generations}`,
    );
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation and a 1-gen cap the search must not solve mountain-car",
    );
    assert(
      result.summitRate < SOLVED_THRESHOLD,
      `expected summit rate below threshold, got ${result.summitRate}`,
    );
    assert(
      elapsedMs < 60_000,
      `expected the run to finish well under 60 seconds, took ${elapsedMs} ms`,
    );
  },
});

// Deno.test({
//   name:
//     "evolveMountainCarController finds a champion that meets SOLVED_THRESHOLD with the default seed",
//   sanitizeOps: false,
//   sanitizeResources: false,
//   fn: async () => {
//     const result = await evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
//     assertEquals(
//       result.solved,
//       true,
//       `expected the champion's summit rate to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
//         `got ${result.summitRate} after ${result.generations} generations ` +
//         `(score=${result.bestScore})`,
//     );
//     assertGreaterOrEqual(result.summitRate, SOLVED_THRESHOLD);

//     // Champion must serialise cleanly for downstream consumption.
//     const tmp = await Deno.makeTempDir({ prefix: "mountain_car_test_" });
//     try {
//       const path = join(tmp, "champion.json");
//       await safeWriteJson(path, result.champion.exportJSON());
//       assertEquals(existsSync(path), true);
//     } finally {
//       await Deno.remove(tmp, { recursive: true });
//     }
//   },
// });

Deno.test({
  name: "evolveMountainCarController collects milestone samples with expected shape",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Per #287/#290/#298 milestone statistics are the only telemetry
    // channel NEAT-AI exposes. The first milestone fires at generation
    // 1, so even a single-iteration run must collect at least one
    // sample with the documented fields populated.
    const result = await evolveMountainCarController({
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
  },
});

// Issue #323 retired the legacy single-run `MILESTONE_SVG_PATH` constant
// in favour of the multi-run chart pair under `docs/screenshots/mountain_car/`.
Deno.test("multi-run chart paths sit under the mountain_car slug directory", () => {
  assertEquals(MULTI_RUN_ERROR_SVG_PATH, "docs/screenshots/mountain_car/milestones.svg");
  assertEquals(
    MULTI_RUN_COMPLEXITY_SVG_PATH,
    "docs/screenshots/mountain_car/complexity.svg",
  );
  assertEquals(EXAMPLE_SLUG, "mountain_car");
  assertEquals(DEFAULT_MULTI_RUN_TARGET_ERROR, 0.01);
  assertEquals(DEFAULT_MULTI_RUN_TIMEOUT_MINUTES, 5);
});

Deno.test("milestoneToMultiRunSample maps cumulative reward to normalised error", () => {
  // The mountain-car adapter emits cumulative reward in {-1, 0}, so
  // error = -bestScore = 1 - summitRate. NEAT-AI surfaces the
  // per-episode mean cumulative reward as `bestScore` on the milestone
  // payload.
  const sample = milestoneToMultiRunSample({
    generation: 10,
    bestScore: -0.4,
    bestNeurons: 7,
    bestSynapses: 12,
    meanEpisodeSteps: 150,
    generationWallClockMs: 250,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(sample.runGen, 10);
  assertEquals(sample.bestScore, -0.4);
  assertEquals(sample.error, 0.4); // -(-0.4)
  assertEquals(sample.neurons, 7);
  assertEquals(sample.synapses, 12);
  assertEquals(sample.meanEpisodeSteps, 150);
  assertEquals(sample.generationWallClockMs, 250);
});

Deno.test("milestoneToMultiRunSample clamps error into [0, 1]", () => {
  // bestScore = -1.5 (defensive undershoot) → 1.5 → clamped to 1
  const high = milestoneToMultiRunSample({
    generation: 1,
    bestScore: -1.5,
    bestNeurons: 5,
    bestSynapses: 4,
    meanEpisodeSteps: 0,
    generationWallClockMs: 1,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(high.error, 1);

  // bestScore = 0.5 (above the adapter range) → -0.5 → clamped to 0
  const low = milestoneToMultiRunSample({
    generation: 1,
    bestScore: 0.5,
    bestNeurons: 5,
    bestSynapses: 4,
    meanEpisodeSteps: MAX_STEPS,
    generationWallClockMs: 1,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(low.error, 0);

  // bestScore = 0 (every trial summited) → error = 0
  const solved = milestoneToMultiRunSample({
    generation: 1,
    bestScore: 0,
    bestNeurons: 5,
    bestSynapses: 4,
    meanEpisodeSteps: 100,
    generationWallClockMs: 1,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(solved.error, 0);
});

Deno.test({
  name:
    "evolveMountainCarController honours seedCreatureExport — accepts the export and produces a valid run",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Resume-path smoke test: when `seedCreatureExport` is supplied the
    // call must succeed and produce a champion that round-trips back to
    // a `CreatureExport` with the same input/output channel counts as
    // the seed (i.e., the library accepted the supplied genome instead
    // of crashing on schema mismatch). End-to-end resume semantics are
    // exercised by the `runMultiRunMountainCar resume flow` integration
    // test below.
    const seedCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const seedExport: CreatureExport = seedCreature.exportJSON();
    assertEquals(seedExport.input, INPUT_COUNT);
    assertEquals(seedExport.output, OUTPUT_COUNT);

    const result = await evolveMountainCarController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
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
    "runMultiRunMountainCar resume flow loads prior creature, appends milestones, and renders charts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mountain_car_resume_" });
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
      const outcome = await runMultiRunMountainCar({
        argv: [],
        baseDir: tmp,
        evolveOverrides: { iterations: 1 },
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
  name: "runMultiRunMountainCar --fresh wipes prior artefacts before running",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mountain_car_fresh_" });
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

      const outcome = await runMultiRunMountainCar({
        argv: ["--fresh"],
        baseDir: tmp,
        evolveOverrides: { iterations: 1 },
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

Deno.test("replayController returns a non-empty trace starting at the initial state", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 50);
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(trace[0].x, -0.5);
  assertEquals(trace[0].v, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Three on the car (cx, cy, fill) plus one on the progress bar.
  assertGreaterOrEqual(animateMatches.length, 4);
});

Deno.test("renderRunSVG draws the goal flag", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="goal"'), "expected the goal flag group");
  assert(svg.includes('class="hill"'), "expected the hill profile path");
  assert(svg.includes('class="car"'), "expected the animated car");
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
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

Deno.test({
  name: "running mountain_car.ts via run.sh-style execution emits champion.json and SVG",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mountain_car_smoke_" });
    try {
      ensureDirSync(join(tmp, "screenshots"));
      const result = await evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
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
});
