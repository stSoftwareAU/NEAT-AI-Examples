/**
 * Unit tests for the cart-pole NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import {
  buildRandomPopulation,
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveCartPoleController,
  formatEvolutionCsv,
  type GenerationInfo,
  INPUT_COUNT,
  MAX_STEPS,
  mutateCreatureExport,
  OUTPUT_COUNT,
  renderTopologyChartSvg,
  replayController,
  scoreController,
  scoreTiltDirectionPolicy,
  SOLVED_THRESHOLD,
  SVG_FRAME_COUNT,
} from "./cart_pole.ts";
import { renderRunSVG } from "./svg.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

Deno.test("buildRandomPopulation produces uniform-random NEAT genomes", () => {
  // Topology must NOT be hand-specified — the library decides shape.
  // We assert only that the population has the requested size and that
  // every member is a valid Creature with the right input/output counts.
  const pop = buildRandomPopulation(42, 5);
  assertEquals(pop.length, 5);
  for (const json of pop) {
    assertEquals(json.input, INPUT_COUNT);
    assertEquals(json.output, OUTPUT_COUNT);
    const creature = Creature.fromJSON(json);
    creature.validate();
    // Activating must return one finite scalar.
    creature.clearState();
    const out = creature.activate(Float32Array.from([0, 0, 0, 0]));
    assertEquals(out.length, OUTPUT_COUNT);
    assert(Number.isFinite(out[0]), `expected finite output, got ${out[0]}`);
  }
});

Deno.test("buildRandomPopulation is deterministic for the same seed", () => {
  const a = buildRandomPopulation(99, 4);
  const b = buildRandomPopulation(99, 4);
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    // Compare via JSON to ignore property ordering.
    assertEquals(JSON.stringify(a[i]), JSON.stringify(b[i]));
  }
});

Deno.test("buildRandomPopulation does not hand-specify hidden topology", () => {
  // Generation-1 noise: the library's minimal seed has zero hidden
  // neurons and direct input → output connections. Hidden structure
  // must emerge from mutation, not be supplied by the example.
  const pop = buildRandomPopulation(7, 3);
  for (const json of pop) {
    const hiddenNeurons = json.neurons.filter((n) => n.type === "hidden");
    assertEquals(
      hiddenNeurons.length,
      0,
      "no hidden neurons should be hand-specified in the initial population",
    );
  }
});

Deno.test("mutateCreatureExport yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const pop = buildRandomPopulation(1, 1);
  const child = mutateCreatureExport(pop[0], random, 1.0, 0.3);
  const creature = Creature.fromJSON(child);
  creature.validate();
});

Deno.test("mutateCreatureExport is deterministic for the same random stream", () => {
  const pop = buildRandomPopulation(5, 1);
  const a = mutateCreatureExport(pop[0], createDeterministicRandom(11), 0.8, 0.2);
  const b = mutateCreatureExport(pop[0], createDeterministicRandom(11), 0.8, 0.2);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("mutateCreatureExport with addNeuronRate=1 grows topology", () => {
  // Forcing addNeuronRate=1 must split exactly one synapse, adding
  // one hidden neuron and replacing one synapse with two.
  const pop = buildRandomPopulation(3, 1);
  const parent = pop[0];
  const random = createDeterministicRandom(13);
  const child = mutateCreatureExport(parent, random, 0, 0, {
    addNeuronRate: 1,
    hiddenCounter: { value: 0 },
  });
  const parentHidden = parent.neurons.filter((n) => n.type === "hidden").length;
  const childHidden = child.neurons.filter((n) => n.type === "hidden").length;
  assertEquals(childHidden - parentHidden, 1, "expected exactly one new hidden neuron");
  assertEquals(
    child.synapses.length - parent.synapses.length,
    1,
    "splitting one synapse adds one net synapse (-1 + 2)",
  );
  // Resulting creature must still validate.
  Creature.fromJSON(child).validate();
});

Deno.test("scoreTiltDirectionPolicy beats a 'do nothing' baseline", () => {
  // The hand-crafted policy isn't perfect, but it should clearly out-survive
  // 50 steps — the simulator is solvable with simple feedback.
  const score = scoreTiltDirectionPolicy(MAX_STEPS);
  assertGreater(
    score,
    50,
    `tilt-direction policy should survive >50 steps, got ${score}`,
  );
});

Deno.test("scoreController returns a value between 0 and MAX_STEPS", () => {
  const pop = buildRandomPopulation(2, 1);
  const creature = Creature.fromJSON(pop[0]);
  const score = scoreController(creature, MAX_STEPS);
  assertGreaterOrEqual(score, 0);
  assertGreaterOrEqual(MAX_STEPS, score);
});

Deno.test(
  "scoreController with multiple trials returns the mean across trials",
  () => {
    // Sanity: the mean lies in [0, MAX_STEPS] and is deterministic for
    // identical inputs (same trialSeed).
    const pop = buildRandomPopulation(99, 1);
    const json: CreatureExport = pop[0];
    const a = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 3,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    const b = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 3,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    assertEquals(a, b);
    assertGreaterOrEqual(a, 0);
    assertGreaterOrEqual(MAX_STEPS, a);
  },
);

Deno.test(
  "evolveCartPoleController generation-1 population is noise on average",
  () => {
    // Gen 1 must be noise. Issue #160 enabled a wobble disturbance in
    // the default options so cart-pole is genuinely non-trivial — a
    // uniform-random NEAT population should sit *well* below the
    // threshold so evolution has headroom to climb. We assert the
    // population mean is below `SOLVED_THRESHOLD / 4` — a much
    // tighter bound than the original `/2`, reflecting the harder
    // default. A future regression that re-trivialises the task (e.g.
    // someone zeroing `disturbanceMagnitude`) will flunk this bound.
    let firstGenMean = -Infinity;
    let firstGenBest = -Infinity;
    // Audit issue #220 replaced `maxGenerations` with `targetError` +
    // `timeoutMinutes`. Force the loop to exit after gen 0 by capping
    // `iterations` to 1 — the iterations cap is checked alongside the
    // standard NEAT-AI stop conditions.
    evolveCartPoleController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === -Infinity) {
          firstGenMean = info.meanScore;
          firstGenBest = info.bestScore;
        }
      },
    });
    assert(
      firstGenMean < SOLVED_THRESHOLD / 4,
      `expected gen-1 population mean to be well below quarter the threshold ` +
        `(${SOLVED_THRESHOLD / 4}), got ${firstGenMean}`,
    );
    // Under the wobble regime no random NEAT individual should reach
    // the threshold either — a lucky linear policy that scored 500
    // without wobble cannot survive 10 different wobble patterns.
    assert(
      firstGenBest < SOLVED_THRESHOLD,
      `expected gen-1 best to sit below SOLVED_THRESHOLD=${SOLVED_THRESHOLD} ` +
        `under the wobble regime, got ${firstGenBest}`,
    );
  },
);

Deno.test(
  "evolveCartPoleController shows real generation-1-vs-gen-N improvement",
  () => {
    // Regression cover for issue #160: with the default wobble, the
    // gen-N (N=20) mean must be meaningfully higher than the gen-1
    // mean. A future change that re-trivialises the task — e.g.
    // someone zeroing `disturbanceMagnitude` so gen-1 is already at
    // the cap — leaves no headroom for evolution and would produce
    // gen-1 ≈ gen-N. This test fails fast in that case.
    let firstGenMean = -Infinity;
    let lastGenMean = -Infinity;
    const targetGen = 20;
    // Audit issue #220: replace the old `maxGenerations` cap with the
    // standard NEAT-AI `targetError` + `timeoutMinutes` stop conditions
    // plus the optional `iterations` field used here only to bound the
    // test deterministically without relying on wall-clock timing.
    evolveCartPoleController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: targetGen,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === -Infinity) {
          firstGenMean = info.meanScore;
        }
        lastGenMean = info.meanScore;
      },
    });
    assertGreater(
      lastGenMean,
      firstGenMean + 30,
      `expected gen-${targetGen} mean to improve by at least 30 steps over ` +
        `gen-1; got firstGenMean=${firstGenMean.toFixed(1)} → ` +
        `lastGenMean=${lastGenMean.toFixed(1)}. If the improvement is small ` +
        `the task may have been re-trivialised — check disturbanceMagnitude.`,
    );
  },
);

Deno.test(
  "evolveCartPoleController honours the timeoutMinutes wall-clock backstop",
  () => {
    // Audit issue #220 replaced the old `maxGenerations` cap with the
    // standard NEAT-AI `targetError` + `timeoutMinutes` stop conditions.
    // With a vanishingly small mutation rate, the evolver cannot solve
    // the task. Force the loop to exit via the wall-clock backstop by
    // setting an unreachable `targetError = -1` (target score = MAX_STEPS
    // * 2, never met) and a tiny `timeoutMinutes` budget — the returned
    // `stopReason` must be `timeout` and `solved` false.
    const start = Date.now();
    const result = evolveCartPoleController({
      seed: 999,
      populationSize: 4,
      targetError: -1,
      timeoutMinutes: 0.01, // ~600 ms
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.2,
    });
    const elapsedMs = Date.now() - start;
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve cart-pole",
    );
    assertEquals(
      result.stopReason,
      "timeout",
      `expected stopReason 'timeout', got ${result.stopReason}`,
    );
    assert(
      result.bestScore < SOLVED_THRESHOLD,
      `expected best score below threshold, got ${result.bestScore}`,
    );
    assert(
      elapsedMs < 30_000,
      `expected the run to finish well under 30 seconds, took ${elapsedMs} ms`,
    );
  },
);

Deno.test(
  "evolveCartPoleController finds a controller above SOLVED_THRESHOLD with the default seed",
  async () => {
    const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion's mean score to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
        `got ${result.bestScore} after ${result.generations} generations`,
    );
    assertGreaterOrEqual(result.bestScore, SOLVED_THRESHOLD);

    // Champion must serialise cleanly for downstream consumption.
    const tmp = await Deno.makeTempDir({ prefix: "cart_pole_test_" });
    try {
      const path = join(tmp, "champion.json");
      await safeWriteJson(path, result.champion.exportJSON());
      assertEquals(existsSync(path), true);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveCartPoleController champion generalises to unseen perturbed initial states",
  () => {
    // Re-evaluating the champion against a fresh, independently seeded
    // batch of perturbed starts AND a fresh independently seeded
    // wobble pattern must still score well — the controller has to
    // have learnt to balance rather than overfitting to the training
    // launches or the training wobble pattern (issue #160).
    //
    // The threshold here is 0.8 × `SOLVED_THRESHOLD` rather than the
    // full threshold: the wobble in the default options is strong
    // enough that even a competent controller will occasionally lose
    // a pole on a never-before-seen wobble pattern. Asking for 384/500
    // average steps proves robust generalisation while leaving a
    // realistic margin for fresh wobble noise.
    const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    const independentScore = scoreController(result.champion, MAX_STEPS, {
      trials: 10,
      trialSeed: 987654,
      initialPerturbation: 0.05,
      disturbanceMagnitude: DEFAULT_EVOLVE_OPTIONS.disturbanceMagnitude,
      disturbanceProbability: DEFAULT_EVOLVE_OPTIONS.disturbanceProbability,
      // Different from the training disturbance seed so the wobble
      // pattern is genuinely unseen.
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
);

Deno.test("replayController returns a non-empty trace with the initial state first", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(trace[0].x, 0);
  assertEquals(trace[0].theta, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  // Issue #70: the screenshot is now a single animated frame driven by
  // SMIL `<animate>` elements rather than a static multi-frame strip.
  // We verify the SVG carries animation primitives and that the cart's
  // x-position keyframe list contains the requested number of samples.
  const pop = buildRandomPopulation(6, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 4);
  // Cart `x` animation must enumerate one keyframe per requested sample.
  const cartXAnim = svg.match(/<animate attributeName="x" values="([^"]+)"/);
  assert(cartXAnim, "expected the cart's x animation");
  const valueCount = cartXAnim![1].split(";").length;
  assertEquals(valueCount, Math.min(SVG_FRAME_COUNT, trace.length));
});

Deno.test("renderRunSVG output renders both cart and pole primitives", () => {
  const pop = buildRandomPopulation(8, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace, 4);
  assert(svg.includes('class="cart"'), "expected the cart rectangle");
  assert(svg.includes('class="pole"'), "expected the pole line");
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  // The committed SVG must loop so README readers see the motion every
  // time the page is opened, not just once.
  const pop = buildRandomPopulation(9, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
});

Deno.test(
  "evolveCartPoleController gen-1 and gen-final snapshots differ in score or topology",
  () => {
    // Regression cover for issue #160 — the historical bug captured in
    // issue #158 was that gens 1 / 10 / 100 produced byte-identical
    // snapshot files at score 500 because cart-pole was already solved
    // at gen 1. With the wobble disturbance enabled, the gen-1 snapshot
    // must differ from the gen-final snapshot in either score or
    // topology so the captured progression actually shows evolution.
    const tmp = Deno.makeTempDirSync({ prefix: "cart_pole_snap_diff_" });
    try {
      const checkpoints = [1, 30];
      // Audit issue #220: bound the loop via the optional `iterations`
      // cap (renamed from the removed `maxGenerations`) so the test runs
      // for exactly 30 generations regardless of the standard NEAT-AI
      // `targetError` / `timeoutMinutes` stop conditions.
      evolveCartPoleController({
        ...DEFAULT_EVOLVE_OPTIONS,
        iterations: 30,
        snapshotConfig: { checkpoints, outputDir: tmp },
      });
      const snapshots = loadSnapshots(tmp);
      assertEquals(snapshots.length, checkpoints.length);
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
          `${first.score}. Cart-pole has been re-trivialised — check that the ` +
          `default wobble disturbance is enabled.`,
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveCartPoleController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  () => {
    const tmp = Deno.makeTempDirSync({ prefix: "cart_pole_snapshots_test_" });
    try {
      // Use a tiny population and a deliberately weak seed/strength so
      // the evolutionary loop does not accidentally solve cart-pole in
      // a single generation and trigger the early-stop break before all
      // configured snapshot checkpoints fire.
      const checkpoints = [1, 2, 3];
      // Audit issue #220: bound the loop via `targetError = -1`
      // (unreachable, target score = MAX_STEPS * 2) and a short timeout
      // so the run stops once the last checkpoint is captured.
      evolveCartPoleController({
        seed: 1,
        populationSize: 3,
        targetError: -1,
        timeoutMinutes: 0.05, // ~3s — enough for a few generations of a tiny pop
        mutationStrength: 0.05,
        mutationRate: 0.05,
        addNeuronRate: 0,
        trials: 2,
        trialSeed: 1,
        initialPerturbation: 0.05,
        snapshotConfig: { checkpoints, outputDir: tmp },
      });

      for (const gen of checkpoints) {
        assertEquals(
          existsSync(join(tmp, `snapshot-gen-${gen}.json`)),
          true,
          `expected snapshot-gen-${gen}.json to exist`,
        );
      }

      const snapshots = loadSnapshots(tmp);
      assertEquals(snapshots.length, checkpoints.length);

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Cart-Pole — Evolution Progress",
      });
      assert(svg.startsWith("<svg"), "must start with <svg>");
      assert(svg.length > 0, "SVG must be non-empty");
      const panels = svg.match(/<g class="panel"/g) ?? [];
      assertEquals(panels.length, checkpoints.length);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveCartPoleController emits GenerationInfo with sensible neuron and synapse counts",
  () => {
    const samples: GenerationInfo[] = [];
    // Audit issue #220: bound via `iterations` so the test runs three
    // generations deterministically regardless of wall-clock timing.
    evolveCartPoleController({
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
      // Without structural mutation the topology stays at the library's
      // minimal seed: 4 inputs + 1 output = 5 neurons and 4 synapses.
      assertEquals(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertEquals(info.synapses, INPUT_COUNT);
      assertGreaterOrEqual(info.bestScore, 0);
      assertGreaterOrEqual(info.meanScore, 0);
    }
  },
);

Deno.test(
  "formatEvolutionCsv emits the audit-mandated header and one row per record",
  () => {
    // Audit issue #220: CSV header must be the canonical schema used by
    // every audited example.
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
    // Determinism: identical inputs produce identical bytes.
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

Deno.test(
  "running cart_pole.ts via run.sh-style execution emits champion.json and SVG",
  async () => {
    // Smoke-test that the SVG rendering path writes a sensible file when
    // wired up the same way the runner does. We use a temp dir to
    // avoid polluting the workspace.
    const tmp = await Deno.makeTempDir({ prefix: "cart_pole_smoke_" });
    try {
      ensureDirSync(join(tmp, "screenshots"));
      const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
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
);
