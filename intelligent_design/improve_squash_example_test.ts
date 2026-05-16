/**
 * Unit tests for the intelligent design example module.
 *
 * These are "what" tests — they verify that each function produces
 * the correct result (output, side effects, structure) without
 * checking implementation details or timing.
 */

import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";

import { Creature } from "@stsoftware/neat-ai";

import { renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import {
  createReferenceCreature,
  DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG,
  generateSyntheticData,
  INPUT_COUNT,
  OUTPUT_COUNT,
  runMinimalSeedEvolution,
  SYNTHETIC_CONFIG,
} from "./improve_squash_example.ts";

/* ------------------------------------------------------------------ */
/*  createReferenceCreature                                            */
/* ------------------------------------------------------------------ */

Deno.test("createReferenceCreature returns a creature with 4 inputs and 1 output", () => {
  const creature = createReferenceCreature();
  assertEquals(creature.input, 4, "should have 4 inputs");
  assertEquals(creature.output, 1, "should have 1 output");
});

Deno.test("createReferenceCreature returns a creature with 5 hidden neurons", () => {
  const creature = createReferenceCreature();
  const json = creature.exportJSON();
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(hidden.length, 5, "should have 5 hidden neurons");
});

Deno.test("createReferenceCreature produces a valid creature", () => {
  const creature = createReferenceCreature();
  creature.validate();
});

Deno.test("createReferenceCreature produces a creature that generates finite output", () => {
  const creature = createReferenceCreature();
  const input = new Float32Array([0.5, -0.3, 0.7, 0.1]);
  creature.clearState();
  const output = creature.activate(input);

  assertEquals(output.length, 1, "should produce exactly 1 output");
  assertEquals(Number.isFinite(output[0]), true, "output should be finite");
});

Deno.test("createReferenceCreature produces deterministic output", () => {
  const creature1 = createReferenceCreature();
  const creature2 = createReferenceCreature();

  const input = new Float32Array([0.2, 0.8, -0.5, 0.3]);

  creature1.clearState();
  const output1 = creature1.activate(input);

  creature2.clearState();
  const output2 = creature2.activate(input);

  assertEquals(output1[0], output2[0], "same input should yield same output");
});

Deno.test("createReferenceCreature hidden neurons have diverse squash functions", () => {
  const creature = createReferenceCreature();
  const json = creature.exportJSON();
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  const squashes = new Set(hidden.map((n) => n.squash));

  assertGreater(squashes.size, 1, "hidden neurons should use multiple squash functions");
});

Deno.test("createReferenceCreature includes expected synapses", () => {
  const creature = createReferenceCreature();
  const json = creature.exportJSON();

  assertGreater(
    json.synapses.length,
    0,
    "creature should have synapses",
  );
});

/* ------------------------------------------------------------------ */
/*  SYNTHETIC_CONFIG                                                    */
/* ------------------------------------------------------------------ */

Deno.test("SYNTHETIC_CONFIG has expected properties", () => {
  assertGreater(SYNTHETIC_CONFIG.totalRecords, 0, "totalRecords should be positive");
  assertGreater(SYNTHETIC_CONFIG.recordsPerFile, 0, "recordsPerFile should be positive");
  assertGreater(SYNTHETIC_CONFIG.seed, 0, "seed should be positive");
});

/* ------------------------------------------------------------------ */
/*  generateSyntheticData                                              */
/* ------------------------------------------------------------------ */

Deno.test("generateSyntheticData creates a binary data file", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createReferenceCreature();
    const config = { totalRecords: 16, recordsPerFile: 16, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const dataPath = join(dataDir, "synthetic_0000.bin");
    assertEquals(existsSync(dataPath), true, "synthetic_0000.bin should exist");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData creates a file with correct size", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createReferenceCreature();
    const recordCount = 50;
    const config = { totalRecords: recordCount, recordsPerFile: recordCount, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const dataPath = join(dataDir, "synthetic_0000.bin");
    const stat = Deno.statSync(dataPath);

    // records * (4 inputs + 1 output) * 4 bytes per float32
    const expectedSize = recordCount * (creature.input + creature.output) * 4;
    assertEquals(stat.size, expectedSize, "file size should match expected record count");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData produces data that can be scored by the creature", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createReferenceCreature();
    const config = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    // The creature should be able to score against the generated data
    const result = await creature.scoreDir(dataDir, {});
    assertEquals(typeof result.score, "number", "score should be a number");
    assertEquals(Number.isFinite(result.score), true, "score should be finite");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData file contains valid float32 values", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createReferenceCreature();
    const config = { totalRecords: 16, recordsPerFile: 16, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const dataPath = join(dataDir, "synthetic_0000.bin");
    const buffer = Deno.readFileSync(dataPath);
    const view = new DataView(buffer.buffer);

    // Spot-check first record: 4 inputs + 1 output = 5 floats
    const recordFloats = creature.input + creature.output;
    for (let i = 0; i < recordFloats; i++) {
      const value = view.getFloat32(i * 4, true);
      assertEquals(Number.isFinite(value), true, `float at offset ${i} should be finite`);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData is deterministic for the same seed", () => {
  const tmpDir1 = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const tmpDir2 = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir1 = join(tmpDir1, "data");
  const dataDir2 = join(tmpDir2, "data");
  ensureDirSync(dataDir1);
  ensureDirSync(dataDir2);

  try {
    const creature1 = createReferenceCreature();
    const creature2 = createReferenceCreature();

    const config = { totalRecords: 32, recordsPerFile: 32, seed: 42 };
    generateSyntheticData(creature1, dataDir1, config);
    generateSyntheticData(creature2, dataDir2, config);

    const file1 = Deno.readFileSync(join(dataDir1, "synthetic_0000.bin"));
    const file2 = Deno.readFileSync(join(dataDir2, "synthetic_0000.bin"));

    assertEquals(file1, file2, "same seed should produce identical data");
  } finally {
    Deno.removeSync(tmpDir1, { recursive: true });
    Deno.removeSync(tmpDir2, { recursive: true });
  }
});

Deno.test("generateSyntheticData splits records across multiple files", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createReferenceCreature();
    const config = { totalRecords: 16, recordsPerFile: 8, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    assertEquals(existsSync(join(dataDir, "synthetic_0000.bin")), true, "first file should exist");
    assertEquals(
      existsSync(join(dataDir, "synthetic_0001.bin")),
      true,
      "second file should exist",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Audit (#214) — minimal-seed evolution + milestone summary (#302)   */
/* ------------------------------------------------------------------ */

Deno.test("INPUT_COUNT and OUTPUT_COUNT are positive integers matching the runner seed", () => {
  assertGreater(INPUT_COUNT, 0, "INPUT_COUNT must be positive");
  assertGreater(OUTPUT_COUNT, 0, "OUTPUT_COUNT must be positive");
  assertEquals(Number.isInteger(INPUT_COUNT), true, "INPUT_COUNT must be an integer");
  assertEquals(Number.isInteger(OUTPUT_COUNT), true, "OUTPUT_COUNT must be an integer");

  // The minimal seed must have exactly INPUT_COUNT + OUTPUT_COUNT
  // neurons and INPUT_COUNT * OUTPUT_COUNT synapses (full bipartite).
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  assertEquals(seed.neurons.length, INPUT_COUNT + OUTPUT_COUNT);
  assertEquals(seed.synapses.length, INPUT_COUNT * OUTPUT_COUNT);
});

Deno.test("DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG honours the audit's stop-condition rule", () => {
  assertGreater(
    DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG.targetError,
    0,
    "targetError must be positive",
  );
  // Issue #378: the original audit (#214) mandated a 5-minute backstop;
  // the Refresh-2026-05 milestone grants +15 minutes of additional
  // evolution budget, so we assert `>= 5` rather than `=== 5`.
  assertGreaterOrEqual(
    DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG.timeoutMinutes,
    5,
    "timeoutMinutes must default to at least the issue #214 backstop (issue #378 allows raising)",
  );
  assertGreater(
    DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG.populationSize,
    0,
    "populationSize must be positive",
  );
  assertGreater(
    DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG.maxIterations,
    0,
    "maxIterations must be positive",
  );
});

Deno.test("runMinimalSeedEvolution rejects non-positive config values", async () => {
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const dataDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  try {
    let threw = false;
    try {
      await runMinimalSeedEvolution(seed, dataDir, {
        targetError: 0,
        timeoutMinutes: 0,
        populationSize: 4,
        maxIterations: 1,
        mutationRate: 0.6,
        mutationAmount: 3,
        seed: 1,
      });
    } catch (err) {
      threw = true;
      assertEquals(err instanceof Error, true);
    }
    assertEquals(threw, true, "zero targetError must throw");
  } finally {
    Deno.removeSync(dataDir, { recursive: true });
  }
});

Deno.test(
  "runMinimalSeedEvolution returns a milestone summary from a minimal seed",
  async () => {
    const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
    const dataDir = join(tmpDir, "data");
    ensureDirSync(dataDir);
    try {
      const reference = createReferenceCreature();
      generateSyntheticData(reference, dataDir, {
        totalRecords: 64,
        recordsPerFile: 64,
        seed: 42,
      });

      const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      const seedNeurons = seed.neurons.length;
      const seedSynapses = seed.synapses.length;

      const result = await runMinimalSeedEvolution(seed, dataDir, {
        targetError: 0.001,
        timeoutMinutes: 0, // Suppress NEAT-AI's GPU/discovery FFI cleanup
        populationSize: 8,
        maxIterations: 30,
        mutationRate: 0.6,
        mutationAmount: 3,
        seed: 214,
      });

      assertEquals(result.seedNeuronCount, seedNeurons, "seed neuron count must be recorded");
      assertEquals(result.seedSynapseCount, seedSynapses, "seed synapse count must be recorded");
      assertGreater(result.generations, 0, "should evolve at least one generation");

      // Summary contract — all numeric fields finite.
      assertEquals(Number.isFinite(result.summary.finalError), true);
      assertEquals(Number.isFinite(result.summary.finalScore), true);
      assertEquals(result.summary.seedNeurons, seedNeurons);
      assertEquals(result.summary.seedSynapses, seedSynapses);
      assertGreater(result.summary.finalNeurons, 0, "final neuron count must be positive");
      assertGreater(result.summary.finalSynapses, 0, "final synapse count must be positive");
    } finally {
      Deno.removeSync(tmpDir, { recursive: true });
    }
  },
);

Deno.test("runMinimalSeedEvolution leaves the passed-in creature as the champion", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);
  try {
    const reference = createReferenceCreature();
    generateSyntheticData(reference, dataDir, {
      totalRecords: 32,
      recordsPerFile: 32,
      seed: 99,
    });

    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const result = await runMinimalSeedEvolution(seed, dataDir, {
      targetError: 0.001,
      timeoutMinutes: 0, // Suppress NEAT-AI's GPU/discovery FFI cleanup
      populationSize: 4,
      maxIterations: 4,
      mutationRate: 0.6,
      mutationAmount: 3,
      seed: 11,
    });
    // The champion must be the same JS object the caller passed in —
    // evolveDir mutates the creature in place.
    assertEquals(result.champion === seed, true, "champion must be the in-place creature");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Milestone summary SVG                                              */
/* ------------------------------------------------------------------ */

Deno.test("renderEvolveDirSummarySvg renders a summary derived from runMinimalSeedEvolution", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_id_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);
  try {
    const reference = createReferenceCreature();
    generateSyntheticData(reference, dataDir, {
      totalRecords: 32,
      recordsPerFile: 32,
      seed: 99,
    });

    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const result = await runMinimalSeedEvolution(seed, dataDir, {
      targetError: 0.5,
      timeoutMinutes: 0,
      populationSize: 4,
      maxIterations: 3,
      mutationRate: 0.6,
      mutationAmount: 3,
      seed: 11,
    });

    const svg = renderEvolveDirSummarySvg(result.summary, {
      title: "Intelligent Design — evolveDir Run Summary",
    });
    assert(svg.startsWith("<svg"));
    assert(svg.includes("</svg>"));
    // Numeric callouts for the four summary rows are present.
    assert(svg.includes("final error"));
    assert(svg.includes("final score"));
    assert(svg.includes("generations"));
    assert(svg.includes("wall clock"));
    // Topology counts appear as bar labels.
    assert(svg.includes(String(result.summary.seedNeurons)));
    assert(svg.includes(String(result.summary.finalNeurons)));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
