/**
 * Unit tests for the maze-navigation NEAT controller. "What" tests
 * only — each test calls a real function, runs the simulator or
 * evolver, and asserts on the observable outputs.
 *
 * Migration notes:
 * - Issue #239 — the controller evolves through `Creature.evolveRL()`,
 *   so the tests for the removed `buildRandomPopulation` and
 *   `mutateCreatureExport` internal helpers have been dropped in favour
 *   of direct adapter and controller tests.
 * - Issue #289 — per-generation telemetry, snapshot capture, and the
 *   evolution / fitness / topology charts have been replaced by the
 *   milestone-statistics chart from #287. Tests covering the removed
 *   surfaces have been deleted; a new test asserts the milestone-chart
 *   SVG round-trip via `evolveRL` + `renderMilestoneChartSVG`.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import {
  DEFAULT_EVOLVE_OPTIONS,
  evolveMazeController,
  MAX_STEPS,
  MazeAdapter,
  type MazeEpisodeState,
  MILESTONE_SVG_PATH,
  replayController,
  scoreController,
  SOLVED_THRESHOLD,
} from "./maze_navigation.ts";
import { renderRunSVG } from "./svg.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { Action } from "./maze.ts";
import { renderMilestoneChartSVG } from "../common/milestone_chart.ts";

Deno.test("MazeAdapter advertises 5 inputs and the default MAX_STEPS-step cap", () => {
  const adapter = new MazeAdapter();
  assertEquals(adapter.observationLength, INPUT_COUNT);
  assertEquals(adapter.maxSteps(), MAX_STEPS);
  // The library default wall-clock budget is preserved.
  assert(adapter.wallClockMs() > 0);
});

Deno.test("MazeAdapter.reset returns the maze's start cell deterministically", () => {
  const adapter = new MazeAdapter();
  const a = adapter.reset(7);
  const b = adapter.reset(42);
  // The maze is deterministic — seed is irrelevant.
  assertEquals(Array.from(a.observation), Array.from(b.observation));
  assertEquals(a.state.maze.position, a.state.maze.maze.start);
  assertEquals(a.state.stepIdx, 0);
  assertEquals(a.observation.length, INPUT_COUNT);
});

Deno.test(
  "MazeAdapter.step emits zero reward until the terminal step",
  () => {
    const adapter = new MazeAdapter();
    let state: MazeEpisodeState = adapter.reset(1).state;
    // Spam Stay so the agent never moves — eventually the step cap fires.
    let priorReward = 0;
    let terminatedStep = -1;
    for (let i = 0; i < MAX_STEPS + 5; i++) {
      const result = adapter.step(state, Action.Stay);
      state = result.state;
      if (result.terminated) {
        terminatedStep = i + 1;
        assertEquals(priorReward, 0);
        assert(
          result.reward < 0,
          `expected negative reward on the terminal step, got ${result.reward}`,
        );
        // Cumulative reward must sit in [-1, 0] for evolveRL's
        // defaultRewardToError to produce a valid [0, 1] error.
        assertGreaterOrEqual(result.reward, -1);
        break;
      }
      assertEquals(result.reward, 0);
      priorReward = result.reward;
    }
    assertEquals(
      terminatedStep,
      MAX_STEPS,
      `expected the step cap to fire at MAX_STEPS, got ${terminatedStep}`,
    );
  },
);

Deno.test(
  "MazeAdapter.decodeAction matches the agent argmax convention",
  () => {
    const adapter = new MazeAdapter();
    const state = adapter.reset(0).state;
    // Index 0 is North in ACTION_ORDER.
    assertEquals(
      adapter.decodeAction(Float32Array.from([1, 0, 0, 0]), state),
      Action.North,
    );
    // Index 1 is East.
    assertEquals(
      adapter.decodeAction(Float32Array.from([0, 1, 0, 0]), state),
      Action.East,
    );
    // Index 3 is West.
    assertEquals(
      adapter.decodeAction(Float32Array.from([0, 0, 0, 1]), state),
      Action.West,
    );
  },
);

Deno.test("MazeAdapter.assertContract passes for a well-formed adapter", () => {
  const adapter = new MazeAdapter();
  // Must not throw — the abstract contract is satisfied.
  adapter.assertContract(0);
});

Deno.test("scoreController returns a finite score for a fresh seed creature", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const result = scoreController(creature, 50);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assertGreaterOrEqual(result.steps, 1);
});

Deno.test({
  name: "evolveMazeController gen-1 milestone sits well below the threshold",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise: a fresh `new Creature(input, output)` seed
    // and the library's uniform-random initial population cannot solve
    // the L-corridor maze under the default seed. Per #298 the only
    // available telemetry is the milestone payload at generation 1.
    const result = await evolveMazeController({
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
      first.bestScore < SOLVED_THRESHOLD,
      `expected the gen-1 best score to sit below SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
        `got ${first.bestScore}`,
    );
  },
});

Deno.test({
  name: "evolveMazeController honours the iterations generation cap",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // NEAT-AI 5.0.0 requires `timeoutMinutes` to be an integer ≥ 1, so
    // sub-minute wall-clock budgets are no longer expressible. The
    // standard short-circuit for unit tests is the `iterations` cap.
    // With an unreachable targetError and a tiny iterations budget the
    // run must stop at the cap and report `solved=false`.
    const cap = 3;
    const start = Date.now();
    const result = await evolveMazeController({
      seed: 999,
      populationSize: 4,
      targetError: -1, // unreachable: target score = 2 > 1
      timeoutMinutes: 5,
      iterations: cap,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
    });
    const elapsedMs = Date.now() - start;
    assertGreaterOrEqual(
      cap,
      result.generations,
      `expected the iterations cap of ${cap} to bound generations, got ${result.generations}`,
    );
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve the maze within the cap",
    );
    assert(
      elapsedMs < 60_000,
      `expected the run to finish well under 60 seconds, took ${elapsedMs} ms`,
    );
  },
});

Deno.test({
  name: "evolveMazeController champion reaches the goal under the default seed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion's score to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
        `got ${result.bestScore} after ${result.generations} generations`,
    );
    assertEquals(
      result.championReached,
      true,
      `expected the champion to reach the goal, got finalDistance=${result.championFinalDistance}`,
    );
    assertGreaterOrEqual(result.bestScore, SOLVED_THRESHOLD);
    // Champion must serialise cleanly for downstream consumption.
    const tmp = await Deno.makeTempDir({ prefix: "maze_test_" });
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
  name: "evolveMazeController is reproducible — fixed seed produces matching champions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // evolveRL is deterministic given a pinned `seed`, so two runs with
    // identical options must agree on the headline outcome (score,
    // reached-state, step count). Byte-level JSON equality of the
    // champion is no longer asserted because the upstream library is
    // free to reorder internal genome fields between calls without
    // changing observable behaviour.
    const a = await evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
    const b = await evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(a.bestScore, b.bestScore);
    assertEquals(a.championReached, b.championReached);
    assertEquals(a.championSteps, b.championSteps);
    assertEquals(a.championFinalDistance, b.championFinalDistance);
  },
});

Deno.test("replayController returns a non-empty trace starting at the start cell", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 50);
  assert(trace.length > 0);
  assertEquals(trace[0].steps, 0);
  assertEquals(trace[0].position, trace[0].maze.start);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Agent cx/cy, goal pulse opacity, progress bar width.
  assertGreaterOrEqual(animateMatches.length, 4);
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('repeatCount="indefinite"'));
});

Deno.test("renderRunSVG draws the agent circle, footprint polyline, and goal pulse", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
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

Deno.test({
  name: "evolveMazeController collects milestone samples and the chart SVG round-trips",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Per #287/#289 the milestone chart is the only fitness-progression
    // artefact the maze-navigation example emits. The first milestone
    // fires at generation 1, so even a single-iteration run must collect
    // at least one sample, and the chart must render to a well-formed
    // SVG.
    const result = await evolveMazeController({
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

    const tmp = await Deno.makeTempDir({ prefix: "maze_milestone_" });
    try {
      const svg = renderMilestoneChartSVG(result.milestones, {
        title: "Maze Navigation — evolveRL Milestones",
        logX: true,
        caption: true,
      });
      const path = join(tmp, "maze_navigation_milestones.svg");
      await Deno.writeTextFile(path, svg);
      const written = await Deno.readTextFile(path);
      assert(written.startsWith("<svg"), "must start with <svg>");
      assert(written.includes("</svg>"), "must contain </svg>");
      assert(
        written.includes("Maze Navigation &#x2014; evolveRL Milestones") ||
          written.includes("Maze Navigation — evolveRL Milestones"),
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
  assertEquals(MILESTONE_SVG_PATH, "docs/screenshots/maze_navigation_milestones.svg");
});
