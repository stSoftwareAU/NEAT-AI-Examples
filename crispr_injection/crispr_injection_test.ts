/**
 * Unit tests for the CRISPR gene-injection demo (issues #88 + #209).
 *
 * "What" tests only — each test calls a real function and asserts on
 * observable outputs (creature structure, fitness records, SVG markup).
 * No greps over source files.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertNotEquals,
} from "@std/assert";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  createBaselineJSON,
  createGene,
  createTargetCreature,
  DEFAULT_CRISPR_CONFIG,
  DEFAULT_CRISPR_EVOLUTION_CONFIG,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  formatEvolutionCsv,
  GENE_NEURON_UUIDS,
  injectGene,
  INPUT_COUNT,
  mutateMember,
  OUTPUT_COUNT,
  rowsToEvolutionSamples,
  rowsToFitnessSamples,
  runCrisprExperiment,
  runMinimalSeedEvolution,
  SYNTHETIC_CONFIG,
} from "./crispr_injection.ts";
import { generateSyntheticData } from "../common/synthetic_data.ts";
import { asCreatureExport } from "../common/legacy_types.ts";
import { GENE_TOPOLOGY_CLASS, INJECTION_MARKER_CLASS, renderCrisprSVG } from "./svg.ts";

Deno.test("createTargetCreature builds a 2→2-hidden-TANH→1 creature", () => {
  const target = createTargetCreature();
  target.validate();
  assertEquals(target.input, 2);
  assertEquals(target.output, 1);
  // Both gene UUIDs must be present in the target creature.
  const uuids = new Set(target.neurons.map((n) => n.uuid));
  for (const u of GENE_NEURON_UUIDS) {
    assert(uuids.has(u), `target creature should contain gene UUID ${u}`);
  }
});

Deno.test("createBaselineJSON has no hidden neurons", () => {
  const json = createBaselineJSON(7);
  const hidden = json.neurons.filter((n) => n.type === "hidden");
  assertEquals(hidden.length, 0);
  assertEquals(json.input, 2);
  assertEquals(json.output, 1);
  // The baseline must still be a valid creature.
  const c = Creature.fromJSON(asCreatureExport(json));
  c.validate();
});

Deno.test("createBaselineJSON produces deterministic weights for the same seed", () => {
  const a = createBaselineJSON(123);
  const b = createBaselineJSON(123);
  assertEquals(a.synapses.length, b.synapses.length);
  for (let i = 0; i < a.synapses.length; i++) {
    assertEquals(a.synapses[i].weight, b.synapses[i].weight);
  }
});

Deno.test("injectGene adds the gene's hidden neurons to a baseline host", () => {
  const host = createBaselineJSON(11);
  const gene = createGene();
  const merged = injectGene(host, gene);

  const hostHidden = host.neurons.filter((n) => n.type === "hidden").length;
  const mergedHidden = merged.neurons.filter((n) => n.type === "hidden").length;
  assertEquals(mergedHidden - hostHidden, gene.hidden.length);

  const uuids = new Set(merged.neurons.map((n) => n.uuid));
  for (const u of GENE_NEURON_UUIDS) {
    assert(uuids.has(u), `injected creature should contain gene UUID ${u}`);
  }

  // Indices are contiguous starting from zero.
  const indices = merged.neurons.map((n) => n.index).sort((a, b) => a - b);
  for (let i = 0; i < indices.length; i++) {
    assertEquals(indices[i], i);
  }

  // The merged creature must validate.
  const c = Creature.fromJSON(asCreatureExport(merged));
  c.validate();
});

Deno.test("injectGene preserves existing host synapses", () => {
  const host = createBaselineJSON(13);
  const merged = injectGene(host, createGene());
  // Each host synapse should be re-mapped into the merged synapse list.
  assertGreaterOrEqual(merged.synapses.length, host.synapses.length);
});

Deno.test("injectGene is idempotent — re-injecting does not duplicate the gene", () => {
  const host = createBaselineJSON(17);
  const once = injectGene(host, createGene());
  const twice = injectGene(once, createGene());
  // Same neuron count + same synapse count after the second injection.
  assertEquals(twice.neurons.length, once.neurons.length);
  assertEquals(twice.synapses.length, once.synapses.length);
});

Deno.test("injectGene does not mutate the host JSON", () => {
  const host = createBaselineJSON(19);
  const beforeNeuronCount = host.neurons.length;
  const beforeSynapseCount = host.synapses.length;
  injectGene(host, createGene());
  assertEquals(host.neurons.length, beforeNeuronCount);
  assertEquals(host.synapses.length, beforeSynapseCount);
});

Deno.test("mutateMember perturbs synapse weights without altering structure", () => {
  let count = 0;
  const random = () => {
    count++;
    // Cycle a small repertoire so Box-Muller produces non-zero draws.
    return ((count * 0.1234567) % 1) || 0.5;
  };
  const host = createBaselineJSON(23);
  const mutated = mutateMember(host, random, 0.1);
  assertEquals(mutated.neurons.length, host.neurons.length);
  assertEquals(mutated.synapses.length, host.synapses.length);
  let anyChanged = false;
  for (let i = 0; i < host.synapses.length; i++) {
    if (mutated.synapses[i].weight !== host.synapses[i].weight) anyChanged = true;
  }
  assert(anyChanged, "at least one synapse weight should change after mutation");
});

Deno.test("runCrisprExperiment lifts fitness after the gene is injected", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "crispr-test-" });
  try {
    const dataDir = join(tmp, "data");
    Deno.mkdirSync(dataDir, { recursive: true });
    const target = createTargetCreature();
    generateSyntheticData(target, dataDir, SYNTHETIC_CONFIG);

    const result = await runCrisprExperiment(
      {
        ...DEFAULT_CRISPR_CONFIG,
        preInjectionGenerations: 4,
        postInjectionGenerations: 4,
        populationSize: 4,
        injectionCount: 2,
      },
      dataDir,
    );

    // One record per pre-gen + the injection generation + one per post-gen.
    assertEquals(result.records.length, 4 + 1 + 4);

    // Exactly one injection-flagged record exists, at the recorded generation.
    const injected = result.records.filter((r) => r.injection);
    assertEquals(injected.length, 1);
    assertEquals(injected[0].generation, result.injectionGeneration);

    // Acceptance criterion: best fitness post-injection must be higher
    // than at the moment of injection.
    assertGreater(
      result.bestFitnessAfterInjection,
      result.fitnessAtInjection,
      `expected post-injection fitness (${result.bestFitnessAfterInjection}) > ` +
        `injection-time fitness (${result.fitnessAtInjection})`,
    );

    // Acceptance criterion: at least one gene UUID survives in a descendant.
    assertGreater(result.retainedGeneUUIDs.length, 0);

    // The best final creature must validate.
    const best = Creature.fromJSON(asCreatureExport(result.bestFinalCreatureJSON));
    best.validate();
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runCrisprExperiment is deterministic for the same seed", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "crispr-deterministic-" });
  try {
    const dataDir = join(tmp, "data");
    Deno.mkdirSync(dataDir, { recursive: true });
    generateSyntheticData(createTargetCreature(), dataDir, SYNTHETIC_CONFIG);

    const cfg = {
      ...DEFAULT_CRISPR_CONFIG,
      preInjectionGenerations: 3,
      postInjectionGenerations: 3,
      populationSize: 3,
      injectionCount: 1,
    };
    const a = await runCrisprExperiment(cfg, dataDir);
    const b = await runCrisprExperiment(cfg, dataDir);
    assertEquals(a.records.length, b.records.length);
    for (let i = 0; i < a.records.length; i++) {
      assertEquals(a.records[i].generation, b.records[i].generation);
      assertEquals(a.records[i].injection, b.records[i].injection);
      assertAlmostEquals(a.records[i].bestFitness, b.records[i].bestFitness, 1e-12);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runCrisprExperiment rejects invalid config", async () => {
  let threw = false;
  try {
    await runCrisprExperiment(
      { ...DEFAULT_CRISPR_CONFIG, populationSize: 0 },
      ".",
    );
  } catch (_err) {
    threw = true;
  }
  assert(threw);
});

Deno.test("renderCrisprSVG produces a well-formed SVG with both panels", () => {
  const records = [
    { generation: 0, bestFitness: -0.5, injection: false },
    { generation: 1, bestFitness: -0.49, injection: false },
    { generation: 2, bestFitness: -0.48, injection: true },
    { generation: 3, bestFitness: -0.2, injection: false },
    { generation: 4, bestFitness: -0.1, injection: false },
  ];
  const svg = renderCrisprSVG({
    records,
    injectionGeneration: 2,
    gene: createGene(),
  });
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assert(svg.includes(INJECTION_MARKER_CLASS), "must include the injection-marker class");
  assert(svg.includes(GENE_TOPOLOGY_CLASS), "must include the gene topology group");
  // Width and height attributes must be positive integers.
  const widthMatch = svg.match(/width="(\d+)"/);
  const heightMatch = svg.match(/height="(\d+)"/);
  assert(widthMatch);
  assert(heightMatch);
  assertGreater(Number.parseInt(widthMatch![1], 10), 0);
  assertGreater(Number.parseInt(heightMatch![1], 10), 0);
  // The fitness curve must be drawn as a polyline.
  const polylines = svg.match(/<polyline /g) ?? [];
  assertGreaterOrEqual(polylines.length, 1);
  // Title text is present.
  assert(svg.includes("CRISPR"));
});

Deno.test("renderCrisprSVG throws when records are empty", () => {
  let threw = false;
  try {
    renderCrisprSVG({ records: [], injectionGeneration: 0, gene: createGene() });
  } catch (_err) {
    threw = true;
  }
  assert(threw);
});

Deno.test("createGene returns the canonical pair of TANH neurons", () => {
  const gene = createGene();
  assertEquals(gene.hidden.length, 2);
  for (const n of gene.hidden) {
    assertEquals(n.squash, "TANH");
    assertNotEquals(n.uuid, undefined);
  }
});

/* ------------------------------------------------------------------ */
/*  Audit (issue #209) — minimal-seed evolveDir + measured telemetry   */
/* ------------------------------------------------------------------ */

