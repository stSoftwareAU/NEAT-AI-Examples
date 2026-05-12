/**
 * Unit tests for the memetic evolution demo (issues #90, #216, telemetry
 * rewire #303).
 *
 * "What" tests only — every test calls a real function and asserts on
 * observable outputs (record structure, summary statistics, SVG
 * structure). No greps over source files.
 *
 * Note: under #303 the previous analytical `runMemeticEvolution`
 * (fixed-topology weight-vector simulation), all per-generation
 * `EvolutionRow` helpers, the chunked `evolveDir` loop, and the per-
 * generation fitness / topology SVGs were removed. The headline
 * narrative is now expressed through two milestone summaries captured
 * from {@link runMemeticAndControlEvolution}. The previous analytical
 * tests are dropped accordingly.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Creature } from "@stsoftware/neat-ai";

import {
  creatureHeldOutScore,
  DEFAULT_MEMETIC_EVOLUTION_CONFIG,
  fitnessOn,
  forward,
  generateDataset,
  INPUT_COUNT,
  type MemeticEvolutionConfig,
  OUTPUT_COUNT,
  runMemeticAndControlEvolution,
  TARGET_WEIGHTS,
  WEIGHT_VECTOR_LENGTH,
  writeBinaryDataset,
} from "./memetic_evolution.ts";
import {
  CONTROL_COLUMN_CLASS,
  MEMETIC_COLUMN_CLASS,
  MILESTONE_PANEL_CLASS,
  renderMemeticSVG,
  SEEDING_ANNOTATION_CLASS,
} from "./svg.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

Deno.test("TARGET_WEIGHTS has the expected length", () => {
  assertEquals(TARGET_WEIGHTS.length, WEIGHT_VECTOR_LENGTH);
  for (const w of TARGET_WEIGHTS) {
    assert(Number.isFinite(w), `target weights must all be finite, got ${w}`);
  }
});

Deno.test("forward returns finite outputs in [0, 1]", () => {
  const rng = createDeterministicRandom(123);
  for (let i = 0; i < 20; i++) {
    const x0 = rng() * 4 - 2;
    const x1 = rng() * 4 - 2;
    const y = forward(TARGET_WEIGHTS, [x0, x1]);
    assert(Number.isFinite(y), `forward output must be finite, got ${y}`);
    assertGreaterOrEqual(y, 0);
    assertGreaterOrEqual(1, y);
  }
});

Deno.test("forward rejects weight vectors of the wrong length", () => {
  assertThrows(() => forward([0, 0, 0], [0, 0]));
});

Deno.test("generateDataset returns the requested number of records", () => {
  const data = generateDataset(42, 25);
  assertEquals(data.length, 25);
  for (const r of data) {
    assertEquals(r.inputs.length, 2);
    assert(Number.isFinite(r.inputs[0]));
    assert(Number.isFinite(r.inputs[1]));
    assert(Number.isFinite(r.output));
    assertGreaterOrEqual(r.output, 0);
    assertGreaterOrEqual(1, r.output);
  }
});

Deno.test("generateDataset is deterministic for the same seed", () => {
  const a = generateDataset(7, 16);
  const b = generateDataset(7, 16);
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEquals(a[i].inputs[0], b[i].inputs[0]);
    assertEquals(a[i].inputs[1], b[i].inputs[1]);
    assertEquals(a[i].output, b[i].output);
  }
});

Deno.test("generateDataset rejects a non-positive size", () => {
  assertThrows(() => generateDataset(1, 0));
});

Deno.test("fitnessOn(target, dataset) is essentially zero (perfect)", () => {
  const data = generateDataset(123, 24);
  const f = fitnessOn(TARGET_WEIGHTS, data);
  assertAlmostEquals(f, 0, 1e-12);
});

Deno.test("fitnessOn punishes wrong weights", () => {
  const data = generateDataset(123, 24);
  const wrong = TARGET_WEIGHTS.map(() => 0);
  const fGood = fitnessOn(TARGET_WEIGHTS, data);
  const fBad = fitnessOn(wrong, data);
  assertGreater(fGood, fBad);
});

Deno.test("writeBinaryDataset emits a Float32 .bin of the expected size", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "memetic_evolution_test_" });
  try {
    const ds = generateDataset(123, 8);
    const path = writeBinaryDataset(ds, tmp);
    const stat = await Deno.stat(path);
    const expectedBytes = ds.length * (INPUT_COUNT + OUTPUT_COUNT) * 4;
    assertEquals(stat.size, expectedBytes);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("INPUT_COUNT and OUTPUT_COUNT match the simulation topology", () => {
  // The minimal seed must use the same I/O shape as the label oracle
  // so the binary `.bin` records line up.
  assertEquals(INPUT_COUNT, 2);
  assertEquals(OUTPUT_COUNT, 1);
});

Deno.test("DEFAULT_MEMETIC_EVOLUTION_CONFIG has audit-policy stop conditions", () => {
  const c = DEFAULT_MEMETIC_EVOLUTION_CONFIG;
  assertEquals(c.timeoutMinutes, 5, "timeoutMinutes must be 5 per issue #216");
  assertGreater(c.targetError, 0);
  assertGreaterOrEqual(0.1, c.targetError);
  assertGreater(c.populationSize, 1);
  assertGreater(c.controlIterations, 0);
  assertGreater(c.memeticPhaseIterations, 0);
});

Deno.test("creatureHeldOutScore returns a finite non-positive value", () => {
  const ds = generateDataset(1, 8);
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const score = creatureHeldOutScore(creature, ds);
  assert(Number.isFinite(score));
  assertGreaterOrEqual(0, score);
});

Deno.test("creatureHeldOutScore empty dataset returns 0", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  assertEquals(creatureHeldOutScore(creature, []), 0);
});

/**
 * Small config used for the milestone-comparison tests — keeps each
 * test fast while still exercising the new code path.
 */
