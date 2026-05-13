/**
 * Unit tests for the discovery-at-scale demo (issue #84).
 *
 * "What" tests only — every test calls a real function with deterministic
 * inputs and asserts on the returned values, side effects, or rendered
 * SVG payload. No grepping or implementation snooping.
 */
import {
  assert,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertStringIncludes,
} from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";

import { Creature } from "@stsoftware/neat-ai";

import {
  buildAtScaleEvolveDirSummary,
  creatureAsRaw,
  DEFAULT_AT_SCALE_EVOLUTION_CONFIG,
  type DiscoveryAtScaleConfig,
  injectDefects,
  INPUT_COUNT,
  loadDatasetSamples,
  OUTPUT_COUNT,
  rawAsCreature,
  REFERENCE_DENSITY,
  REFERENCE_HIDDEN,
  REFERENCE_SEED,
  runDiscoveryAtScaleDemo,
  runMinimalSeedAtScaleEvolution,
  snapshotTopology,
} from "./discovery_at_scale.ts";
import { DEFECT_COLOURS, renderDiscoveryAtScaleSVG } from "./svg.ts";
import { renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { buildLargeCreature } from "../common/large_creature.ts";
import { generateSyntheticData } from "../common/synthetic_data.ts";

/**
 * Small config used throughout the test suite — keeps each test fast.
 *
 * Sized so that the injected defects affect a majority of the hidden
 * neurons. Smaller / sparser configurations leave too much redundancy for
 * the crippled creature to score noticeably worse than the baseline on
 * its own data.
 */
const SMALL_CONFIG: DiscoveryAtScaleConfig = {
  inputs: 4,
  hidden: 12,
  outputs: 2,
  density: 0.5,
  seed: 88_888,
  saturatedCount: 3,
  deadCount: 3,
  dormantCount: 3,
  dormantSynapseCount: 4,
  totalRecords: 32,
  recordsPerFile: 32,
};

Deno.test("injectDefects - returns the requested defect counts", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  const injected = injectDefects(raw, SMALL_CONFIG);
  assertEquals(injected.saturated.length, SMALL_CONFIG.saturatedCount);
  assertEquals(injected.dead.length, SMALL_CONFIG.deadCount);
  assertEquals(injected.dormant.length, SMALL_CONFIG.dormantCount);
  assert(
    injected.dormantSynapses.length <= SMALL_CONFIG.dormantSynapseCount,
    `dormantSynapses may have fewer entries than requested if candidates are scarce`,
  );
});

Deno.test("injectDefects - chosen indices are all hidden neurons", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  const injected = injectDefects(raw, SMALL_CONFIG);
  const hiddenStart = creature.input;
  const hiddenEnd = creature.neurons.length - creature.output;
  for (const arr of [injected.saturated, injected.dead, injected.dormant]) {
    for (const idx of arr) {
      assertGreaterOrEqual(idx, hiddenStart);
      assert(idx < hiddenEnd, `index ${idx} should be hidden, hiddenEnd=${hiddenEnd}`);
    }
  }
});

Deno.test("injectDefects - rebuilt creature still validates", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  injectDefects(raw, SMALL_CONFIG);
  const crippled = rawAsCreature(raw);
  crippled.validate();
  assertEquals(crippled.input, SMALL_CONFIG.inputs);
  assertEquals(crippled.output, SMALL_CONFIG.outputs);
});

Deno.test("snapshotTopology - flags injected saturated neurons as saturated", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  const injected = injectDefects(raw, SMALL_CONFIG);

  // Build a small set of representative samples in [-1, 1].
  const samples: Float32Array[] = [];
  for (let s = 0; s < 24; s++) {
    const arr = new Float32Array(SMALL_CONFIG.inputs);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = ((s + i) * 0.137) % 2 - 1;
    }
    samples.push(arr);
  }
  const snap = snapshotTopology(raw, samples);

  let saturatedHits = 0;
  for (const idx of injected.saturated) {
    if (snap.defects[idx] === "saturated") saturatedHits++;
  }
  assertGreater(
    saturatedHits,
    0,
    "at least one injected saturated neuron should be detected as saturated",
  );
});

Deno.test("snapshotTopology - flags dormant synapses on the edge list", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  injectDefects(raw, SMALL_CONFIG);

  const samples: Float32Array[] = [new Float32Array(SMALL_CONFIG.inputs)];
  const snap = snapshotTopology(raw, samples);
  const dormantEdges = snap.edges.filter((e) => e.dormant).length;
  assertGreater(dormantEdges, 0, "expected at least one dormant synapse to be flagged");
});

