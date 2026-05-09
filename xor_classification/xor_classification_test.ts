/**
 * Unit tests for the XOR classification example. "What" tests only —
 * each test calls a real function and asserts on observable outputs
 * (predictions, fitness, file contents, SVG structure).
 *
 * Issue #148: the hand-crafted minimal-seed creature has been removed.
 * Tests previously named after `buildMinimalSeedCreature` now exercise
 * the uniform-random {@link buildRandomSeedCreature} replacement, and
 * the few assertions that depended on the all-zero scaffold (e.g. MSE
 * exactly 0.25) have been relaxed to the contract the random gen-1
 * creature still satisfies — finite outputs in `[0, 1]` and a
 * gen-1 score well below the solved threshold.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import {
  buildRandomSeedCreature,
  correctCount,
  DECISION_BOUNDARY_GRID,
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveXorController,
  formatEvolutionCsv,
  type GenerationInfo,
  INPUT_COUNT,
  meanSquaredError,
  OUTPUT_COUNT,
  planSegments,
  predict,
  renderFitnessChartSvg,
  renderTopologyChartSvg,
  writeXorDataset,
  xorSamples,
} from "./xor_classification.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { renderDecisionBoundarySVG, shadeColour } from "./svg.ts";

Deno.test("xorSamples returns the four canonical truth-table rows", () => {
  const samples = xorSamples();
  assertEquals(samples.length, 4);
  assertEquals(samples[0], { inputs: [0, 0], target: 0 });
  assertEquals(samples[1], { inputs: [0, 1], target: 1 });
  assertEquals(samples[2], { inputs: [1, 0], target: 1 });
  assertEquals(samples[3], { inputs: [1, 1], target: 0 });
});

Deno.test("buildRandomSeedCreature has 2 inputs, 0 hidden, 1 output", () => {
  const json = buildRandomSeedCreature(12345);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  // Two neurons in the export shape: only the output (inputs are implicit
  // by `input` count). No hidden neurons — NEAT must invent them.
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(
    hidden.length,
    0,
    "random seed must have zero hidden neurons — NEAT must invent them",
  );
});

Deno.test("buildRandomSeedCreature produces a valid creature with finite outputs", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  creature.validate();
  assertEquals(creature.input, INPUT_COUNT);
  assertEquals(creature.output, OUTPUT_COUNT);
  for (const { inputs } of xorSamples()) {
    const out = predict(creature, inputs);
    assert(Number.isFinite(out));
  }
});

Deno.test("buildRandomSeedCreature is deterministic for a given seed", () => {
  // Same seed → identical export; different seed → different export.
  // No hand-crafted scaffold: every neuron, weight, and bias is drawn
  // from the seeded PRNG.
  const a = buildRandomSeedCreature(4242);
  const b = buildRandomSeedCreature(4242);
  const c = buildRandomSeedCreature(9999);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assert(
    JSON.stringify(a) !== JSON.stringify(c),
    "different seeds must produce different random creatures",
  );
});

Deno.test("predict returns a number in [0, 1] for the random seed creature", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  for (const { inputs } of xorSamples()) {
    const out = predict(creature, inputs);
    assert(Number.isFinite(out), `output must be finite, got ${out}`);
    assertGreaterOrEqual(out, 0);
    assertGreaterOrEqual(1, out);
  }
});

Deno.test("meanSquaredError on the random seed is in [0, 1] and finite", () => {
  // The random seed has zero hidden neurons and random direct weights, so
  // it cannot represent XOR. Per-sample squared error is bounded by 1
  // (LOGISTIC output ∈ [0, 1] vs target ∈ {0, 1}).
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  const mse = meanSquaredError(creature);
  assert(Number.isFinite(mse));
  assertGreaterOrEqual(mse, 0);
  assertGreaterOrEqual(1, mse);
});

Deno.test("correctCount returns 0..4", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  const c = correctCount(creature);
  assertGreaterOrEqual(c, 0);
  assertGreaterOrEqual(4, c);
});

Deno.test("writeXorDataset emits a binary file with exactly four records", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "xor_data_" });
  try {
    const path = writeXorDataset(tmp);
    assertEquals(existsSync(path), true);
    const bytes = Deno.readFileSync(path);
    const stride = INPUT_COUNT + OUTPUT_COUNT;
    // 4 samples * 3 floats * 4 bytes = 48 bytes.
    assertEquals(bytes.length, 4 * stride * 4);
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, 4 * stride);
    for (let i = 0; i < 4; i++) {
      const sample = xorSamples()[i];
      assertEquals(view[i * stride + 0], sample.inputs[0]);
      assertEquals(view[i * stride + 1], sample.inputs[1]);
      assertEquals(view[i * stride + INPUT_COUNT], sample.target);
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("planSegments inserts every in-budget checkpoint and ends at maxGenerations", () => {
  // Mixed checkpoints — some in budget, some out — must be deduped,
  // sorted, and the budget endpoint must always be present.
  assertEquals(planSegments([1, 10, 100, 1000, 10000], 50), [1, 10, 50]);
  assertEquals(planSegments([1, 5], 5), [1, 5]);
  assertEquals(planSegments([], 7), [7]);
  // Checkpoints past the budget never become segment ends.
  assertEquals(planSegments([1000], 10), [10]);
});

Deno.test(
  "evolveXorController solves XOR and grows hidden neurons (happy path)",
  async () => {
    // Reduced budget: small population + capped generations to stay
    // inside the 120-second per-test budget while still giving NEAT
    // room to invent a hidden neuron and solve XOR from random noise.
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      populationSize: 30,
      maxGenerations: 400,
      // Tests skip the wall-clock backstop. NEAT-AI activates a
      // GPU/discovery code path under `timeoutMinutes` whose dynamic
      // library load Deno's --allow-ffi sanitizer treats as a leak; the
      // production runner still exercises that path via
      // `DEFAULT_EVOLVE_OPTIONS.timeoutMinutes`.
      timeoutMinutes: 0,
    });
    assertEquals(
      result.solved,
      true,
      `expected the champion to solve XOR, got error=${result.bestError} ` +
        `after ${result.generations} generations`,
    );
    assertEquals(correctCount(result.champion), 4);
    assertGreater(DEFAULT_EVOLVE_OPTIONS.errorThreshold, result.bestError - 1e-9);

    // The champion must have at least one hidden neuron — XOR is not
    // linearly separable, so a winning solution requires NEAT to have
    // grown the topology beyond the random direct-only seed.
    const championExport = result.champion.exportJSON();
    const hiddenNeurons = championExport.neurons.filter((n) => n.type === "hidden");
    assertGreater(
      hiddenNeurons.length,
      0,
      "champion must contain at least one hidden neuron invented by NEAT",
    );

    // Champion must serialise cleanly for downstream consumption.
    const tmp = await Deno.makeTempDir({ prefix: "xor_test_" });
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
  "evolveXorController emits GenerationInfo whose fields are finite numbers",
  async () => {
    const samples: GenerationInfo[] = [];
    await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      populationSize: 6,
      errorThreshold: 0, // unreachable in three generations
      timeoutMinutes: 0, // skip wall-clock backstop in tests (see "happy path")
      onGeneration: (info) => samples.push(info),
    });
    assertGreater(samples.length, 0);
    for (const s of samples) {
      assertEquals(typeof s.neurons, "number");
      assertEquals(typeof s.synapses, "number");
      assertEquals(Number.isInteger(s.neurons), true);
      assertEquals(Number.isInteger(s.synapses), true);
      assertGreater(s.neurons, 0);
      assertGreaterOrEqual(s.synapses, 0);
      // Best-fitness / best-error must be finite — they reflect the
      // captured champion. `meanFitness` may be NaN early on when the
      // library has not yet evaluated every member, so we do not
      // assert finiteness on the population-mean field.
      assert(Number.isFinite(s.bestFitness), `bestFitness must be finite, got ${s.bestFitness}`);
      assert(Number.isFinite(s.bestError), `bestError must be finite, got ${s.bestError}`);
    }
  },
);

Deno.test(
  "evolveXorController is deterministic for a fixed seed",
  async () => {
    const opts = {
      ...DEFAULT_EVOLVE_OPTIONS,
      seed: 4242,
      populationSize: 6,
      maxGenerations: 3,
      errorThreshold: 0,
      timeoutMinutes: 0, // skip wall-clock backstop in tests (see "happy path")
    };
    const a = await evolveXorController(opts);
    const b = await evolveXorController(opts);
    // Same seed must produce the same champion topology and weights.
    assertEquals(
      JSON.stringify(a.champion.exportJSON()),
      JSON.stringify(b.champion.exportJSON()),
      "two runs with the same seed must produce identical champions",
    );
    assertEquals(a.bestError, b.bestError);
  },
);

Deno.test(
  "evolveXorController honours the hard generation cap when the threshold is unreachable",
  async () => {
    // errorThreshold=0 is unreachable in two generations from random
    // noise; the run must still terminate at maxGenerations and return
    // a usable champion (no infinite loop).
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 2,
      populationSize: 6,
      errorThreshold: 0,
      timeoutMinutes: 0, // skip wall-clock backstop in tests (see "happy path")
    });
    assertEquals(result.solved, false);
    assertGreaterOrEqual(result.generations, 1);
    // The library may run a small number of additional iterations
    // inside a single segment, but the loop must not exceed a small
    // multiple of `maxGenerations` — i.e. the cap is honoured at the
    // segment-loop level so the run cannot wedge indefinitely.
    assertGreaterOrEqual(20, result.generations);
    // Champion is a real Creature that activates without throwing.
    const out = predict(result.champion, [0, 1]);
    assert(Number.isFinite(out), `champion output must be finite, got ${out}`);
  },
);

Deno.test(
  "evolveXorController gen-1 snapshot has a poor score (well below the threshold)",
  async () => {
    // Verify the noise → competent narrative: the captured gen-1
    // snapshot must demonstrably be far from solving XOR. With random
    // direct-only weights (no hidden neurons) the best-case MSE is at
    // least the linear-baseline plateau of 0.25, so `1 - MSE` cannot
    // reach the solved threshold of `1 - errorThreshold` (= 0.95).
    const tmp = Deno.makeTempDirSync({ prefix: "xor_gen1_test_" });
    try {
      await evolveXorController({
        ...DEFAULT_EVOLVE_OPTIONS,
        maxGenerations: 1,
        populationSize: 6,
        errorThreshold: 0,
        timeoutMinutes: 0, // skip wall-clock backstop in tests
        snapshotConfig: { checkpoints: [1], outputDir: tmp },
      });
      const snaps = loadSnapshots(tmp);
      assertEquals(snaps.length, 1);
      const gen1 = snaps[0];
      assertEquals(gen1.generation, 1);
      const solvedScore = 1 - DEFAULT_EVOLVE_OPTIONS.errorThreshold;
      assertGreater(
        solvedScore,
        gen1.score,
        `gen-1 score (${gen1.score}) must be below the solved threshold (${solvedScore})`,
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test("shadeColour clamps and produces a hex colour string", () => {
  assertEquals(shadeColour(-1).startsWith("#"), true);
  assertEquals(shadeColour(2).startsWith("#"), true);
  assertEquals(shadeColour(0).length, 7);
  assertEquals(shadeColour(0.5).length, 7);
  assertEquals(shadeColour(1).length, 7);
  assert(shadeColour(0) !== shadeColour(1), "ramp endpoints must differ");
});

Deno.test("renderDecisionBoundarySVG produces a well-formed SVG with all four samples", () => {
  // Use the random seed; the test only cares about SVG structure.
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: 8,
    samples: xorSamples(),
  });
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const widthMatch = svg.match(/width="(\d+)"/);
  const heightMatch = svg.match(/height="(\d+)"/);
  assert(widthMatch, "SVG must declare a width");
  assert(heightMatch, "SVG must declare a height");
  assertGreater(Number.parseInt(widthMatch![1], 10), 0);
  assertGreater(Number.parseInt(heightMatch![1], 10), 0);

  const matches = svg.match(/<g class="sample"/g) ?? [];
  assertEquals(matches.length, 4);

  for (const { inputs, target } of xorSamples()) {
    assert(
      svg.includes(`(${inputs[0]},${inputs[1]})→${target}`),
      `expected label for sample (${inputs[0]},${inputs[1]})→${target}`,
    );
  }
});

Deno.test("renderDecisionBoundarySVG honours the requested grid resolution", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  const grid = 6;
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: grid,
    samples: xorSamples(),
  });
  const start = svg.indexOf('<g class="grid">');
  const end = svg.indexOf("</g>", start);
  assertGreater(end, start);
  const gridSection = svg.slice(start, end);
  const cellRects = gridSection.match(/<rect /g) ?? [];
  assertEquals(cellRects.length, grid * grid);
});

Deno.test("renderDecisionBoundarySVG throws on grid resolution < 2", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  let threw = false;
  try {
    renderDecisionBoundarySVG(creature, { gridResolution: 1, samples: xorSamples() });
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for tiny grid resolution");
});

Deno.test("renderDecisionBoundarySVG embeds SMIL pulse animations on each sample", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: 8,
    samples: xorSamples(),
  });
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 8);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
  const pulseMatches = svg.match(/class="pulse"/g) ?? [];
  assertEquals(pulseMatches.length, 4);
});

Deno.test(
  "evolveXorController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "xor_snapshots_test_" });
    try {
      const checkpoints = [1, 2, 3];
      await evolveXorController({
        ...DEFAULT_EVOLVE_OPTIONS,
        // Force the loop to keep running long enough that all
        // checkpoints fire even if the run otherwise solves early.
        errorThreshold: 0,
        maxGenerations: 4,
        populationSize: 6,
        timeoutMinutes: 0, // skip wall-clock backstop in tests
        snapshotConfig: { checkpoints, outputDir: tmp },
      });

      // Each configured checkpoint writes a snapshot file.
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
        title: "XOR Classification — Evolution Progress",
      });
      assert(svg.startsWith("<svg"), "must start with <svg>");
      assert(svg.length > 0, "SVG must be non-empty");
      const panels = svg.match(/<g class="panel"/g) ?? [];
      assertEquals(
        panels.length,
        checkpoints.length,
        `expected one panel per snapshot, got ${panels.length}`,
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test("formatEvolutionCsv emits the canonical header and one row per sample", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: 0.5, meanFitness: 0.25, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: 0.75, meanFitness: 0.4, neuronCount: 4, synapseCount: 3 },
  ];
  const csv = formatEvolutionCsv(rows);
  const lines = csv.trim().split("\n");
  assertEquals(lines.length, 1 + rows.length);
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines[1], "1,0.5,0.25,3,2");
  assertEquals(lines[2], "2,0.75,0.4,4,3");
});

Deno.test("formatEvolutionCsv handles empty input and trailing newline", () => {
  const empty = formatEvolutionCsv([]);
  assertEquals(empty, EVOLUTION_CSV_HEADER + "\n");
  const single = formatEvolutionCsv([
    { generation: 7, bestFitness: 0.123456789, meanFitness: NaN, neuronCount: 5, synapseCount: 6 },
  ]);
  // NaN must serialise as "0" and floats are trimmed to six significant digits
  // beyond the decimal point.
  assert(single.endsWith("\n"), "CSV must end with a single newline");
  const lines = single.trim().split("\n");
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines[1], "7,0.123457,0,5,6");
});

Deno.test("renderFitnessChartSvg produces a well-formed SVG referencing both fitness lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: 0.6, meanFitness: 0.3, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: 0.8, meanFitness: 0.5, neuronCount: 4, synapseCount: 3 },
  ];
  const svg = renderFitnessChartSvg(rows);
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assert(svg.includes('class="best-fitness"'), "must emit the best-fitness polyline");
  assert(svg.includes('class="mean-fitness"'), "must emit the mean-fitness polyline");
  assert(svg.includes("Best vs Mean Fitness"));
});

Deno.test("renderFitnessChartSvg rejects empty input", () => {
  let threw = false;
  try {
    renderFitnessChartSvg([]);
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for empty input");
});

Deno.test("renderTopologyChartSvg produces a well-formed SVG referencing both count lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: 0.6, meanFitness: 0.3, neuronCount: 3, synapseCount: 2 },
    { generation: 5, bestFitness: 0.95, meanFitness: 0.7, neuronCount: 6, synapseCount: 9 },
  ];
  const svg = renderTopologyChartSvg(rows);
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assert(svg.includes('class="neuron-count"'), "must emit the neuron polyline");
  assert(svg.includes('class="synapse-count"'), "must emit the synapse polyline");
  assert(svg.includes("Topology Growth"));
});

Deno.test("renderTopologyChartSvg rejects empty input", () => {
  let threw = false;
  try {
    renderTopologyChartSvg([]);
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for empty input");
});

Deno.test(
  "evolveXorController honours the timeoutMinutes backstop without throwing",
  // Activating the 5-minute backstop loads NEAT-AI's GPU/discovery
  // cleanup machinery, which Deno's test sanitizer reports as a leaked
  // dynamic library when --allow-ffi is enabled. The behaviour is
  // exactly what the audit (issue #205) wants — the production runner
  // exercises it on every invocation. We disable the sanitizer flags
  // for this test alone so the rest of the suite stays clean while the
  // option is still verified end-to-end.
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // The 5-minute audit backstop is mandated by issue #205. The
    // library requires a positive integer; we verify the option is
    // accepted by running a short evolveDir end-to-end.
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      populationSize: 6,
      errorThreshold: 0,
      timeoutMinutes: 5,
    });
    assertGreaterOrEqual(result.generations, 1);
    const out = predict(result.champion, [0, 1]);
    assert(Number.isFinite(out));
  },
);

Deno.test("renderDecisionBoundarySVG output uses the canonical screenshot resolution", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(12345));
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  const start = svg.indexOf('<g class="grid">');
  const end = svg.indexOf("</g>", start);
  const cellRects = svg.slice(start, end).match(/<rect /g) ?? [];
  assertEquals(cellRects.length, DECISION_BOUNDARY_GRID * DECISION_BOUNDARY_GRID);
});
