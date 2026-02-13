/**
 * Benchmarks for the intelligent design example module.
 *
 * Measures performance of creature creation, activation, synthetic data
 * generation, and scoring operations. Run with:
 *
 *   deno bench --allow-read --allow-write --allow-env intelligent_design/
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import { createReferenceCreature, generateSyntheticData } from "./improve_squash_example.ts";
import { scoreCreature } from "../common/synthetic_data.ts";

/* ------------------------------------------------------------------ */
/*  Creature creation                                                  */
/* ------------------------------------------------------------------ */

Deno.bench("intelligent_design: create reference creature", () => {
  createReferenceCreature();
});

Deno.bench("intelligent_design: create and validate creature", () => {
  const creature = createReferenceCreature();
  creature.validate();
});

/* ------------------------------------------------------------------ */
/*  Creature activation                                                */
/* ------------------------------------------------------------------ */

const activationCreature = createReferenceCreature();
const activationInput = new Float32Array([0.5, -0.3, 0.7, 0.1]);

Deno.bench("intelligent_design: activate creature with random inputs", () => {
  activationCreature.clearState();
  activationCreature.activate(activationInput);
});

Deno.bench(
  "intelligent_design: activate creature with varied inputs",
  { group: "activation" },
  () => {
    const inputs = [
      new Float32Array([0.0, 0.0, 0.0, 0.0]),
      new Float32Array([1.0, 1.0, 1.0, 1.0]),
      new Float32Array([-1.0, -1.0, -1.0, -1.0]),
      new Float32Array([0.5, -0.5, 0.25, -0.75]),
    ];

    for (const input of inputs) {
      activationCreature.clearState();
      activationCreature.activate(input);
    }
  },
);

/* ------------------------------------------------------------------ */
/*  Synthetic data generation                                          */
/* ------------------------------------------------------------------ */

Deno.bench("intelligent_design: generate synthetic data (500 records)", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_bench_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const creature = createReferenceCreature();
    generateSyntheticData(creature, dataDir, {
      totalRecords: 500,
      recordsPerFile: 500,
      seed: 42424242,
    });
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Scoring                                                            */
/* ------------------------------------------------------------------ */

// Pre-generate data for scoring benchmarks
const scoreTmpDir = Deno.makeTempDirSync({ prefix: "neat_bench_score_" });
const scoreDataDir = join(scoreTmpDir, "data");
ensureDirSync(scoreDataDir);

const scoreCreatureInstance = createReferenceCreature();
generateSyntheticData(scoreCreatureInstance, scoreDataDir, {
  totalRecords: 500,
  recordsPerFile: 500,
  seed: 42424242,
});

Deno.bench("intelligent_design: score creature against data (scoreDir)", () => {
  scoreCreatureInstance.scoreDir(scoreDataDir, {});
});

Deno.bench("intelligent_design: score creature against data (scoreCreature)", () => {
  scoreCreature(scoreCreatureInstance, scoreDataDir);
});

// Clean up scoring data when the process exits
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(scoreTmpDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});
