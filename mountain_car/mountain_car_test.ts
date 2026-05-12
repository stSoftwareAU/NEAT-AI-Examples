/**
 * Unit tests for the Mountain-Car NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 *
 * Migration note (issue #237): the controller now evolves through
 * `Creature.evolveRL()`, so the tests for the removed
 * `buildRandomPopulation` and `mutateCreatureExport` internal helpers
 * have been dropped in favour of direct adapter and controller tests.
 * The remaining tests still assert on public behaviour rather than
 * implementation choices.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import {
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveMountainCarController,
  formatEvolutionCsv,
  type GenerationInfo,
  INPUT_COUNT,
  MAX_STEPS,
  MountainCarAdapter,
  type MountainCarEpisodeState,
  OUTPUT_COUNT,
  renderTopologyChartSvg,
  replayController,
  scoreController,
  scoreSwingUpPolicy,
  SOLVED_THRESHOLD,
  SUCCESS_BONUS,
} from "./mountain_car.ts";
import { renderRunSVG } from "./svg.ts";
import { GOAL_POSITION, MAX_EPISODE_STEPS } from "./physics.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

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
  name: "evolveMountainCarController generation-1 population is noise on average",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise: a fresh `new Creature(input, output)` seed
    // and the library's uniform-random structural mutations cannot
    // already solve mountain-car. We bound the run to a single
    // generation via the `iterations` cap (NEAT-AI 5.0.0 requires
    // integer `timeoutMinutes`, so sub-minute backstops are no longer
    // expressible).
    let firstGenMean = Infinity;
    let firstGenBestSummit = Infinity;
    await evolveMountainCarController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === Infinity) {
          firstGenMean = info.meanScore;
          firstGenBestSummit = info.bestSummitRate;
        }
      },
    });
    // meanScore is `SUCCESS_BONUS * summitRate`. A noisy population
    // dominated by timeouts has a near-zero summit rate so the mean
    // sits well below SUCCESS_BONUS/4.
    assert(
      firstGenMean < SUCCESS_BONUS / 4,
      `expected gen-1 population mean to be well below SUCCESS_BONUS/4 ` +
        `(${SUCCESS_BONUS / 4}), got ${firstGenMean}`,
    );
    // It is theoretically possible for a lucky random NEAT genome to
    // already swing the car up, but its summit rate cannot already be
    // at the threshold — that would defeat the noise narrative.
    assert(
      firstGenBestSummit < SOLVED_THRESHOLD,
      `expected gen-1 best summit rate to be below the solve threshold ` +
        `${SOLVED_THRESHOLD}, got ${firstGenBestSummit}`,
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

Deno.test({
  name:
    "evolveMountainCarController finds a champion that meets SOLVED_THRESHOLD with the default seed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion's summit rate to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
        `got ${result.summitRate} after ${result.generations} generations ` +
        `(score=${result.bestScore})`,
    );
    assertGreaterOrEqual(result.summitRate, SOLVED_THRESHOLD);

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
});

Deno.test({
  name: "evolveMountainCarController emits GenerationInfo with sensible neuron and synapse counts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const samples: GenerationInfo[] = [];
    await evolveMountainCarController({
      seed: 1,
      populationSize: 3,
      targetError: -1,
      timeoutMinutes: 1,
      iterations: 3,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.05,
      onGeneration: (info) => samples.push(info),
    });
    assertGreater(samples.length, 0, "expected at least one onGeneration call");
    for (const info of samples) {
      // The minimal seed is `INPUT_COUNT + OUTPUT_COUNT` neurons with
      // at least `INPUT_COUNT * OUTPUT_COUNT` direct synapses. Library
      // mutation may grow either count, so we lower-bound rather than
      // assert exact equality.
      assertGreaterOrEqual(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertGreaterOrEqual(info.synapses, INPUT_COUNT);
      assertGreaterOrEqual(info.bestSummitRate, 0);
      assertGreaterOrEqual(1, info.bestSummitRate);
    }
  },
});

Deno.test({
  name:
    "evolveMountainCarController writes snapshots and the strip SVG embeds one panel per snapshot",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "mountain_car_snapshots_test_" });
    try {
      // Under the evolveRL API only the seed creature (gen-1) and the
      // final champion are captured. Request gen-1 explicitly — the
      // final-generation snapshot is always written.
      await evolveMountainCarController({
        seed: 1,
        populationSize: 3,
        targetError: -1,
        timeoutMinutes: 5,
        iterations: 3,
        mutationStrength: 0.05,
        mutationRate: 0.05,
        addNeuronRate: 0,
        trials: 2,
        trialSeed: 1,
        initialPerturbation: 0.05,
        snapshotConfig: { checkpoints: [1], outputDir: tmp },
      });

      const snapshots = loadSnapshots(tmp);
      assertGreaterOrEqual(
        snapshots.length,
        2,
        `expected at least seed + final snapshots, got ${snapshots.length}`,
      );

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Mountain Car — Evolution Progress",
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

Deno.test(
  "formatEvolutionCsv emits the audit-mandated header and one row per record",
  () => {
    // Audit issue #221: CSV header must be the canonical schema used by
    // every audited example.
    const rows: EvolutionRow[] = [
      { generation: 0, bestFitness: -75.5, meanFitness: -90.1, neuronCount: 5, synapseCount: 6 },
      { generation: 1, bestFitness: 42.0, meanFitness: -10.0, neuronCount: 6, synapseCount: 7 },
    ];
    const csv = formatEvolutionCsv(rows);
    const lines = csv.trim().split("\n");
    assertEquals(lines[0], EVOLUTION_CSV_HEADER);
    assertEquals(
      EVOLUTION_CSV_HEADER,
      "generation,best_fitness,mean_fitness,neuron_count,synapse_count",
    );
    assertEquals(lines.length, rows.length + 1);
    assertEquals(lines[1], "0,-75.5,-90.1,5,6");
    assertEquals(lines[2], "1,42,-10,6,7");
    // Determinism: identical inputs produce identical bytes.
    assertEquals(formatEvolutionCsv(rows), csv);
  },
);

Deno.test("renderTopologyChartSvg produces a well-formed SVG referencing both lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 0, bestFitness: -50, meanFitness: -90, neuronCount: 5, synapseCount: 6 },
    { generation: 5, bestFitness: 100, meanFitness: 10, neuronCount: 6, synapseCount: 7 },
    { generation: 10, bestFitness: 471, meanFitness: 200, neuronCount: 7, synapseCount: 8 },
  ];
  const svg = renderTopologyChartSvg(rows);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes("neuron-count"), "expected neuron-count polyline");
  assert(svg.includes("synapse-count"), "expected synapse-count polyline");
  assert(svg.includes("Mountain Car — Topology Growth"));
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
