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
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  BIAS_COUNT,
  buildInitialCreatureJSON,
  correctCount,
  DECISION_BOUNDARY_GRID,
  DEFAULT_EVOLVE_OPTIONS,
  evolveXorController,
  genesFromCreatureJSON,
  meanSquaredError,
  mutateCreatureJSON,
  predict,
  randomCreatureJSON,
  WEIGHT_COUNT,
  xorSamples,
} from "./xor_classification.ts";
import { renderDecisionBoundarySVG, shadeColour } from "./svg.ts";

Deno.test("xorSamples returns the four canonical truth-table rows", () => {
  const samples = xorSamples();
  assertEquals(samples.length, 4);
  assertEquals(samples[0], { inputs: [0, 0], target: 0 });
  assertEquals(samples[1], { inputs: [0, 1], target: 1 });
  assertEquals(samples[2], { inputs: [1, 0], target: 1 });
  assertEquals(samples[3], { inputs: [1, 1], target: 0 });
});

Deno.test("buildInitialCreatureJSON has 2 inputs, 2 hidden, 1 output", () => {
  const weights = new Array(WEIGHT_COUNT).fill(0.1);
  const biases = new Array(BIAS_COUNT).fill(0.0);
  const json = buildInitialCreatureJSON(weights, biases);
  assertEquals(json.input, 2);
  assertEquals(json.output, 1);
  assertEquals(json.synapses.length, WEIGHT_COUNT);
  // Two hidden neurons by topology.
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(hidden.length, 2);
});

Deno.test("buildInitialCreatureJSON produces a valid creature", () => {
  const weights = new Array(WEIGHT_COUNT).fill(0.1);
  const biases = new Array(BIAS_COUNT).fill(0.0);
  const json = buildInitialCreatureJSON(weights, biases);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("buildInitialCreatureJSON throws on wrong-sized gene vectors", () => {
  let threw = false;
  try {
    buildInitialCreatureJSON([1, 2, 3], [0, 0, 0]);
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for too-few weights");

  threw = false;
  try {
    buildInitialCreatureJSON(new Array(WEIGHT_COUNT).fill(0), [0, 0]);
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for too-few biases");
});

Deno.test("genesFromCreatureJSON round-trips weights and biases", () => {
  const weights = [0.11, -0.22, 0.33, -0.44, 0.55, -0.66];
  const biases = [0.7, -0.8, 0.9];
  const json = buildInitialCreatureJSON(weights, biases);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights, weights);
  assertEquals(genes.biases, biases);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const r1 = createDeterministicRandom(99);
  const r2 = createDeterministicRandom(99);
  assertEquals(randomCreatureJSON(r1), randomCreatureJSON(r2));
});

Deno.test("mutateCreatureJSON yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const parent = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0),
    new Array(BIAS_COUNT).fill(0),
  );
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  const creature = Creature.fromJSON(asCreatureExport(child));
  creature.validate();
});

Deno.test("predict returns a number in [0, 1] for a valid creature", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.5),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  for (const { inputs } of xorSamples()) {
    const out = predict(creature, inputs);
    assert(Number.isFinite(out), `output must be finite, got ${out}`);
    assertGreaterOrEqual(out, 0);
    assertGreaterOrEqual(1, out);
  }
});

Deno.test("meanSquaredError is in [0, 1] and zero-weight network is near 0.25", () => {
  // With all weights and biases at zero, the LOGISTIC output is 0.5
  // so the squared error per sample is 0.25 and the MSE is 0.25.
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const mse = meanSquaredError(creature);
  assert(Number.isFinite(mse));
  assertGreaterOrEqual(mse, 0);
  assertGreaterOrEqual(1, mse);
  // Very loose bound — just confirms the metric is sane for the
  // degenerate case.
  assertGreater(0.5, mse);
});

Deno.test("correctCount returns 0..4", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const c = correctCount(creature);
  assertGreaterOrEqual(c, 0);
  assertGreaterOrEqual(4, c);
});