Deno.test("snapshotTopology - inputs and outputs always classified as healthy", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  injectDefects(raw, SMALL_CONFIG);
  const samples: Float32Array[] = [new Float32Array(SMALL_CONFIG.inputs)];
  const snap = snapshotTopology(raw, samples);
  for (let i = 0; i < SMALL_CONFIG.inputs; i++) {
    assertEquals(snap.defects[i], "healthy");
  }
  const total = snap.neuronCount;
  for (let i = total - SMALL_CONFIG.outputs; i < total; i++) {
    assertEquals(snap.defects[i], "healthy");
  }
});

Deno.test("loadDatasetSamples - reads back the inputs written by generateSyntheticData", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "discovery_at_scale_test_" });
  const dataDir = join(tmp, "data");
  ensureDirSync(dataDir);
  try {
    const creature = buildLargeCreature({
      inputs: 4,
      hidden: 8,
      outputs: 2,
      density: 0.3,
      seed: 1,
    });
    generateSyntheticData(creature, dataDir, {
      totalRecords: 16,
      recordsPerFile: 8,
      seed: 1,
    });
    const samples = loadDatasetSamples(dataDir, creature.input, creature.output);
    assertEquals(samples.length, 16, "should read every generated record");
    for (const s of samples) {
      assertEquals(s.length, creature.input);
      for (const v of s) {
        assert(Number.isFinite(v), `sample value must be finite: ${v}`);
      }
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("renderDiscoveryAtScaleSVG - produces a non-empty SVG with the expected colours", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  injectDefects(raw, SMALL_CONFIG);

  const samples: Float32Array[] = [];
  for (let s = 0; s < 8; s++) {
    const arr = new Float32Array(SMALL_CONFIG.inputs);
    for (let i = 0; i < arr.length; i++) arr[i] = ((s + i) * 0.21) % 2 - 1;
    samples.push(arr);
  }
  const before = snapshotTopology(raw, samples);
  const after = before;
  const svg = renderDiscoveryAtScaleSVG({
    before,
    after,
    baselineScore: -0.001,
    crippledScore: -0.5,
    discoveredScore: null,
    discoveryFound: false,
    discoveryNote: "discovery unavailable",
  });
  assertGreater(svg.length, 1000, "SVG should be substantial");
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "Discovery at Scale");
  // Every defect category colour must appear at least once (legend).
  for (const colour of Object.values(DEFECT_COLOURS)) {
    assertStringIncludes(svg, colour);
  }
});

Deno.test("renderDiscoveryAtScaleSVG - is byte-deterministic for identical inputs", () => {
  const creature = buildLargeCreature({
    inputs: SMALL_CONFIG.inputs,
    hidden: SMALL_CONFIG.hidden,
    outputs: SMALL_CONFIG.outputs,
    density: SMALL_CONFIG.density,
    seed: SMALL_CONFIG.seed,
  });
  const raw = creatureAsRaw(creature);
  injectDefects(raw, SMALL_CONFIG);
  const samples = [new Float32Array(SMALL_CONFIG.inputs)];
  const snap = snapshotTopology(raw, samples);
  const a = renderDiscoveryAtScaleSVG({
    before: snap,
    after: snap,
    baselineScore: -0.01,
    crippledScore: -0.5,
    discoveredScore: -0.1,
    discoveryFound: true,
    discoveryNote: null,
  });
  const b = renderDiscoveryAtScaleSVG({
    before: snap,
    after: snap,
    baselineScore: -0.01,
    crippledScore: -0.5,
    discoveredScore: -0.1,
    discoveryFound: true,
    discoveryNote: null,
  });
  assertEquals(a, b);
});

