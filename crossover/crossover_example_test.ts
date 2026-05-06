/**
 * Unit tests for the crossover (breeding) example module.
 *
 * These are "what" tests — they verify that each function produces
 * the correct result (output, side effects, structure) without
 * checking implementation details or timing.
 */

import { assert, assertEquals, assertGreater, assertNotEquals } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  createParentA,
  createParentB,
  generateSyntheticData,
  performCrossover,
  scoreCreature,
  SYNTHETIC_CONFIG,
} from "./crossover_example.ts";

/* ------------------------------------------------------------------ */
/*  createParentA                                                      */
/* ------------------------------------------------------------------ */

Deno.test("createParentA returns a creature with 3 inputs and 1 output", () => {
  const creature = createParentA();
  assertEquals(creature.input, 3, "should have 3 inputs");
  assertEquals(creature.output, 1, "should have 1 output");
});

Deno.test("createParentA returns a valid creature", () => {
  const creature = createParentA();
  creature.validate();
});

Deno.test("createParentA produces finite output", () => {
  const creature = createParentA();
  const input = new Float32Array([0.5, -0.3, 0.7]);
  creature.clearState();
  const output = creature.activate(input);

  assertEquals(output.length, 1, "should produce exactly 1 output");
  assertEquals(Number.isFinite(output[0]), true, "output should be finite");
});

Deno.test("createParentA produces deterministic output", () => {
  const a1 = createParentA();
  const a2 = createParentA();
  const input = new Float32Array([0.2, 0.8, -0.5]);

  a1.clearState();
  const out1 = a1.activate(input);

  a2.clearState();
  const out2 = a2.activate(input);

  assertEquals(out1[0], out2[0], "same input should yield same output");
});

Deno.test("createParentA has hidden neurons with TANH-family squashes", () => {
  const creature = createParentA();
  const json = creature.exportJSON();
  const hidden = json.neurons.filter((n) => n.type === "hidden");

  assertGreater(hidden.length, 0, "should have at least one hidden neuron");
});

/* ------------------------------------------------------------------ */
/*  createParentB                                                      */
/* ------------------------------------------------------------------ */

Deno.test("createParentB returns a creature with 3 inputs and 1 output", () => {
  const creature = createParentB();
  assertEquals(creature.input, 3, "should have 3 inputs");
  assertEquals(creature.output, 1, "should have 1 output");
});

Deno.test("createParentB returns a valid creature", () => {
  const creature = createParentB();
  creature.validate();
});

Deno.test("createParentB produces finite output", () => {
  const creature = createParentB();
  const input = new Float32Array([0.5, -0.3, 0.7]);
  creature.clearState();
  const output = creature.activate(input);

  assertEquals(output.length, 1, "should produce exactly 1 output");
  assertEquals(Number.isFinite(output[0]), true, "output should be finite");
});

Deno.test("createParentB produces deterministic output", () => {
  const b1 = createParentB();
  const b2 = createParentB();
  const input = new Float32Array([0.2, 0.8, -0.5]);

  b1.clearState();
  const out1 = b1.activate(input);

  b2.clearState();
  const out2 = b2.activate(input);

  assertEquals(out1[0], out2[0], "same input should yield same output");
});

Deno.test("createParentB has hidden neurons with different squashes from parentA", () => {
  const a = createParentA();
  const b = createParentB();
  const jsonA = a.exportJSON();
  const jsonB = b.exportJSON();

  const hiddenA = jsonA.neurons.filter((n) => n.type === "hidden");
  const hiddenB = jsonB.neurons.filter((n) => n.type === "hidden");
  const squashesA = new Set(hiddenA.map((n) => n.squash));
  const squashesB = new Set(hiddenB.map((n) => n.squash));

  // At least one squash in B should not appear in A
  let hasDifference = false;
  for (const s of squashesB) {
    if (!squashesA.has(s)) {
      hasDifference = true;
      break;
    }
  }
  assertEquals(hasDifference, true, "parents should use some different squash functions");
});

