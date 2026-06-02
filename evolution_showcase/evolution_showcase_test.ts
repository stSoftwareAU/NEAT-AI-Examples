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

import {
  assert,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertThrows,
} from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  buildRandomSeedCreature,
  buildSeedCreature,
  createTeacherCreature,
  DEFAULT_SHOWCASE_EVOLUTION_CONFIG,
  INPUT_COUNT,
  OUTPUT_COUNT,
  prepareDataset,
  readTrainingRecords,
  REGRESSION_COST,
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
/*  Factory records + seed builders (issue #534)                        */
/* ------------------------------------------------------------------ */

Deno.test("REGRESSION_COST is the MSE regression cost", () => {
  assertEquals(REGRESSION_COST, "MSE");
});

Deno.test("readTrainingRecords reads the .bin set into well-shaped factory records", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_records_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);

    const records = readTrainingRecords(dataDir);
    assertEquals(records.length, SYNTHETIC_CONFIG.totalRecords, "one record per synthesised row");
    for (const r of records) {
      assertEquals(r.input.length, INPUT_COUNT, "each record has INPUT_COUNT inputs");
      assertEquals(r.output.length, OUTPUT_COUNT, "each record has OUTPUT_COUNT outputs");
      assert(Number.isFinite(r.input[0]));
      assert(Number.isFinite(r.output[0]));
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("readTrainingRecords throws when the directory holds no .bin files", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_records_empty_test_" });
  try {
    assertThrows(() => readTrainingRecords(tmp), Error, "no .bin records");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("buildRandomSeedCreature is the bare baseline — INPUT_COUNT in, 0 hidden, OUTPUT_COUNT out", () => {
  const json = buildRandomSeedCreature(86);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(
    hidden.length,
    0,
    "bare baseline must have zero hidden neurons — NEAT must invent them",
  );
});

Deno.test("buildRandomSeedCreature is deterministic for a given seed", () => {
  const a = buildRandomSeedCreature(4242);
  const b = buildRandomSeedCreature(4242);
  assertEquals(JSON.stringify(a), JSON.stringify(b), "same seed ⇒ identical seed creature");
});

Deno.test("buildRandomSeedCreature produces a valid creature with finite output", () => {
  const creature = Creature.fromJSON(buildRandomSeedCreature(86));
  creature.validate();
  creature.clearState();
  const out = creature.activate(new Float32Array([0.5, -0.3, 0.7, 0.1]));
  assertEquals(out.length, OUTPUT_COUNT);
  assert(Number.isFinite(out[0]), "baseline output must be finite");
});

Deno.test("buildSeedCreature builds a factory seed with the right I/O arity", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_factory_arity_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    const json = buildSeedCreature(readTrainingRecords(dataDir), 86);
    assertEquals(json.input, INPUT_COUNT);
    assertEquals(json.output, OUTPUT_COUNT);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("buildSeedCreature picks a linear IDENTITY output from the regression cost", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_factory_output_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    const json = buildSeedCreature(readTrainingRecords(dataDir), 5);
    for (const out of json.neurons.filter((n) => n.type === "output")) {
      assertEquals(out.squash, "IDENTITY", "regression cost ⇒ linear IDENTITY output");
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("buildSeedCreature sizes a data-derived hidden capacity budget", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_factory_hidden_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    // Unlike the bare baseline (zero hidden), the factory pre-sizes a
    // conservative hidden layer from the problem shape (Heaton's rule).
    const json = buildSeedCreature(readTrainingRecords(dataDir), 7);
    const hidden = json.neurons.filter((n) => n.type === "hidden");
    assertGreater(hidden.length, 0, "factory seed must pre-size a hidden layer");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("buildSeedCreature is deterministic for a given seed", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_factory_det_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    const records = readTrainingRecords(dataDir);
    // The factory mints fresh UUIDs for hidden neurons, so fingerprint
    // on the structurally meaningful fields rather than the full JSON.
    const fingerprint = (json: ReturnType<typeof buildSeedCreature>) => ({
      neurons: json.neurons.map((n) => `${n.type}:${n.squash}:${n.bias}`),
      synapses: json.synapses.map((s) => s.weight),
    });
    const a = fingerprint(buildSeedCreature(records, 4242));
    const b = fingerprint(buildSeedCreature(records, 4242));
    const c = fingerprint(buildSeedCreature(records, 9999));
    assertEquals(a, b, "same seed ⇒ identical factory seed");
    assert(JSON.stringify(a) !== JSON.stringify(c), "different seed ⇒ different weights/biases");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("buildSeedCreature produces a valid creature with finite output", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_factory_valid_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    const creature = Creature.fromJSON(buildSeedCreature(readTrainingRecords(dataDir), 86));
    creature.validate();
    creature.clearState();
    const out = creature.activate(new Float32Array([0.5, -0.3, 0.7, 0.1]));
    assertEquals(out.length, OUTPUT_COUNT);
    assert(Number.isFinite(out[0]), "factory seed output must be finite");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("buildSeedCreature rejects an empty record set", () => {
  assertThrows(() => buildSeedCreature([], 1), Error, "must not be empty");
});

Deno.test("the factory seed adds structure over the retained bare baseline", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_factory_vs_bare_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    const bare = buildRandomSeedCreature(211);
    const factory = buildSeedCreature(readTrainingRecords(dataDir), 211);
    const bareHidden = bare.neurons.filter((n) => n.type === "hidden").length;
    const factoryHidden = factory.neurons.filter((n) => n.type === "hidden").length;
    assertEquals(bareHidden, 0, "baseline is hidden-less");
    assertGreater(factoryHidden, bareHidden, "factory seed pre-sizes hidden capacity");
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
  // Issue #211 mandates a wall-clock backstop; the specific value is
  // per-example. Issue #377 (Refresh-2026-05) raised this example's
  // backstop from 5 → 20 minutes to grant the +15 minutes of additional
  // evolution requested by the refresh milestone, so the contract here
  // is a lower-bound check rather than an exact match.
  assertGreaterOrEqual(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.timeoutMinutes,
    5,
    "timeoutMinutes must satisfy the issue #211 backstop lower bound (≥5)",
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
