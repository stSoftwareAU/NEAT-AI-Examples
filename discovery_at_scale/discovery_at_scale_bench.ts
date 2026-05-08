/**
 * Benchmarks for the discovery-at-scale demo (issue #84).
 *
 * Measures defect injection, dataset loading, and topology snapshotting
 * on a representative large creature.
 *
 *   deno bench --allow-read --allow-write --allow-env --allow-ffi discovery_at_scale/
 */
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import {
  creatureAsRaw,
  DEFAULT_DISCOVERY_AT_SCALE_CONFIG,
  injectDefects,
  loadDatasetSamples,
  rawAsCreature,
  snapshotTopology,
} from "./discovery_at_scale.ts";
import { renderDiscoveryAtScaleSVG } from "./svg.ts";
import { buildLargeCreature } from "../common/large_creature.ts";
import { generateSyntheticData } from "../common/synthetic_data.ts";

const cfg = DEFAULT_DISCOVERY_AT_SCALE_CONFIG;

const baseline = buildLargeCreature({
  inputs: cfg.inputs,
  hidden: cfg.hidden,
  outputs: cfg.outputs,
  density: cfg.density,
  seed: cfg.seed,
});

const benchTmp = Deno.makeTempDirSync({ prefix: "discovery_at_scale_bench_" });
const benchData = join(benchTmp, "data");
ensureDirSync(benchData);
generateSyntheticData(baseline, benchData, {
  totalRecords: cfg.totalRecords,
  recordsPerFile: cfg.recordsPerFile,
  seed: cfg.seed ^ 0x1357,
});
const samples = loadDatasetSamples(benchData, cfg.inputs, cfg.outputs);

Deno.bench("discovery_at_scale: clone creature → raw JSON", () => {
  creatureAsRaw(baseline);
});

Deno.bench("discovery_at_scale: inject defects", () => {
  const raw = creatureAsRaw(baseline);
  injectDefects(raw, cfg);
});

Deno.bench("discovery_at_scale: rebuild Creature from defective raw JSON", () => {
  const raw = creatureAsRaw(baseline);
  injectDefects(raw, cfg);
  rawAsCreature(raw);
});

Deno.bench("discovery_at_scale: detect defects on the dataset", () => {
  const raw = creatureAsRaw(baseline);
  injectDefects(raw, cfg);
  snapshotTopology(raw, samples);
});

Deno.bench("discovery_at_scale: render before/after SVG", () => {
  const raw = creatureAsRaw(baseline);
  injectDefects(raw, cfg);
  const snap = snapshotTopology(raw, samples);
  renderDiscoveryAtScaleSVG({
    before: snap,
    after: snap,
    baselineScore: -0.001,
    crippledScore: -0.5,
    discoveredScore: null,
    discoveryFound: false,
    discoveryNote: "bench fallback",
  });
});

globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(benchTmp, { recursive: true });
  } catch {
    // Ignore cleanup errors.
  }
});
