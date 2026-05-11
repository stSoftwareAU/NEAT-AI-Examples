/**
 * Unit tests for the maze-navigation NEAT controller. "What" tests
 * only — each test calls a real function, runs the simulator or
 * evolver, and asserts on the observable outputs.
 *
 * Migration note (issue #239): the controller now evolves through
 * `Creature.evolveRL()`, so the tests for the removed
 * `buildRandomPopulation` and `mutateCreatureExport` internal helpers
 * have been dropped in favour of direct adapter and controller tests.
 * The remaining tests still assert on public behaviour rather than
 * implementation choices.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import {
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveMazeController,
  formatEvolutionCsv,
  type GenerationInfo,
  MAX_STEPS,
  MazeAdapter,
  type MazeEpisodeState,
  renderTopologyChartSvg,
  replayController,
  scoreController,
  SOLVED_THRESHOLD,
} from "./maze_navigation.ts";
import { renderRunSVG } from "./svg.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { Action } from "./maze.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

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
  name: "evolveMazeController generation-1 telemetry sits well below the threshold",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise. A fresh `new Creature(input, output)` seed
    // and the library's uniform-random initial population cannot solve
    // the L-corridor maze under the default seed.
    let firstGenMean = Number.POSITIVE_INFINITY;
    let firstGenBestReached = true;
    // We use `iterations: 1` so the loop terminates immediately after
    // gen 0 — fast and deterministic without any wall-clock dependency.
    await evolveMazeController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === Number.POSITIVE_INFINITY) {
          firstGenMean = info.meanScore;
          firstGenBestReached = info.bestReached;
        }
      },
    });
    assert(
      firstGenMean < SOLVED_THRESHOLD,
      `expected gen-1 population mean to be well below the SOLVED_THRESHOLD ` +
        `(${SOLVED_THRESHOLD}), got ${firstGenMean}`,
    );
    // The default seed must not produce a gen-1 population whose best
    // member already reaches the goal — that would mean we got lucky
    // and the evolution narrative has nothing to show.
    assertEquals(
      firstGenBestReached,
      false,
      "gen-1 best member must not already reach the goal under the default seed",
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
  name:
    "evolveMazeController writes seed + final snapshots and the strip SVG embeds one panel per snapshot",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "maze_snapshots_test_" });
    try {
      // Tiny population, weak mutation, low iterations cap. Under the
      // new evolveRL-driven loop only the seed creature (gen 1) and
      // final champion are snapshot — mid-run intermediate checkpoints
      // are no longer captured because the upstream API does not
      // expose mid-run creature exports.
      await evolveMazeController({
        seed: 1,
        populationSize: 3,
        targetError: -1, // unreachable so the loop runs to the iterations cap
        timeoutMinutes: 5,
        iterations: 4,
        mutationStrength: 0.05,
        mutationRate: 0.05,
        addNeuronRate: 0,
        snapshotConfig: { checkpoints: [1], outputDir: tmp },
      });

      const snapshots = loadSnapshots(tmp);
      assertGreaterOrEqual(
        snapshots.length,
        2,
        `expected at least seed + final snapshots, got ${snapshots.length}`,
      );

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Maze Navigation — Evolution Progress",
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
  name: "evolveMazeController emits GenerationInfo with sensible neuron and synapse counts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const samples: GenerationInfo[] = [];
    await evolveMazeController({
      seed: 1,
      populationSize: 3,
      targetError: -1, // unreachable so the loop runs to the iterations cap
      timeoutMinutes: 5,
      iterations: 3,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      addNeuronRate: 0,
      onGeneration: (info) => samples.push(info),
    });
    assertGreater(samples.length, 0, "expected at least one onGeneration call");
    for (const info of samples) {
      // The minimal seed has `INPUT_COUNT + OUTPUT_COUNT` neurons with
      // `INPUT_COUNT * OUTPUT_COUNT` direct synapses. NEAT-AI may grow
      // topology under its own mutation policy, so the counts can only
      // be asserted as ≥ the seed values.
      assertGreaterOrEqual(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertGreaterOrEqual(info.synapses, INPUT_COUNT);
      assert(Number.isFinite(info.bestScore));
      assert(Number.isFinite(info.meanScore));
      assertEquals(typeof info.bestReached, "boolean");
    }
  },
});

Deno.test(
  "formatEvolutionCsv emits the audit-mandated header and one row per record",
  () => {
    // Audit issue #223: CSV header must be the canonical schema used by
    // every audited example.
    const rows: EvolutionRow[] = [
      { generation: 0, bestFitness: 0.12, meanFitness: 0.05, neuronCount: 9, synapseCount: 20 },
      { generation: 1, bestFitness: 0.6, meanFitness: 0.3, neuronCount: 10, synapseCount: 21 },
    ];
    const csv = formatEvolutionCsv(rows);
    const lines = csv.trim().split("\n");
    assertEquals(lines[0], EVOLUTION_CSV_HEADER);
    assertEquals(
      EVOLUTION_CSV_HEADER,
      "generation,best_fitness,mean_fitness,neuron_count,synapse_count",
    );
    assertEquals(lines.length, rows.length + 1);
    assertEquals(lines[1], "0,0.12,0.05,9,20");
    assertEquals(lines[2], "1,0.6,0.3,10,21");
    // Determinism: identical inputs produce identical bytes.
    assertEquals(formatEvolutionCsv(rows), csv);
  },
);

Deno.test("renderTopologyChartSvg produces a well-formed SVG referencing both lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 0, bestFitness: 0.1, meanFitness: 0.05, neuronCount: 9, synapseCount: 20 },
    { generation: 5, bestFitness: 0.4, meanFitness: 0.2, neuronCount: 10, synapseCount: 21 },
    { generation: 10, bestFitness: 0.9, meanFitness: 0.6, neuronCount: 12, synapseCount: 24 },
  ];
  const svg = renderTopologyChartSvg(rows);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes("neuron-count"), "expected neuron-count polyline");
  assert(svg.includes("synapse-count"), "expected synapse-count polyline");
  assert(svg.includes("Maze Navigation — Topology Growth"));
});

Deno.test("renderTopologyChartSvg rejects empty input", () => {
  let threw = false;
  try {
    renderTopologyChartSvg([]);
  } catch (_err) {
    threw = true;
  }
  assertEquals(threw, true, "expected empty input to throw");
});