Deno.test("crippled creature scores worse than baseline on its own data", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "discovery_at_scale_test_" });
  const dataDir = join(tmp, "data");
  ensureDirSync(dataDir);
  try {
    const baseline = buildLargeCreature({
      inputs: SMALL_CONFIG.inputs,
      hidden: SMALL_CONFIG.hidden,
      outputs: SMALL_CONFIG.outputs,
      density: SMALL_CONFIG.density,
      seed: SMALL_CONFIG.seed,
    });
    generateSyntheticData(baseline, dataDir, {
      totalRecords: 32,
      recordsPerFile: 32,
      seed: 99,
    });
    const raw = creatureAsRaw(baseline);
    injectDefects(raw, SMALL_CONFIG);
    const crippled = rawAsCreature(raw);
    crippled.validate();
    const baselineScore = (await baseline.scoreDir(dataDir, {})).score;
    const crippledScore = (await crippled.scoreDir(dataDir, {})).score;
    assertGreater(
      baselineScore,
      crippledScore,
      `baseline (${baselineScore}) should score better than crippled (${crippledScore})`,
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test({
  name: "runDiscoveryAtScaleDemo - completes end-to-end and writes a non-empty SVG (small config)",
  // Discovery loads a Rust FFI library that does not unload before the test
  // ends — disable the resource sanitiser for this end-to-end check.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Override defaults via a temporary config — we cannot pass it directly to
    // the runner (it always uses defaults), so we exercise the lower-level
    // pieces here. The full default-config run is exercised by run.sh.
    const result = await runDiscoveryAtScaleDemo(SMALL_CONFIG);
    assert(Number.isFinite(result.baselineScore), "baseline score must be finite");
    assert(Number.isFinite(result.crippledScore), "crippled score must be finite");
    assertGreater(
      result.baselineScore,
      result.crippledScore,
      "baseline should score better than crippled",
    );
    if (result.discoveredScore !== null) {
      assert(Number.isFinite(result.discoveredScore), "discovered score must be finite");
    }
    assertGreaterOrEqual(result.discoveryDurationMs, 0);
    // SVG must have been written under the working dir.
    assert(existsSync(".discovery-at-scale/output/discovery_at_scale.svg") === true);
    const svgBytes = Deno.statSync(".discovery-at-scale/output/discovery_at_scale.svg").size;
    assertGreater(svgBytes, 1000, "output SVG should be non-empty");
  },
});

/* ------------------------------------------------------------------ */
/*  Audit (#208, #304) — minimal-seed evolution + milestone summary    */
/* ------------------------------------------------------------------ */

Deno.test("buildAtScaleEvolveDirSummary maps an evolution result onto the summary record", () => {
  const summary = buildAtScaleEvolveDirSummary(
    {
      champion: new Creature(INPUT_COUNT, OUTPUT_COUNT),
      wallClockMs: 11_300,
      finalError: 0.0040,
      finalScore: 0.9960,
      generations: 186,
      seedNeuronCount: 9,
      seedSynapseCount: 18,
      finalNeuronCount: 14,
      finalSynapseCount: 32,
    },
    DEFAULT_AT_SCALE_EVOLUTION_CONFIG,
  );

  assertEquals(summary.finalError, 0.0040);
  assertEquals(summary.finalScore, 0.9960);
  assertEquals(summary.wallClockMs, 11_300);
  assertEquals(summary.generations, 186);
  assertEquals(summary.seedNeurons, 9);
  assertEquals(summary.seedSynapses, 18);
  assertEquals(summary.finalNeurons, 14);
  assertEquals(summary.finalSynapses, 32);
  assertEquals(summary.targetError, DEFAULT_AT_SCALE_EVOLUTION_CONFIG.targetError);
  assertEquals(summary.timeoutMinutes, DEFAULT_AT_SCALE_EVOLUTION_CONFIG.timeoutMinutes);
});

Deno.test(
  "renderEvolveDirSummarySvg of an at-scale summary surfaces seed-vs-final topology",
  () => {
    const summary = buildAtScaleEvolveDirSummary(
      {
        champion: new Creature(INPUT_COUNT, OUTPUT_COUNT),
        wallClockMs: 11_300,
        finalError: 0.0040,
        finalScore: 0.9960,
        generations: 186,
        seedNeuronCount: 9,
        seedSynapseCount: 18,
        finalNeuronCount: 14,
        finalSynapseCount: 32,
      },
      DEFAULT_AT_SCALE_EVOLUTION_CONFIG,
    );

    const svg = renderEvolveDirSummarySvg(summary, {
      title: "Discovery at Scale — evolveDir Run Summary",
    });
    assertStringIncludes(svg, "<svg");
    assertStringIncludes(svg, "Discovery at Scale");
    // Seed-vs-final topology counts surface as bar labels (the headline
    // visual for this demo per issue #304).
    assertStringIncludes(svg, ">9<");
    assertStringIncludes(svg, ">18<");
    assertStringIncludes(svg, ">14<");
    assertStringIncludes(svg, ">32<");
    // Wall-clock duration humanised (>= 1 second).
    assert(/\b\d+m \d+s\b|\b\d+s\b/.test(svg), "duration must be humanised");
  },
);

Deno.test("DEFAULT_AT_SCALE_EVOLUTION_CONFIG honours the audit's stop-condition rule", () => {
  // Issue #208 mandates targetError + timeoutMinutes <= 5 (or higher
  // with a documented justification — the default sticks to 5).
  assertGreater(DEFAULT_AT_SCALE_EVOLUTION_CONFIG.targetError, 0, "targetError must be positive");
  assertEquals(
    DEFAULT_AT_SCALE_EVOLUTION_CONFIG.timeoutMinutes,
    5,
    "timeoutMinutes must default to the issue #208 backstop",
  );
  assertGreater(
    DEFAULT_AT_SCALE_EVOLUTION_CONFIG.populationSize,
    0,
    "populationSize must be positive",
  );
  assertGreater(
    DEFAULT_AT_SCALE_EVOLUTION_CONFIG.maxIterations,
    0,
    "maxIterations must be positive",
  );
});

Deno.test("runMinimalSeedAtScaleEvolution rejects non-positive config values", async () => {
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const dataDir = Deno.makeTempDirSync({ prefix: "discovery_at_scale_test_" });
  try {
    let threw = false;
    try {
      await runMinimalSeedAtScaleEvolution(seed, dataDir, {
        targetError: 0,
        timeoutMinutes: 1,
        populationSize: 4,
        maxIterations: 1,
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
  "runMinimalSeedAtScaleEvolution captures milestone fields from a minimal seed",
  async () => {
    // Verifies the audit's telemetry contract under #304: starting from
    // `new Creature(INPUT_COUNT, OUTPUT_COUNT)`, the function captures
    // the milestone-summary fields from `evolveDir`'s return value
    // (final error / score, generations, wall-clock) and the seed +
    // final topology counts.
    const tmpDir = Deno.makeTempDirSync({ prefix: "discovery_at_scale_test_" });
    const dataDir = join(tmpDir, "data");
    ensureDirSync(dataDir);
    try {
      const reference = buildLargeCreature({
        inputs: INPUT_COUNT,
        hidden: REFERENCE_HIDDEN,
        outputs: OUTPUT_COUNT,
        density: REFERENCE_DENSITY,
        seed: REFERENCE_SEED,
      });
      generateSyntheticData(reference, dataDir, {
        totalRecords: 64,
        recordsPerFile: 64,
        seed: 42,
      });

      const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      const seedNeurons = seed.neurons.length;
      const seedSynapses = seed.synapses.length;

      const result = await runMinimalSeedAtScaleEvolution(seed, dataDir, {
        targetError: 0.001,
        timeoutMinutes: 1,
        populationSize: 8,
        maxIterations: 30,
        seed: 208,
      });

      assertEquals(result.seedNeuronCount, seedNeurons, "seed neuron count must be recorded");
      assertEquals(result.seedSynapseCount, seedSynapses, "seed synapse count must be recorded");
      assertGreater(result.generations, 0, "generations must be positive");
      assertGreater(result.finalNeuronCount, 0, "final neuron count must be positive");
      assertGreater(result.finalSynapseCount, 0, "final synapse count must be positive");
      assert(
        Number.isFinite(result.finalError),
        "finalError must be finite once evolution has progressed",
      );
      assert(
        Number.isFinite(result.finalScore),
        "finalScore must be finite once evolution has progressed",
      );
      assert(result.wallClockMs >= 0, "wallClockMs must be non-negative");
    } finally {
      Deno.removeSync(tmpDir, { recursive: true });
    }
  },
);

Deno.test("runMinimalSeedAtScaleEvolution leaves the passed-in creature as the champion", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "discovery_at_scale_test_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);
  try {
    const reference = buildLargeCreature({
      inputs: INPUT_COUNT,
      hidden: 8,
      outputs: OUTPUT_COUNT,
      density: 0.3,
      seed: 99,
    });
    generateSyntheticData(reference, dataDir, {
      totalRecords: 32,
      recordsPerFile: 32,
      seed: 99,
    });

    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const result = await runMinimalSeedAtScaleEvolution(seed, dataDir, {
      targetError: 0.001,
      timeoutMinutes: 1,
      populationSize: 4,
      maxIterations: 4,
      seed: 11,
    });
    // The champion must be the same JS object the caller passed in —
    // evolveDir mutates the creature in place.
    assertEquals(result.champion === seed, true, "champion must be the in-place creature");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("INPUT_COUNT and OUTPUT_COUNT are positive integers matching the runner seed", () => {
  // Audit acceptance: the source code passes only `input` and `output`
  // integers to NEAT-AI. Lock those constants in so a future refactor
  // cannot silently change them.
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