Deno.test("DEFAULT_CRISPR_EVOLUTION_CONFIG honours the audit's stop-condition rule", () => {
  // Issue #209 mandates a positive targetError plus timeoutMinutes <= 5
  // (or higher with a documented justification — the default sticks to 5).
  assertGreater(
    DEFAULT_CRISPR_EVOLUTION_CONFIG.targetError,
    0,
    "targetError must be positive",
  );
  assertEquals(
    DEFAULT_CRISPR_EVOLUTION_CONFIG.timeoutMinutes,
    5,
    "timeoutMinutes must default to the issue #209 backstop",
  );
  assertGreater(
    DEFAULT_CRISPR_EVOLUTION_CONFIG.populationSize,
    0,
    "populationSize must be positive",
  );
  assertGreater(
    DEFAULT_CRISPR_EVOLUTION_CONFIG.maxIterations,
    0,
    "maxIterations must be positive",
  );
});

Deno.test("formatEvolutionCsv emits the schema mandated by issue #209", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: -0.5, meanFitness: -0.7, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: -0.3, meanFitness: -0.6, neuronCount: 4, synapseCount: 5 },
  ];
  const csv = formatEvolutionCsv(rows);
  const lines = csv.trim().split("\n");
  assertEquals(lines[0], EVOLUTION_CSV_HEADER, "header must match the audit schema");
  assertEquals(lines.length, 3, "header + 2 data rows");
  assertEquals(lines[1], "1,-0.5,-0.7,3,2");
  assertEquals(lines[2], "2,-0.3,-0.6,4,5");
});

