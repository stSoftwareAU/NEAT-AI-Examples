/**
 * Unit tests for the shared synthetic data generation module.
 *
 * These are "what" tests — they verify that generateSyntheticData and
 * scoreCreature produce the correct results (files, sizes, determinism)
 * without checking implementation details.
 */

import { assertEquals, assertGreater } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport } from "@stsoftware/neat-ai";

import { generateSyntheticData, scoreCreature, type SyntheticConfig } from "./synthetic_data.ts";

/** Creates a minimal creature for testing purposes. */
function createTestCreature(): Creature {
  const json: CreatureExport = {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "in-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "in-1" },
      { type: "hidden", squash: "TANH", index: 2, bias: 0.1, uuid: "hid-0" },
      { type: "output", squash: "LOGISTIC", index: 3, bias: 0, uuid: "out-0" },
    ],
    synapses: [
      { from: 0, to: 2, weight: 0.5 },
      { from: 1, to: 2, weight: -0.3 },
      { from: 2, to: 3, weight: 0.8 },
    ],
    input: 2,
    output: 1,
  };
  return Creature.fromJSON(json);
}

/* ------------------------------------------------------------------ */
/*  generateSyntheticData                                              */
/* ------------------------------------------------------------------ */

Deno.test("generateSyntheticData creates binary files in the target directory", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 16, recordsPerFile: 8, seed: 42 };
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

Deno.test("generateSyntheticData creates files with correct size", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const recordsPerFile = 10;
    const config: SyntheticConfig = { totalRecords: 10, recordsPerFile, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const filePath = join(dataDir, "synthetic_0000.bin");
    const stat = Deno.statSync(filePath);

    // Each record: (2 inputs + 1 output) * 4 bytes = 12 bytes
    const expectedSize = recordsPerFile * (creature.input + creature.output) * 4;
    assertEquals(stat.size, expectedSize, "file size should match expected record size");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData is deterministic for the same seed", () => {
  const tmpDir1 = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const tmpDir2 = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir1 = join(tmpDir1, "data");
  const dataDir2 = join(tmpDir2, "data");
  ensureDirSync(dataDir1);
  ensureDirSync(dataDir2);

  try {
    const creature1 = createTestCreature();
    const creature2 = createTestCreature();

    const config: SyntheticConfig = { totalRecords: 8, recordsPerFile: 8, seed: 42 };
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

Deno.test("generateSyntheticData files contain valid float32 values", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 16, recordsPerFile: 16, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const dataPath = join(dataDir, "synthetic_0000.bin");
    const buffer = Deno.readFileSync(dataPath);
    const view = new DataView(buffer.buffer);

    // Spot-check first record: 2 inputs + 1 output = 3 floats
    const recordFloats = creature.input + creature.output;
    for (let i = 0; i < recordFloats; i++) {
      const value = view.getFloat32(i * 4, true);
      assertEquals(Number.isFinite(value), true, `float at offset ${i} should be finite`);
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("generateSyntheticData produces different data for different seeds", () => {
  const tmpDir1 = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const tmpDir2 = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir1 = join(tmpDir1, "data");
  const dataDir2 = join(tmpDir2, "data");
  ensureDirSync(dataDir1);
  ensureDirSync(dataDir2);

  try {
    const creature1 = createTestCreature();
    const creature2 = createTestCreature();

    const config1: SyntheticConfig = { totalRecords: 8, recordsPerFile: 8, seed: 42 };
    const config2: SyntheticConfig = { totalRecords: 8, recordsPerFile: 8, seed: 99 };
    generateSyntheticData(creature1, dataDir1, config1);
    generateSyntheticData(creature2, dataDir2, config2);

    const file1 = Deno.readFileSync(join(dataDir1, "synthetic_0000.bin"));
    const file2 = Deno.readFileSync(join(dataDir2, "synthetic_0000.bin"));

    // Files should differ when seeds differ
    let allSame = true;
    for (let i = 0; i < file1.length; i++) {
      if (file1[i] !== file2[i]) {
        allSame = false;
        break;
      }
    }
    assertEquals(allSame, false, "different seeds should produce different data");
  } finally {
    Deno.removeSync(tmpDir1, { recursive: true });
    Deno.removeSync(tmpDir2, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  scoreCreature                                                      */
/* ------------------------------------------------------------------ */

Deno.test("scoreCreature returns a finite numeric score", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const score = scoreCreature(creature, dataDir);
    assertEquals(typeof score, "number", "score should be a number");
    assertEquals(Number.isFinite(score), true, "score should be finite");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("scoreCreature returns deterministic results", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const score1 = scoreCreature(creature, dataDir);
    const score2 = scoreCreature(creature, dataDir);
    assertEquals(score1, score2, "same creature and data should yield same score");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("scoreCreature scores higher for matching creature", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    // Create a different creature
    const differentJSON: CreatureExport = {
      neurons: [
        { type: "input", squash: "LOGISTIC", index: 0, uuid: "in-0" },
        { type: "input", squash: "LOGISTIC", index: 1, uuid: "in-1" },
        { type: "hidden", squash: "SELU", index: 2, bias: -0.5, uuid: "hid-0" },
        { type: "output", squash: "LOGISTIC", index: 3, bias: 0.3, uuid: "out-0" },
      ],
      synapses: [
        { from: 0, to: 2, weight: -0.8 },
        { from: 1, to: 2, weight: 0.6 },
        { from: 2, to: 3, weight: -0.4 },
      ],
      input: 2,
      output: 1,
    };
    const differentCreature = Creature.fromJSON(differentJSON);

    const matchingScore = scoreCreature(creature, dataDir);
    const differentScore = scoreCreature(differentCreature, dataDir);

    // The creature that generated the data should score better
    assertGreater(
      matchingScore,
      differentScore,
      "matching creature should score better than different creature",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