const SMALL_CONFIG: MemeticEvolutionConfig = {
  targetError: 0.5,
  timeoutMinutes: 1,
  populationSize: 6,
  controlIterations: 4,
  memeticPhaseIterations: 2,
  memeticSeed: 216,
  controlSeed: 217,
  mutationRate: 0.6,
  mutationAmount: 3,
};

Deno.test(
  "runMemeticAndControlEvolution returns two milestone summaries from minimal seeds",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "memetic_evolution_test_" });
    try {
      const ds = generateDataset(1, 16);
      writeBinaryDataset(ds, tmp);

      const result = await runMemeticAndControlEvolution(tmp, SMALL_CONFIG);

      // Both phases were captured.
      assertEquals(result.memetic.champion.input, INPUT_COUNT);
      assertEquals(result.memetic.champion.output, OUTPUT_COUNT);
      assertEquals(result.control.champion.input, INPUT_COUNT);
      assertEquals(result.control.champion.output, OUTPUT_COUNT);

      // Each summary's seed counts match a minimal `new Creature(in, out)`.
      const seedNeurons = INPUT_COUNT + OUTPUT_COUNT;
      assertEquals(result.memetic.summary.seedNeurons, seedNeurons);
      assertEquals(result.control.summary.seedNeurons, seedNeurons);

      // Numeric summary fields are finite.
      for (const phase of [result.memetic, result.control]) {
        assert(Number.isFinite(phase.summary.finalError));
        assert(Number.isFinite(phase.summary.finalScore));
        assertGreater(phase.summary.generations, 0);
        assertGreater(phase.summary.finalNeurons, 0);
        assertGreaterOrEqual(phase.summary.finalSynapses, 0);
        assertGreaterOrEqual(phase.wallClockMs, 0);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test("runMemeticAndControlEvolution rejects invalid configs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "memetic_evolution_test_" });
  try {
    const ds = generateDataset(1, 8);
    writeBinaryDataset(ds, tmp);
    await assertRejects(() =>
      runMemeticAndControlEvolution(tmp, { ...SMALL_CONFIG, targetError: 0 })
    );
    await assertRejects(() =>
      runMemeticAndControlEvolution(tmp, { ...SMALL_CONFIG, populationSize: 0 })
    );
    await assertRejects(() =>
      runMemeticAndControlEvolution(tmp, { ...SMALL_CONFIG, timeoutMinutes: 0 })
    );
    await assertRejects(() =>
      runMemeticAndControlEvolution(tmp, { ...SMALL_CONFIG, controlIterations: 0 })
    );
    await assertRejects(() =>
      runMemeticAndControlEvolution(tmp, { ...SMALL_CONFIG, memeticPhaseIterations: 0 })
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test(
  "renderMemeticSVG renders a milestone comparison panel with seeding annotations",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "memetic_evolution_test_" });
    try {
      const ds = generateDataset(1, 16);
      writeBinaryDataset(ds, tmp);
      const result = await runMemeticAndControlEvolution(tmp, SMALL_CONFIG);

      const svg = renderMemeticSVG({
        memetic: result.memetic.summary,
        control: result.control.summary,
        memeticSeedingEvent: "archive seed @ gen 30",
      });

      assert(svg.startsWith("<svg"), "must start with <svg>");
      assert(svg.includes("</svg>"), "must contain </svg>");
      assertStringIncludes(svg, MILESTONE_PANEL_CLASS);
      assertStringIncludes(svg, MEMETIC_COLUMN_CLASS);
      assertStringIncludes(svg, CONTROL_COLUMN_CLASS);
      assertStringIncludes(svg, SEEDING_ANNOTATION_CLASS);
      // Both column headers are present.
      assertStringIncludes(svg, "memetic (with seeding)");
      assertStringIncludes(svg, "control (no seeding)");
      // Numeric callouts for the milestone rows are present.
      assertStringIncludes(svg, "final score");
      assertStringIncludes(svg, "final error");
      assertStringIncludes(svg, "generations");
      // Annotation text appears verbatim.
      assertStringIncludes(svg, "archive seed @ gen 30");
      // Default control annotation also appears.
      assertStringIncludes(svg, "no seeding (control)");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "renderMemeticSVG accepts a custom control seeding annotation",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "memetic_evolution_test_" });
    try {
      const ds = generateDataset(1, 16);
      writeBinaryDataset(ds, tmp);
      const result = await runMemeticAndControlEvolution(tmp, SMALL_CONFIG);

      const svg = renderMemeticSVG({
        memetic: result.memetic.summary,
        control: result.control.summary,
        memeticSeedingEvent: "archive re-seed",
        controlSeedingEvent: "vanilla minimal seed",
      });
      assertStringIncludes(svg, "vanilla minimal seed");
      assertStringIncludes(svg, "archive re-seed");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
