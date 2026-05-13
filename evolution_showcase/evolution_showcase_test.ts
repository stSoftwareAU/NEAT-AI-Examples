/**
 * "What" tests for the evolution_showcase example (audit issue #211,
 * telemetry rewired under #301).
 *
 * The full-length showcase calls `Creature.evolveDir` against the
 * deterministic binary `.bin` training set with `targetError` +
 * `timeoutMinutes: 5` stop conditions; that run is too slow for a unit
 * test. These tests exercise the same code path with a tiny population
 * and a generous `targetError` so each finishes well inside the
 * 120-second per-test budget. They verify the *observable* outputs —
 * the milestone summary is captured, every numeric callout flows into
 * the rendered SVG, and missing-field errors are caught.
 */

import { assert, assertEquals, assertGreater, assertThrows } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  createTeacherCreature,
  DEFAULT_SHOWCASE_EVOLUTION_CONFIG,
  INPUT_COUNT,
  OUTPUT_COUNT,
  prepareDataset,
  runMinimalSeedShowcase,
  SYNTHETIC_CONFIG,
} from "./evolution_showcase.ts";
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";

/* ------------------------------------------------------------------ */
/*  Teacher creature                                                   */
/* ------------------------------------------------------------------ */

Deno.test("createTeacherCreature has the expected I/O width and is non-trivial", () => {
  const teacher = createTeacherCreature();
  assertEquals(teacher.input, INPUT_COUNT);
  assertEquals(teacher.output, OUTPUT_COUNT);
  const hasHidden = teacher.neurons.some((n) => n.type === "hidden");
  assert(hasHidden, "teacher should have at least one hidden neuron");
});

Deno.test("createTeacherCreature produces deterministic output for identical input", () => {
  const t1 = createTeacherCreature();
  const t2 = createTeacherCreature();
  const input = new Float32Array([0.5, -0.3, 0.7, 0.1]);
  t1.clearState();
  t2.clearState();
  const o1 = t1.activate(input);
  const o2 = t2.activate(input);
  assertEquals(o1[0], o2[0], "same input should yield same output");
});

/* ------------------------------------------------------------------ */
/*  prepareDataset                                                     */
/* ------------------------------------------------------------------ */

Deno.test("prepareDataset writes the synthetic .bin file and is idempotent", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_dataset_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    const file = join(dataDir, "synthetic_0000.bin");
    assert(existsSync(file), `expected ${file}`);
    const sizeBefore = Deno.statSync(file).size;
    prepareDataset(dataDir);
    const sizeAfter = Deno.statSync(file).size;
    assertEquals(sizeAfter, sizeBefore, "second call should not regenerate the file");
    const expected = SYNTHETIC_CONFIG.totalRecords * (INPUT_COUNT + OUTPUT_COUNT) * 4;
    assertEquals(sizeBefore, expected, "file size must match the synthetic config");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Stop-condition contract                                             */
/* ------------------------------------------------------------------ */

Deno.test("DEFAULT_SHOWCASE_EVOLUTION_CONFIG honours the audit's stop-condition rule", () => {
  assertGreater(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.targetError,
    0,
    "targetError must be positive",
  );
  assertEquals(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.timeoutMinutes,
    5,
    "timeoutMinutes must default to the issue #211 backstop",
  );
  assertGreater(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.populationSize,
    0,
    "populationSize must be positive",
  );
  assertGreater(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.maxIterations,
    0,
    "maxIterations must be positive",
  );
});

Deno.test("runMinimalSeedShowcase rejects non-positive config values", async () => {
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const dataDir = Deno.makeTempDirSync({ prefix: "showcase_invalid_test_" });
  try {
    let threw = false;
    try {
      await runMinimalSeedShowcase(seed, dataDir, {
        targetError: 0,
        timeoutMinutes: 1,
        populationSize: 4,
        maxIterations: 1,
        seed: 1,
      });
    } catch (err) {
      threw = true;
      assert(err instanceof Error);
    }
    assertEquals(threw, true, "zero targetError must throw");
  } finally {
    Deno.removeSync(dataDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  runMinimalSeedShowcase end-to-end                                  */
/* ------------------------------------------------------------------ */

Deno.test(
  "runMinimalSeedShowcase returns a milestone EvolveDirSummary built from evolveDir's return value",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "showcase_run_test_" });
    try {
      const dataDir = join(tmp, "data");
      ensureDirSync(dataDir);
      prepareDataset(dataDir);

      const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      const seedNeurons = seed.neurons.length;
      const seedSynapses = seed.synapses.length;

      const result = await runMinimalSeedShowcase(seed, dataDir, {
        targetError: 0.5,
        timeoutMinutes: 1,
        populationSize: 6,
        maxIterations: 10,
        seed: 211,
      });

      const s = result.summary;
      assertEquals(s.seedNeurons, seedNeurons, "seed neuron count must be recorded");
      assertEquals(s.seedSynapses, seedSynapses, "seed synapse count must be recorded");
      assert(Number.isFinite(s.finalError));
      assert(Number.isFinite(s.finalScore));
      assert(Number.isFinite(s.wallClockMs));
      assertGreater(s.generations, 0, "generation count must be 1-based");
      assertGreater(s.finalNeurons, 0, "final neuron count must be positive");
      assertGreater(s.finalSynapses, 0, "final synapse count must be positive");
      assertEquals(s.targetError, 0.5);
      assertEquals(s.timeoutMinutes, 1);
      // The champion must be the same JS object the caller passed in —
      // evolveDir mutates the creature in place.
      assertEquals(
        result.champion === seed,
        true,
        "champion must be the in-place creature",
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "runMinimalSeedShowcase milestone summary renders an SVG containing each numeric callout",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "showcase_svg_test_" });
    try {
      const dataDir = join(tmp, "data");
      ensureDirSync(dataDir);
      prepareDataset(dataDir);

      const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      const result = await runMinimalSeedShowcase(seed, dataDir, {
        targetError: 0.5,
        timeoutMinutes: 1,
        populationSize: 6,
        maxIterations: 8,
        seed: 211,
      });
      const svg = renderEvolveDirSummarySvg(result.summary, {
        title: "Evolution Showcase — evolveDir Run Summary",
      });
      assert(svg.startsWith("<svg"));
      assert(svg.includes("</svg>"));
      assert(svg.includes(String(result.summary.generations)));
      assert(svg.includes(String(result.summary.seedNeurons)));
      assert(svg.includes(String(result.summary.seedSynapses)));
      assert(svg.includes(String(result.summary.finalNeurons)));
      assert(svg.includes(String(result.summary.finalSynapses)));
      assert(svg.includes("final error"));
      assert(svg.includes("final score"));
      assert(svg.includes("wall clock"));
      assert(!svg.includes("NaN"));
      assert(!svg.includes("Infinity"));
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "renderEvolveDirSummarySvg rejects a summary with missing numeric fields",
  () => {
    const badSummary = {
      finalError: 0.1,
      finalScore: 0.5,
      wallClockMs: 100,
      generations: 10,
      seedNeurons: 5,
      seedSynapses: 4,
      finalNeurons: Number.NaN,
      finalSynapses: 18,
    } as EvolveDirSummary;
    assertThrows(
      () => renderEvolveDirSummarySvg(badSummary),
      Error,
      "finalNeurons",
    );
  },
);