Deno.test(
  "evolveXorController solves XOR with the default budget (happy path)",
  async () => {
    const result = evolveXorController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion to solve XOR, got error=${result.bestError} ` +
        `after ${result.generations} generations`,
    );
    assertEquals(correctCount(result.champion), 4);
    assertGreater(DEFAULT_EVOLVE_OPTIONS.errorThreshold, result.bestError - 1e-9);

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
  "evolveXorController still produces a champion when the budget is exhausted (edge case)",
  () => {
    // A two-generation budget is far too small to converge, but the
    // function must still return a usable champion creature so callers
    // can inspect it / save it.
    const result = evolveXorController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 2,
      populationSize: 6,
      errorThreshold: 0, // unreachable in two generations
    });
    assertEquals(result.solved, false);
    assertEquals(result.generations, 2);
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
  // Endpoints must differ — sanity check the ramp is non-trivial.
  assert(shadeColour(0) !== shadeColour(1), "ramp endpoints must differ");
});

Deno.test("renderDecisionBoundarySVG produces a well-formed SVG with all four samples", () => {
  // Use a tiny dummy creature; the test only cares about SVG structure.
  const json = buildInitialCreatureJSON(
    [1, -1, -1, 1, 1, -1],
    [-0.5, -0.5, 0],
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: 8,
    samples: xorSamples(),
  });
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  // Width and height attributes must exist with positive numeric values.
  const widthMatch = svg.match(/width="(\d+)"/);
  const heightMatch = svg.match(/height="(\d+)"/);
  assert(widthMatch, "SVG must declare a width");
  assert(heightMatch, "SVG must declare a height");
  assertGreater(Number.parseInt(widthMatch![1], 10), 0);
  assertGreater(Number.parseInt(heightMatch![1], 10), 0);

  // One <g class="sample" ...> per XOR sample.
  const matches = svg.match(/<g class="sample"/g) ?? [];
  assertEquals(matches.length, 4);

  // Each labelled point's coordinate text must appear.
  for (const { inputs, target } of xorSamples()) {
    assert(
      svg.includes(`(${inputs[0]},${inputs[1]})→${target}`),
      `expected label for sample (${inputs[0]},${inputs[1]})→${target}`,
    );
  }
});

Deno.test("renderDecisionBoundarySVG honours the requested grid resolution", () => {
  const json = buildInitialCreatureJSON(
    [1, -1, -1, 1, 1, -1],
    [0, 0, 0],
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const grid = 6;
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: grid,
    samples: xorSamples(),
  });
  // Cells live inside <g class="grid">. Count the <rect ... fill="#... "/>
  // entries that sit between <g class="grid"> and its closing tag.
  const start = svg.indexOf('<g class="grid">');
  const end = svg.indexOf("</g>", start);
  assertGreater(end, start);
  const gridSection = svg.slice(start, end);
  const cellRects = gridSection.match(/<rect /g) ?? [];
  assertEquals(cellRects.length, grid * grid);
});

Deno.test("renderDecisionBoundarySVG throws on grid resolution < 2", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  let threw = false;
  try {
    renderDecisionBoundarySVG(creature, { gridResolution: 1, samples: xorSamples() });
  } catch (_err) {
    threw = true;
  }
  assert(threw, "expected an error for tiny grid resolution");
});

Deno.test("renderDecisionBoundarySVG embeds SMIL pulse animations on each sample", () => {
  // Issue #70: each XOR sample now carries SMIL `<animate>` elements
  // that pulse the marker so the screenshot is no longer static.
  const json = buildInitialCreatureJSON(
    [1, -1, -1, 1, 1, -1],
    [-0.5, -0.5, 0],
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: 8,
    samples: xorSamples(),
  });
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Each of the four samples adds at least two animate elements
  // (radius pulse + outer ring fade), giving 8 minimum.
  assertGreaterOrEqual(animateMatches.length, 8);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
  // Each sample must carry a "pulse" outer ring.
  const pulseMatches = svg.match(/class="pulse"/g) ?? [];
  assertEquals(pulseMatches.length, 4);
});

Deno.test("renderDecisionBoundarySVG output uses the canonical screenshot resolution", () => {
  const json = buildInitialCreatureJSON(
    [1, -1, -1, 1, 1, -1],
    [0, 0, 0],
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  // DECISION_BOUNDARY_GRID is the resolution the runner uses for the
  // committed SVG. Sanity-check the cell count matches.
  const start = svg.indexOf('<g class="grid">');
  const end = svg.indexOf("</g>", start);
  const cellRects = svg.slice(start, end).match(/<rect /g) ?? [];
  assertEquals(cellRects.length, DECISION_BOUNDARY_GRID * DECISION_BOUNDARY_GRID);
});
