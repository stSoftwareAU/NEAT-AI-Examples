/**
 * Unit tests for the shared synthetic data generation module.
 *
 * These are "what" tests — they verify that generateSyntheticData and
 * scoreCreature produce the correct results (files, sizes, determinism)
 * without checking implementation details.
 */

import { assertAlmostEquals, assertEquals, assertGreater, assertThrows } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  generateNetworkDataset,
  generateSyntheticData,
  scoreCreature,
  type SyntheticConfig,
  writeBinaryDataset,
} from "./synthetic_data.ts";
import { type FeedForwardNetwork, forward } from "./feed_forward_network.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "./legacy_types.ts";

/** Creates a minimal creature for testing purposes. */
function createTestCreature(): Creature {
  const json: LegacyCreatureJSON = {
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
  return Creature.fromJSON(asCreatureExport(json));
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

Deno.test("scoreCreature returns a finite numeric score", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const score = await scoreCreature(creature, dataDir);
    assertEquals(typeof score, "number", "score should be a number");
    assertEquals(Number.isFinite(score), true, "score should be finite");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("scoreCreature returns deterministic results", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    const score1 = await scoreCreature(creature, dataDir);
    const score2 = await scoreCreature(creature, dataDir);
    assertEquals(score1, score2, "same creature and data should yield same score");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("scoreCreature scores higher for matching creature", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createTestCreature();
    const config: SyntheticConfig = { totalRecords: 64, recordsPerFile: 64, seed: 42 };
    generateSyntheticData(creature, dataDir, config);

    // Create a different creature
    const differentJSON: LegacyCreatureJSON = {
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
    const differentCreature = Creature.fromJSON(asCreatureExport(differentJSON));

    const matchingScore = await scoreCreature(creature, dataDir);
    const differentScore = await scoreCreature(differentCreature, dataDir);

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

/* ------------------------------------------------------------------ */
/*  writeBinaryDataset                                                 */
/* ------------------------------------------------------------------ */

Deno.test("writeBinaryDataset writes training.bin sized recordCount * stride * 4", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  try {
    // Nested path that does not exist yet — the helper must create it.
    const dataDir = join(tmpDir, "data", "nested");
    const dataset = [
      { inputs: [0.25, -0.5, 1], targets: [0.75, -0.25] },
      { inputs: [1, 0, -1], targets: [0, 0.5] },
    ];

    const path = writeBinaryDataset(dataset, dataDir, 3, 2);

    assertEquals(path, join(dataDir, "training.bin"), "returns the training.bin path");
    assertEquals(existsSync(path), true, "training.bin should exist");
    assertEquals(Deno.statSync(path).size, 2 * (3 + 2) * 4, "byte count should match the stride");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeBinaryDataset lays each record out as inputs then targets", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  try {
    const dataset = [
      { inputs: Float32Array.from([0.25, -0.5]), targets: Float32Array.from([0.75]) },
      { inputs: Float32Array.from([-1, 1]), targets: Float32Array.from([-0.125]) },
    ];

    const path = writeBinaryDataset(dataset, tmpDir, 2, 1);
    const bytes = Deno.readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const stride = 3;
    for (let i = 0; i < dataset.length; i++) {
      for (let k = 0; k < 2; k++) {
        assertEquals(
          view.getFloat32((i * stride + k) * 4, true),
          dataset[i].inputs[k],
          `record ${i} input ${k}`,
        );
      }
      assertEquals(
        view.getFloat32((i * stride + 2) * 4, true),
        dataset[i].targets[0],
        `record ${i} target 0`,
      );
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeBinaryDataset accepts plain-array records from fixed-arity callers", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  try {
    const path = writeBinaryDataset([{ inputs: [0.5, -0.5], targets: [0.25] }], tmpDir, 2, 1);
    const bytes = Deno.readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assertEquals(view.getFloat32(0, true), 0.5);
    assertEquals(view.getFloat32(4, true), -0.5);
    assertEquals(view.getFloat32(8, true), 0.25);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeBinaryDataset writes an empty file for an empty dataset", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  try {
    const path = writeBinaryDataset([], tmpDir, 2, 1);
    assertEquals(Deno.statSync(path).size, 0, "no records means no bytes");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeBinaryDataset rejects a record whose arity does not match the stride", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  try {
    assertThrows(
      () => writeBinaryDataset([{ inputs: [0.5], targets: [0.25] }], tmpDir, 2, 1),
      Error,
      "2 inputs",
    );
    assertThrows(
      () => writeBinaryDataset([{ inputs: [0.5, 0.5], targets: [] }], tmpDir, 2, 1),
      Error,
      "1 target",
    );
    assertEquals(existsSync(join(tmpDir, "training.bin")), false, "no file on a rejected dataset");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeBinaryDataset rejects non-positive input or output counts", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_common_test_" });
  try {
    assertThrows(() => writeBinaryDataset([], tmpDir, 0, 1), Error, "inputCount");
    assertThrows(() => writeBinaryDataset([], tmpDir, 2, 0), Error, "outputCount");
    assertThrows(() => writeBinaryDataset([], tmpDir, 1.5, 1), Error, "inputCount");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  generateNetworkDataset                                             */
/* ------------------------------------------------------------------ */

/** A tiny 2-input, 1-hidden, 1-output feed-forward network. */
function createTestNetwork(): FeedForwardNetwork {
  return {
    inputCount: 2,
    outputCount: 1,
    neurons: [
      { index: 0, type: "input", squash: "IDENTITY", bias: 0 },
      { index: 1, type: "input", squash: "IDENTITY", bias: 0 },
      { index: 2, type: "hidden", squash: "TANH", bias: 0.1 },
      { index: 3, type: "output", squash: "LOGISTIC", bias: -0.2 },
    ],
    synapses: [
      { from: 0, to: 2, weight: 0.5 },
      { from: 1, to: 2, weight: -0.3 },
      { from: 2, to: 3, weight: 0.8 },
    ],
  };
}

Deno.test("generateNetworkDataset returns the requested number of records", () => {
  const dataset = generateNetworkDataset(createTestNetwork(), 12, 42);

  assertEquals(dataset.length, 12, "one record per requested sample");
  for (const point of dataset) {
    assertEquals(point.inputs.length, 2, "one value per network input");
    assertEquals(point.targets.length, 1, "one value per network output");
  }
});

Deno.test("generateNetworkDataset draws inputs from [-1, 1]", () => {
  for (const point of generateNetworkDataset(createTestNetwork(), 64, 7)) {
    for (const value of point.inputs) {
      assertEquals(value >= -1 && value <= 1, true, `input ${value} should be within [-1, 1]`);
    }
  }
});

Deno.test("generateNetworkDataset labels each record with the network's own output", () => {
  const network = createTestNetwork();
  const outStart = network.neurons.length - network.outputCount;

  for (const point of generateNetworkDataset(network, 8, 5)) {
    const acts = forward(network, point.inputs);
    assertAlmostEquals(point.targets[0], acts[outStart], 1e-6, "target should be the label");
  }
});

Deno.test("generateNetworkDataset is deterministic for a given seed", () => {
  const a = generateNetworkDataset(createTestNetwork(), 8, 99);
  const b = generateNetworkDataset(createTestNetwork(), 8, 99);
  const c = generateNetworkDataset(createTestNetwork(), 8, 100);

  assertEquals(a, b, "same seed should produce identical records");
  assertEquals(a[0].inputs[0] === c[0].inputs[0], false, "a different seed should differ");
});

Deno.test("generateNetworkDataset rejects a non-positive size", () => {
  assertThrows(
    () => generateNetworkDataset(createTestNetwork(), 0, 1),
    Error,
    "size must be positive",
  );
});
