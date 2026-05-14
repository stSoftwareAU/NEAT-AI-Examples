/**
 * Unit tests for the XOR classification example. "What" tests only —
 * each test calls a real function and asserts on observable outputs
 * (predictions, fitness, file contents, SVG structure).
 *
 * Per issue #326, the legacy single-run `EvolveDirSummary` SVG was
 * replaced with the multi-run persistence + chart pipeline shared with
 * the other in-scope examples. Older per-generation telemetry, snapshot
 * strips, and the deprecated CSV / fitness / topology SVG renderers
 * remain absent.
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
  evolveResultToMultiRunSample,
  evolveXorController,
  EXAMPLE_SLUG,
  INPUT_COUNT,
  meanSquaredError,
  OUTPUT_COUNT,
  predict,
  runMultiRunXor,
  writeXorDataset,
  xorSamples,
} from "./xor_classification.ts";
import { renderDecisionBoundarySVG, shadeColour } from "./svg.ts";
import { appendMultiRunRun, loadMultiRunState } from "../common/multi_run_state.ts";

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

Deno.test(
  "evolveXorController solves XOR and grows hidden neurons (happy path)",
  async () => {
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      populationSize: 30,
      maxGenerations: 400,
      // Tests skip the wall-clock backstop — see DEFAULT_EVOLVE_OPTIONS.
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
  "evolveXorController is deterministic for a fixed seed",
  async () => {
    const opts = {
      ...DEFAULT_EVOLVE_OPTIONS,
      seed: 4242,
      populationSize: 6,
      maxGenerations: 3,
      errorThreshold: 0,
      timeoutMinutes: 0,
    };
    const a = await evolveXorController(opts);
    const b = await evolveXorController(opts);
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
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 2,
      populationSize: 6,
      errorThreshold: 0,
      timeoutMinutes: 0,
    });
    assertEquals(result.solved, false);
    assertGreaterOrEqual(result.generations, 1);
    // The cap is honoured at the evolveDir level so the run cannot
    // wedge indefinitely. NEAT-AI may run a small number of additional
    // iterations inside a single segment.
    assertGreaterOrEqual(20, result.generations);
    const out = predict(result.champion, [0, 1]);
    assert(Number.isFinite(out), `champion output must be finite, got ${out}`);
  },
);

Deno.test(
  "evolveXorController exposes finite seed and wall-clock fields on the result",
  async () => {
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      populationSize: 6,
      errorThreshold: 0,
      timeoutMinutes: 0,
    });
    assert(Number.isFinite(result.bestError));
    assert(Number.isFinite(result.bestFitness));
    assert(Number.isFinite(result.wallClockMs));
    assertGreaterOrEqual(result.wallClockMs, 0);
    assertGreater(result.seedNeurons, 0);
    assertGreaterOrEqual(result.seedSynapses, 0);
    assert(Number.isInteger(result.generations));
    assertGreaterOrEqual(result.generations, 1);
  },
);

Deno.test(
  "evolveResultToMultiRunSample carries error/fitness/topology onto the milestone shape",
  async () => {
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      populationSize: 6,
      errorThreshold: 0,
      timeoutMinutes: 0,
    });
    const sample = evolveResultToMultiRunSample(result);
    assertEquals(sample.runGen, result.generations);
    assertGreaterOrEqual(sample.error, 0);
    assertGreaterOrEqual(1, sample.error);
    assertEquals(sample.bestScore, result.bestFitness);
    assertEquals(sample.neurons, result.champion.neurons.length);
    assertEquals(sample.synapses, result.champion.synapses.length);
    assertEquals(sample.generationWallClockMs, result.wallClockMs);
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

Deno.test({
  name:
    "runMultiRunXor resume flow loads prior creature, appends a milestone, and renders both charts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "xor_resume_" });
    try {
      const slug = EXAMPLE_SLUG;

      // Pre-seed multi-run state with a prior champion + a synthetic
      // milestone so loadMultiRunState reports nextRunIndex=2.
      const priorCreatureExport = buildRandomSeedCreature(12345);
      await appendMultiRunRun(slug, {
        creatureExport: priorCreatureExport,
        newSamples: [{
          runGen: 1,
          error: 0.5,
          bestScore: 0.5,
          neurons: INPUT_COUNT + OUTPUT_COUNT,
          synapses: INPUT_COUNT,
          generationWallClockMs: 100,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      // Drive the multi-run flow with a tiny iterations cap so the test
      // completes in seconds and never depends on wall-clock timing.
      const outcome = await runMultiRunXor({
        argv: [],
        baseDir: tmp,
        evolveOverrides: {
          maxGenerations: 2,
          populationSize: 6,
          errorThreshold: 0,
          timeoutMinutes: 0,
        },
      });

      // Prior champion must have been reloaded as the evolveDir seed.
      assertEquals(outcome.resumed, true);
      assertEquals(outcome.runIndex, 2);

      // Persisted history now contains both the pre-seeded milestone and
      // the new run's milestone, all with monotonic cumulativeGen.
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
  name: "runMultiRunXor --fresh wipes prior artefacts before running",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "xor_fresh_" });
    try {
      const slug = EXAMPLE_SLUG;
      // Pre-seed with a prior run's state.
      await appendMultiRunRun(slug, {
        creatureExport: buildRandomSeedCreature(12345),
        newSamples: [{
          runGen: 1,
          error: 0.5,
          bestScore: 0.5,
          neurons: INPUT_COUNT + OUTPUT_COUNT,
          synapses: INPUT_COUNT,
          generationWallClockMs: 100,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      const outcome = await runMultiRunXor({
        argv: ["--fresh"],
        baseDir: tmp,
        evolveOverrides: {
          maxGenerations: 2,
          populationSize: 6,
          errorThreshold: 0,
          timeoutMinutes: 0,
        },
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
  name: "runMultiRunXor honours --target-error override via the persisted milestone",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "xor_overrides_" });
    try {
      // A trivial target (0.9) means evolveDir's early-exit threshold is
      // already satisfied by the random seed, so the run completes
      // almost immediately. We assert the milestone's error sits at or
      // under that threshold to confirm the override flowed through.
      const outcome = await runMultiRunXor({
        argv: ["--target-error=0.9"],
        baseDir: tmp,
        evolveOverrides: {
          maxGenerations: 2,
          populationSize: 6,
          // Test skips the wall-clock backstop — the override path is
          // covered by the dedicated `timeoutMinutes` test above.
          timeoutMinutes: 0,
        },
      });
      // bestError must be a finite number in [0, 1] and ≤ the override.
      const err = outcome.evolveResult.bestError;
      assert(Number.isFinite(err));
      assertGreaterOrEqual(err, 0);
      assertGreaterOrEqual(0.9, err);
      // The merged history captured exactly one milestone for this run.
      const state = await loadMultiRunState(EXAMPLE_SLUG, tmp);
      assertEquals(state.milestones.length, 1);
      assertEquals(state.milestones[0].runIndex, 1);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