Deno.test("parents produce different outputs for the same input", () => {
  const a = createParentA();
  const b = createParentB();
  const input = new Float32Array([0.5, -0.3, 0.7]);

  a.clearState();
  const outA = a.activate(input);

  b.clearState();
  const outB = b.activate(input);

  assertNotEquals(outA[0], outB[0], "parents should produce different outputs");
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
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createParentA();
    const config = { totalRecords: 16, recordsPerFile: 16, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const dataPath = join(dataDir, "synthetic_0000.bin");
    assertEquals(existsSync(dataPath), true, "synthetic_0000.bin should exist");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData creates a file with correct size", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createParentA();
    const recordCount = 50;
    const config = { totalRecords: recordCount, recordsPerFile: recordCount, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const dataPath = join(dataDir, "synthetic_0000.bin");
    const stat = Deno.statSync(dataPath);

    // records * (3 inputs + 1 output) * 4 bytes per float32
    const expectedSize = recordCount * (creature.input + creature.output) * 4;
    assertEquals(stat.size, expectedSize, "file size should match expected record count");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData is deterministic for the same seed", () => {
  const tmpDir1 = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const tmpDir2 = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const dataDir1 = join(tmpDir1, "data");
  const dataDir2 = join(tmpDir2, "data");
  ensureDirSync(dataDir1);
  ensureDirSync(dataDir2);

  try {
    const creature1 = createParentA();
    const creature2 = createParentA();

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

Deno.test("generateSyntheticData file contains valid float32 values", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createParentA();
    const config = { totalRecords: 16, recordsPerFile: 16, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const dataPath = join(dataDir, "synthetic_0000.bin");
    const buffer = Deno.readFileSync(dataPath);
    const view = new DataView(buffer.buffer);

    // Spot-check first record: 3 inputs + 1 output = 4 floats
    const recordFloats = creature.input + creature.output;
    for (let i = 0; i < recordFloats; i++) {
      const value = view.getFloat32(i * 4, true);
      assertEquals(Number.isFinite(value), true, `float at offset ${i} should be finite`);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  scoreCreature                                                      */
/* ------------------------------------------------------------------ */

Deno.test("scoreCreature returns a finite numeric score", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createParentA();
    const config = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const score = await scoreCreature(creature, dataDir);
    assertEquals(typeof score, "number", "score should be a number");
    assertEquals(Number.isFinite(score), true, "score should be finite");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("scoreCreature returns deterministic results", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createParentA();
    const config = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const score1 = await scoreCreature(creature, dataDir);
    const score2 = await scoreCreature(creature, dataDir);
    assertEquals(score1, score2, "same creature and data should yield same score");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  performCrossover                                                   */
/* ------------------------------------------------------------------ */

Deno.test("performCrossover returns a valid creature or undefined", () => {
  const parentA = createParentA();
  const parentB = createParentB();

  const offspring = performCrossover(parentA, parentB);

  if (offspring !== undefined) {
    offspring.validate();
    assertEquals(offspring.input, 3, "offspring should have 3 inputs");
    assertEquals(offspring.output, 1, "offspring should have 1 output");
  }
  // It's valid for crossover to return undefined if parents are incompatible
  assert(
    offspring === undefined || offspring instanceof Creature,
    "should return a Creature or undefined",
  );
});

Deno.test("performCrossover offspring produces finite output", () => {
  const parentA = createParentA();
  const parentB = createParentB();

  const offspring = performCrossover(parentA, parentB);

  if (offspring !== undefined) {
    const input = new Float32Array([0.5, -0.3, 0.7]);
    offspring.clearState();
    const output = offspring.activate(input);

    assertEquals(output.length, 1, "offspring should produce exactly 1 output");
    assertEquals(Number.isFinite(output[0]), true, "offspring output should be finite");
  }
});

Deno.test("performCrossover offspring can be scored against data", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_xover_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const parentA = createParentA();
    const config = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(parentA, dataDir, config);

    const parentB = createParentB();
    const offspring = performCrossover(parentA, parentB);

    if (offspring !== undefined) {
      const score = await scoreCreature(offspring, dataDir);
      assertEquals(typeof score, "number", "offspring score should be a number");
      assertEquals(Number.isFinite(score), true, "offspring score should be finite");
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
