/**
 * Unit tests for the discovery example module.
 *
 * These are "what" tests — they verify that each function produces
 * the correct result (output, side effects, structure) without
 * checking implementation details or timing.
 */

import { assertEquals, assertGreater, assertNotEquals, assertThrows } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  createCrippledCreature,
  createDeterministicRandom,
  createReferenceCreature,
  generateSyntheticData,
  SYNTHETIC_CONFIG,
} from "./discover_missing_neuron.ts";

/* ------------------------------------------------------------------ */
/*  createDeterministicRandom                                          */
/* ------------------------------------------------------------------ */

Deno.test("createDeterministicRandom produces values between 0 and 1", () => {
  const rng = createDeterministicRandom(42);
  for (let i = 0; i < 100; i++) {
    const value = rng();
    assertGreater(value, -Number.EPSILON, "value should be >= 0");
    assertGreater(1 + Number.EPSILON, value, "value should be < 1");
  }
});

Deno.test("createDeterministicRandom is deterministic for the same seed", () => {
  const rng1 = createDeterministicRandom(42);
  const rng2 = createDeterministicRandom(42);

  for (let i = 0; i < 50; i++) {
    assertEquals(rng1(), rng2(), `mismatch at iteration ${i}`);
  }
});

Deno.test("createDeterministicRandom differs for different seeds", () => {
  const rng1 = createDeterministicRandom(42);
  const rng2 = createDeterministicRandom(99);

  // Collect sequences and verify they diverge
  let allSame = true;
  for (let i = 0; i < 20; i++) {
    if (rng1() !== rng2()) {
      allSame = false;
      break;
    }
  }
  assertEquals(allSame, false, "different seeds should produce different sequences");
});

/* ------------------------------------------------------------------ */
/*  createReferenceCreature                                            */
/* ------------------------------------------------------------------ */

Deno.test("createReferenceCreature returns a valid creature definition", () => {
  const json = createReferenceCreature();

  assertEquals(json.input, 4, "should have 4 inputs");
  assertEquals(json.output, 1, "should have 1 output");

  const inputs = json.neurons.filter((n) => n.type === "input");
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  const outputs = json.neurons.filter((n) => n.type === "output");

  assertEquals(inputs.length, 4, "should have 4 input neurons");
  assertEquals(hidden.length, 4, "should have 4 hidden neurons");
  assertEquals(outputs.length, 1, "should have 1 output neuron");
});

Deno.test("createReferenceCreature produces a creature that can be instantiated and validated", () => {
  const json = createReferenceCreature();
  const creature = Creature.fromJSON(json);
  creature.validate();

  assertEquals(creature.input, 4);
  assertEquals(creature.output, 1);
});

Deno.test("createReferenceCreature produces a creature that generates output from input", () => {
  const json = createReferenceCreature();
  const creature = Creature.fromJSON(json);

  const input = new Float32Array([0.5, -0.3, 0.7, 0.1]);
  creature.clearState();
  const output = creature.activate(input);

  assertEquals(output.length, 1, "should produce exactly 1 output");
  assertEquals(typeof output[0], "number", "output should be a number");
  assertEquals(Number.isFinite(output[0]), true, "output should be finite");
});

Deno.test("createReferenceCreature produces deterministic output for identical input", () => {
  const json = createReferenceCreature();
  const creature1 = Creature.fromJSON(json);
  const creature2 = Creature.fromJSON(json);

  const input = new Float32Array([0.5, -0.3, 0.7, 0.1]);

  creature1.clearState();
  const output1 = creature1.activate(input);

  creature2.clearState();
  const output2 = creature2.activate(input);

  assertEquals(output1[0], output2[0], "same input should yield same output");
});

/* ------------------------------------------------------------------ */
/*  createCrippledCreature                                             */
/* ------------------------------------------------------------------ */

Deno.test("createCrippledCreature removes the target neuron", () => {
  const baseline = createReferenceCreature();
  const crippled = createCrippledCreature(baseline, "hidden-1");
  const crippledJSON = crippled.exportJSON();

  const uuids = crippledJSON.neurons.map((n) => n.uuid);
  assertEquals(
    uuids.includes("hidden-1"),
    false,
    "hidden-1 should be removed from crippled creature",
  );
});

Deno.test("createCrippledCreature produces a valid creature with fewer neurons", () => {
  const baseline = createReferenceCreature();
  const baselineCreature = Creature.fromJSON(baseline);
  const baselineNeuronCount = baselineCreature.neurons.length;

  const crippled = createCrippledCreature(baseline, "hidden-1");
  crippled.validate();

  assertEquals(
    crippled.neurons.length,
    baselineNeuronCount - 1,
    "crippled creature should have one fewer neuron",
  );
});

