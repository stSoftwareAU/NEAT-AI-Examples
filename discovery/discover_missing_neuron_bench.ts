/**
 * Benchmarks for the discovery example module.
 *
 * Measures performance of creature creation, activation, synthetic data
 * generation, and scoring operations. Run with:
 *
 *   deno bench --allow-read --allow-write --allow-env discovery/
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  createCrippledCreature,
  createReferenceCreature,
  generateSyntheticData,
} from "./discover_missing_neuron.ts";

/* ------------------------------------------------------------------ */
/*  Creature creation                                                  */
/* ------------------------------------------------------------------ */

Deno.bench("discovery: create reference creature", () => {
  createReferenceCreature();
});

Deno.bench("discovery: instantiate creature from JSON", () => {
  const json = createReferenceCreature();
  Creature.fromJSON(json);
});

Deno.bench("discovery: create and validate creature", () => {
  const json = createReferenceCreature();
  const creature = Creature.fromJSON(json);
  creature.validate();
});

Deno.bench("discovery: create crippled creature", () => {
  const json = createReferenceCreature();
  createCrippledCreature(json, "hidden-1");
});

/* ------------------------------------------------------------------ */
/*  Creature activation                                                */
/* ------------------------------------------------------------------ */

const activationJSON = createReferenceCreature();
const activationCreature = Creature.fromJSON(activationJSON);
const activationInput = new Float32Array([0.5, -0.3, 0.7, 0.1]);

Deno.bench("discovery: activate creature with random inputs", () => {
  activationCreature.clearState();
  activationCreature.activate(activationInput);
});

const crippledCreature = createCrippledCreature(activationJSON, "hidden-1");

Deno.bench("discovery: activate crippled creature", () => {
  crippledCreature.clearState();
  crippledCreature.activate(activationInput);
});

/* ------------------------------------------------------------------ */
/*  Synthetic data generation                                          */
/* ------------------------------------------------------------------ */

Deno.bench("discovery: generate synthetic data (256 records)", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_bench_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const json = createReferenceCreature();
    const creature = Creature.fromJSON(json);
    generateSyntheticData(creature, dataDir, {
      totalRecords: 256,
      recordsPerFile: 128,
      seed: 13371337,
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

const scoreJSON = createReferenceCreature();
const scoreCreature = Creature.fromJSON(scoreJSON);
generateSyntheticData(scoreCreature, scoreDataDir, {
  totalRecords: 256,
  recordsPerFile: 128,
  seed: 13371337,
});

const scoreCrippled = createCrippledCreature(scoreJSON, "hidden-1");

Deno.bench("discovery: score baseline creature against data", () => {
  scoreCreature.scoreDir(scoreDataDir, {});
});

Deno.bench("discovery: score crippled creature against data", () => {
  scoreCrippled.scoreDir(scoreDataDir, {});
});

// Clean up scoring data when the process exits
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(scoreTmpDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});