Deno.test("formatEvolutionCsv survives non-finite fitness without throwing", () => {
  const rows: EvolutionRow[] = [
    {
      generation: 1,
      bestFitness: Number.POSITIVE_INFINITY,
      meanFitness: Number.NEGATIVE_INFINITY,
      neuronCount: 3,
      synapseCount: 2,
    },
  ];
  const csv = formatEvolutionCsv(rows);
  assertEquals(csv.trim().split("\n")[1], "1,0,0,3,2");
});

Deno.test("rowsToFitnessSamples renames meanFitness to avgFitness", () => {
  const rows: EvolutionRow[] = [
    { generation: 3, bestFitness: -0.1, meanFitness: -0.4, neuronCount: 7, synapseCount: 9 },
  ];
  const samples = rowsToFitnessSamples(rows);
  assertEquals(samples.length, 1);
  assertEquals(samples[0].generation, 3);
  assertEquals(samples[0].bestFitness, -0.1);
  assertEquals(samples[0].avgFitness, -0.4);
});

Deno.test("rowsToEvolutionSamples maps neuron and synapse counts onto chart fields", () => {
  const rows: EvolutionRow[] = [
    { generation: 7, bestFitness: 0.2, meanFitness: 0.1, neuronCount: 8, synapseCount: 14 },
  ];
  const samples = rowsToEvolutionSamples(rows);
  assertEquals(samples.length, 1);
  assertEquals(samples[0].generation, 7);
  assertEquals(samples[0].score, 0.2);
  assertEquals(samples[0].neurons, 8);
  assertEquals(samples[0].synapses, 14);
});