Deno.test("createCrippledCreature removes synapses connected to the target neuron", () => {
  const baseline = createReferenceCreature();
  const crippled = createCrippledCreature(baseline, "hidden-1");
  const crippledJSON = crippled.exportJSON();

  // The target neuron was at index 5 in baseline; after removal, no
  // synapse should reference the old index 5 in the *new* index scheme.
  // More importantly, we verify the creature validates (no dangling refs).
  crippled.validate();

  // Crippled creature should have fewer synapses than the baseline
  assertGreater(
    baseline.synapses.length,
    crippledJSON.synapses.length,
    "crippled creature should have fewer synapses",
  );
});

Deno.test("createCrippledCreature throws for unknown neuron UUID", () => {
  const baseline = createReferenceCreature();
  assertThrows(
    () => createCrippledCreature(baseline, "does-not-exist"),
    Error,
    "not found",
  );
});

Deno.test("createCrippledCreature produces a creature that still activates", () => {
  const baseline = createReferenceCreature();
  const crippled = createCrippledCreature(baseline, "hidden-1");

  const input = new Float32Array([0.5, -0.3, 0.7, 0.1]);
  crippled.clearState();
  const output = crippled.activate(input);

  assertEquals(output.length, 1, "crippled creature should still produce output");
  assertEquals(Number.isFinite(output[0]), true, "output should be finite");
});

Deno.test("createCrippledCreature produces different output than baseline", () => {
  const baseline = createReferenceCreature();
  const baselineCreature = Creature.fromJSON(baseline);
  const crippled = createCrippledCreature(baseline, "hidden-1");

  const input = new Float32Array([0.5, -0.3, 0.7, 0.1]);

  baselineCreature.clearState();
  const baselineOutput = baselineCreature.activate(input);

  crippled.clearState();
  const crippledOutput = crippled.activate(input);

  assertNotEquals(
    baselineOutput[0],
    crippledOutput[0],
    "removing a neuron should change the output",
  );
});

/* ------------------------------------------------------------------ */
/*  generateSyntheticData                                              */
/* ------------------------------------------------------------------ */

Deno.test("generateSyntheticData creates binary files in the target directory", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const json = createReferenceCreature();
    const creature = Creature.fromJSON(json);

    const config = { totalRecords: 16, recordsPerFile: 8, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    // Should have created 2 files (16 records / 8 per file)
    const expectedFile0 = join(dataDir, "synthetic_0000.bin");
    const expectedFile1 = join(dataDir, "synthetic_0001.bin");
    assertEquals(existsSync(expectedFile0), true, "first data file should exist");
    assertEquals(existsSync(expectedFile1), true, "second data file should exist");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData creates files with correct size", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const json = createReferenceCreature();
    const creature = Creature.fromJSON(json);

    const recordsPerFile = 10;
    const config = { totalRecords: 10, recordsPerFile, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const filePath = join(dataDir, "synthetic_0000.bin");
    const stat = Deno.statSync(filePath);

    // Each record: (4 inputs + 1 output) * 4 bytes = 20 bytes
    const expectedSize = recordsPerFile * (creature.input + creature.output) * 4;
    assertEquals(stat.size, expectedSize, "file size should match expected record size");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData is deterministic for the same seed", () => {
  const tmpDir1 = Deno.makeTempDirSync({ prefix: "neat_test_" });
  const tmpDir2 = Deno.makeTempDirSync({ prefix: "neat_test_" });
  const dataDir1 = join(tmpDir1, "data");
  const dataDir2 = join(tmpDir2, "data");
  ensureDirSync(dataDir1);
  ensureDirSync(dataDir2);

  try {
    const json = createReferenceCreature();
    const creature1 = Creature.fromJSON(json);
    const creature2 = Creature.fromJSON(json);

    const config = { totalRecords: 8, recordsPerFile: 8, seed: 42 };
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

/* ------------------------------------------------------------------ */
/*  SYNTHETIC_CONFIG                                                    */
/* ------------------------------------------------------------------ */

Deno.test("SYNTHETIC_CONFIG has expected properties", () => {
  assertGreater(SYNTHETIC_CONFIG.totalRecords, 0, "totalRecords should be positive");
  assertGreater(SYNTHETIC_CONFIG.recordsPerFile, 0, "recordsPerFile should be positive");
  assertGreater(SYNTHETIC_CONFIG.seed, 0, "seed should be positive");
});

/* ------------------------------------------------------------------ */
/*  Scoring: baseline vs crippled                                      */
/* ------------------------------------------------------------------ */

Deno.test("crippled creature scores worse than baseline on generated data", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const json = createReferenceCreature();
    const baseline = Creature.fromJSON(json);
    baseline.validate();

    const config = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(baseline, dataDir, config);

    const crippled = createCrippledCreature(json, "hidden-1");

    const baselineScore = baseline.scoreDir(dataDir, {});
    const crippledScore = crippled.scoreDir(dataDir, {});

    // The baseline trained on its own data should score better
    // (scores are negative; closer to 0 is better)
    assertGreater(
      baselineScore.score,
      crippledScore.score,
      "baseline should score better than crippled creature",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
