/**
 * Unit tests for the cart-pole NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 *
 * Migration note (issue #236): the controller now evolves through
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
  CartPoleAdapter,
  type CartPoleEpisodeState,
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveCartPoleController,
  formatEvolutionCsv,
  type GenerationInfo,
  INPUT_COUNT,
  MAX_STEPS,
  OUTPUT_COUNT,
  renderTopologyChartSvg,
  replayController,
  scoreController,
  scoreTiltDirectionPolicy,
  SOLVED_THRESHOLD,
  SVG_FRAME_COUNT,
} from "./cart_pole.ts";
import { renderRunSVG } from "./svg.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

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
  name: "evolveCartPoleController generation-1 telemetry sits well below the threshold",
  // NEAT-AI 5.0.0 loads a Rust/WASM FFI library + Metal accelerator that
  // do not unload before the test ends — disable the sanitisers for the
  // evolve-driven tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Gen 1 must be noise: a fresh `new Creature(input, output)` seed
    // and the library's uniform-random structural mutations cannot solve
    // cart-pole under the default wobble regime.
    let firstGenMean = Number.POSITIVE_INFINITY;
    let firstGenBest = Number.POSITIVE_INFINITY;
    await evolveCartPoleController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === Number.POSITIVE_INFINITY) {
          firstGenMean = info.meanScore;
          firstGenBest = info.bestScore;
        }
      },
    });
    assert(
      firstGenMean < SOLVED_THRESHOLD / 2,
      `expected gen-1 population mean to be below half the threshold ` +
        `(${SOLVED_THRESHOLD / 2}), got ${firstGenMean}`,
    );
    assert(
      firstGenBest < SOLVED_THRESHOLD,
      `expected gen-1 best to sit below SOLVED_THRESHOLD=${SOLVED_THRESHOLD} ` +
        `under the wobble regime, got ${firstGenBest}`,
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
  name: "evolveCartPoleController gen-1 and gen-final snapshots differ in score or topology",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Issue #236 — under the new `evolveRL`-driven loop the snapshot
    // contract is reduced to the seed creature (gen 1) plus the trained
    // champion at the final generation, because the upstream API does
    // not expose mid-run creature exports. We still assert the two
    // snapshots are not byte-identical, which is what the historical
    // regression cover (issue #160) really cares about.
    const tmp = Deno.makeTempDirSync({ prefix: "cart_pole_snap_diff_" });
    try {
      const result = await evolveCartPoleController({
        ...DEFAULT_EVOLVE_OPTIONS,
        iterations: 12,
        snapshotConfig: { checkpoints: [1], outputDir: tmp },
      });
      const snapshots = loadSnapshots(tmp);
      assertGreaterOrEqual(
        snapshots.length,
        2,
        `expected at least seed + final snapshots, got ${snapshots.length}`,
      );
      const first = snapshots[0];
      const last = snapshots[snapshots.length - 1];
      const firstSerialised = JSON.stringify(first.creature);
      const lastSerialised = JSON.stringify(last.creature);
      const differ = first.score !== last.score ||
        firstSerialised !== lastSerialised;
      assert(
        differ,
        `expected gen-${first.generation} and gen-${last.generation} snapshots ` +
          `to differ in score or topology, but they are byte-identical at score ` +
          `${first.score}. Final generation was ${result.generations}.`,
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "evolveCartPoleController writes snapshots and the strip SVG embeds one panel per snapshot",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "cart_pole_snapshots_test_" });
    try {
      // Capture both ends of the run so the multi-panel SVG has at
      // least two frames to render. Mid-run checkpoints are no longer
      // captured under the evolveRL API.
      await evolveCartPoleController({
        seed: 1,
        populationSize: 3,
        targetError: 0,
        timeoutMinutes: 5,
        iterations: 3,
        mutationStrength: 0.05,
        mutationRate: 0.05,
        trials: 2,
        trialSeed: 1,
        initialPerturbation: 0.05,
        snapshotConfig: { checkpoints: [1], outputDir: tmp },
      });

      const snapshots = loadSnapshots(tmp);
      assertGreaterOrEqual(snapshots.length, 2);

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Cart-Pole — Evolution Progress",
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
  name: "evolveCartPoleController emits GenerationInfo with sensible neuron and synapse counts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const samples: GenerationInfo[] = [];
    await evolveCartPoleController({
      seed: 1,
      populationSize: 3,
      targetError: -1,
      timeoutMinutes: 1,
      iterations: 3,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.05,
      onGeneration: (info) => samples.push(info),
    });
    assertGreater(samples.length, 0, "expected at least one onGeneration call");
    for (const info of samples) {
      // The minimal seed is `INPUT_COUNT + OUTPUT_COUNT` neurons with
      // `INPUT_COUNT` direct synapses. The first generation reports at
      // least the seed counts; later generations may grow.
      assertGreaterOrEqual(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertGreaterOrEqual(info.synapses, INPUT_COUNT);
      assertGreaterOrEqual(info.bestScore, 0);
      assertGreaterOrEqual(info.meanScore, 0);
    }
  },
});

Deno.test(
  "formatEvolutionCsv emits the audit-mandated header and one row per record",
  () => {
    const rows: EvolutionRow[] = [
      { generation: 0, bestFitness: 12.5, meanFitness: 8.2, neuronCount: 5, synapseCount: 4 },
      { generation: 1, bestFitness: 200, meanFitness: 80, neuronCount: 6, synapseCount: 5 },
    ];
    const csv = formatEvolutionCsv(rows);
    const lines = csv.trim().split("\n");
    assertEquals(lines[0], EVOLUTION_CSV_HEADER);
    assertEquals(
      EVOLUTION_CSV_HEADER,
      "generation,best_fitness,mean_fitness,neuron_count,synapse_count",
    );
    assertEquals(lines.length, rows.length + 1);
    assertEquals(lines[1], "0,12.5,8.2,5,4");
    assertEquals(lines[2], "1,200,80,6,5");
    assertEquals(formatEvolutionCsv(rows), csv);
  },
);

Deno.test("renderTopologyChartSvg produces a well-formed SVG referencing both lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 0, bestFitness: 50, meanFitness: 20, neuronCount: 5, synapseCount: 4 },
    { generation: 5, bestFitness: 200, meanFitness: 100, neuronCount: 6, synapseCount: 5 },
    { generation: 10, bestFitness: 480, meanFitness: 320, neuronCount: 7, synapseCount: 6 },
  ];
  const svg = renderTopologyChartSvg(rows);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes("neuron-count"), "expected neuron-count polyline");
  assert(svg.includes("synapse-count"), "expected synapse-count polyline");
  assert(svg.includes("Cart Pole — Topology Growth"));
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