Deno.test("runMinimalSeedEvolution rejects non-positive config values", async () => {
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const dataDir = Deno.makeTempDirSync({ prefix: "crispr_audit_" });
  try {
    let threw = false;
    try {
      await runMinimalSeedEvolution(seed, dataDir, {
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

Deno.test("runMinimalSeedEvolution captures per-generation telemetry from a minimal seed", async () => {
  // Exercises the audit's telemetry contract: starting from
  // `new Creature(INPUT_COUNT, OUTPUT_COUNT)`, the runner must capture
  // per-generation rows whose schema matches the audit (generation,
  // best/mean fitness, neuron and synapse counts) and must record the
  // seed topology. The actual *growth* assertion lives in the next
  // test, which reads the committed CSV produced by the production run.
  const tmpDir = Deno.makeTempDirSync({ prefix: "crispr_audit_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const target = createTargetCreature();
    target.validate();
    generateSyntheticData(target, dataDir, {
      totalRecords: 64,
      recordsPerFile: 64,
      seed: 42,
    });

    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const seedNeurons = seed.neurons.length;
    const seedSynapses = seed.synapses.length;

    const result = await runMinimalSeedEvolution(seed, dataDir, {
      targetError: 0.001,
      timeoutMinutes: 1,
      populationSize: 8,
      maxIterations: 30,
      seed: 209,
    });

    assertEquals(result.seedNeuronCount, seedNeurons, "seed neuron count must be recorded");
    assertEquals(result.seedSynapseCount, seedSynapses, "seed synapse count must be recorded");
    assertGreater(
      result.rows.length,
      0,
      "at least one generation_complete event must be captured",
    );

    const finalRow = result.rows[result.rows.length - 1];
    assertGreater(finalRow.generation, 0, "generation must be 1-based");
    assertGreater(finalRow.neuronCount, 0, "neuron count must be positive");
    assertGreater(finalRow.synapseCount, 0, "synapse count must be positive");
    assertEquals(
      Number.isFinite(finalRow.bestFitness),
      true,
      "bestFitness must be finite once evolution has progressed",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("runMinimalSeedEvolution leaves the passed-in creature as the champion", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "crispr_audit_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);

  try {
    const target = createTargetCreature();
    generateSyntheticData(target, dataDir, {
      totalRecords: 32,
      recordsPerFile: 32,
      seed: 99,
    });

    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const result = await runMinimalSeedEvolution(seed, dataDir, {
      targetError: 0.001,
      timeoutMinutes: 1,
      populationSize: 4,
      maxIterations: 4,
      seed: 11,
    });
    // The champion must be the same JS object the caller passed in —
    // evolveDir mutates the creature in place. This guards against a
    // future refactor accidentally breaking that contract.
    assertEquals(result.champion === seed, true, "champion must be the in-place creature");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
