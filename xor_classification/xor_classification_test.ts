/**
 * Unit tests for the XOR classification example. "What" tests only —
 * each test calls a real function and asserts on observable outputs
 * (predictions, fitness, file contents, SVG structure).
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import {
  buildMinimalSeedCreature,
  correctCount,
  DECISION_BOUNDARY_GRID,
  DEFAULT_EVOLVE_OPTIONS,
  evolveXorController,
  type GenerationInfo,
  INPUT_COUNT,
  meanSquaredError,
  OUTPUT_COUNT,
  planSegments,
  predict,
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

Deno.test("buildMinimalSeedCreature has 2 inputs, 0 hidden, 1 output", () => {
  const json = buildMinimalSeedCreature();
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  // Three neurons total: two inputs + one output, no hidden.
  assertEquals(json.neurons.length, 3);
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(
    hidden.length,
    0,
    "minimal seed must have zero hidden neurons — NEAT must invent them",
  );
});

Deno.test("buildMinimalSeedCreature produces a valid creature", () => {
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
  creature.validate();
  assertEquals(creature.input, INPUT_COUNT);
  assertEquals(creature.output, OUTPUT_COUNT);
  // Activating the seed must produce a finite output.
  for (const { inputs } of xorSamples()) {
    const out = predict(creature, inputs);
    assert(Number.isFinite(out));
  }
});

Deno.test("predict returns a number in [0, 1] for the seed creature", () => {
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
  for (const { inputs } of xorSamples()) {
    const out = predict(creature, inputs);
    assert(Number.isFinite(out), `output must be finite, got ${out}`);
    assertGreaterOrEqual(out, 0);
    assertGreaterOrEqual(1, out);
  }
});

Deno.test("meanSquaredError is in [0, 1] and seed is around 0.25", () => {
  // The minimal seed has zero weights and zero output bias, so the
  // LOGISTIC output is 0.5 and the squared error per sample is 0.25.
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
  const mse = meanSquaredError(creature);
  assert(Number.isFinite(mse));
  assertGreaterOrEqual(mse, 0);
  assertGreaterOrEqual(1, mse);
  assertGreater(0.5, mse);
});

Deno.test("correctCount returns 0..4", () => {
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
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
    // room to invent a hidden neuron and solve XOR.
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      populationSize: 30,
      maxGenerations: 200,
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
    // grown the topology beyond the seed.
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
  "evolveXorController emits GenerationInfo whose seed reflects the minimal topology",
  async () => {
    const samples: GenerationInfo[] = [];
    await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      populationSize: 6,
      errorThreshold: 0, // unreachable in three generations
      onGeneration: (info) => samples.push(info),
    });
    assertGreater(samples.length, 0);
    for (const s of samples) {
      assertEquals(typeof s.neurons, "number");
      assertEquals(typeof s.synapses, "number");
      assertEquals(Number.isInteger(s.neurons), true);
      assertEquals(Number.isInteger(s.synapses), true);
      assertGreater(s.neurons, 0);
      assertGreater(s.synapses, 0);
    }
    // The first reported generation reflects the minimal seed: 3 neurons
    // (2 input + 1 output) and 2 direct input → output synapses. NEAT may
    // grow the topology in subsequent segments.
    assertEquals(samples[0].neurons, 3);
    assertEquals(samples[0].synapses, 2);
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
  "evolveXorController still produces a champion when the budget is exhausted (edge case)",
  async () => {
    const result = await evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 2,
      populationSize: 6,
      errorThreshold: 0, // unreachable in two generations
    });
    assertEquals(result.solved, false);
    assertGreaterOrEqual(result.generations, 1);
    // Champion is a real Creature that activates without throwing.
    const out = predict(result.champion, [0, 1]);
    assert(Number.isFinite(out), `champion output must be finite, got ${out}`);
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
  // Use the minimal seed; the test only cares about SVG structure.
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
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
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
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
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
  let threw = false;
  try {
    renderDecisionBoundarySVG(creature, { gridResolution: 1, samples: xorSamples() });
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for tiny grid resolution");
});

Deno.test("renderDecisionBoundarySVG embeds SMIL pulse animations on each sample", () => {
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
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

Deno.test("renderDecisionBoundarySVG output uses the canonical screenshot resolution", () => {
  const creature = Creature.fromJSON(asCreatureExport(buildMinimalSeedCreature()));
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  const start = svg.indexOf('<g class="grid">');
  const end = svg.indexOf("</g>", start);
  const cellRects = svg.slice(start, end).match(/<rect /g) ?? [];
  assertEquals(cellRects.length, DECISION_BOUNDARY_GRID * DECISION_BOUNDARY_GRID);
});
