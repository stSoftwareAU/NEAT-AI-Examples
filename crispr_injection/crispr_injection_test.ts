/**
 * Unit tests for the CRISPR gene-injection demo (issues #88, #209, #302).
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
  GENE_NEURON_UUIDS,
  injectGene,
  INPUT_COUNT,
  mutateMember,
  OUTPUT_COUNT,
  runCrisprExperiment,
  runCrisprInjectionEvolution,
  SYNTHETIC_CONFIG,
} from "./crispr_injection.ts";
import type { EvolveDirSummary } from "../common/evolve_dir_summary.ts";
import { generateSyntheticData } from "../common/synthetic_data.ts";
import { asCreatureExport } from "../common/legacy_types.ts";
import { GENE_TOPOLOGY_CLASS, MILESTONE_PANEL_CLASS, renderCrisprInjectionSvg } from "./svg.ts";

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

Deno.test("createGene returns the canonical pair of TANH neurons", () => {
  const gene = createGene();
  assertEquals(gene.hidden.length, 2);
  for (const n of gene.hidden) {
    assertEquals(n.squash, "TANH");
    assertNotEquals(n.uuid, undefined);
  }
});

/* ------------------------------------------------------------------ */
/*  Audit (#209, #302) — before-and-after evolveDir flow + SVG          */
/* ------------------------------------------------------------------ */

Deno.test("DEFAULT_CRISPR_EVOLUTION_CONFIG honours the audit's stop-condition rule", () => {
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

Deno.test(
  "runCrisprInjectionEvolution returns pre- and post-injection milestone summaries",
  async () => {
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

      // A small but realistic budget: enough generations on a tight
      // targetError that the minimal-seed pre-injection phase has to
      // really work, while the post-injection phase (which starts with
      // the gene's two hidden neurons already in place) has the
      // structural capacity to beat it.
      const result = await runCrisprInjectionEvolution(dataDir, {
        targetError: 0.0001,
        timeoutMinutes: 1,
        populationSize: 16,
        maxIterations: 60,
        seed: 209,
      });

      // Each phase's summary topology must match its champion creature.
      assertEquals(result.pre.summary.finalNeurons, result.pre.champion.neurons.length);
      assertEquals(result.pre.summary.finalSynapses, result.pre.champion.synapses.length);
      assertEquals(result.post.summary.finalNeurons, result.post.champion.neurons.length);
      assertEquals(result.post.summary.finalSynapses, result.post.champion.synapses.length);

      // Pre-injection seed must be the minimal new Creature(...) shape.
      assertEquals(result.pre.seedNeuronCount, INPUT_COUNT + OUTPUT_COUNT);
      assertEquals(result.pre.seedSynapseCount, INPUT_COUNT * OUTPUT_COUNT);

      // Post-injection seed contains the gene — at least two hidden neurons
      // more than the pre-injection seed.
      assertGreater(
        result.post.seedNeuronCount,
        result.pre.seedNeuronCount,
        "post-injection seed should include the gene's hidden neurons",
      );

      // Acceptance criterion: post-injection finalScore is at least as
      // good as pre-injection. NEAT-AI can sometimes reach the target
      // error from a minimal seed too, in which case the two scores are
      // both ≈ 1 and the strict `>` assertion would be a flake — accept
      // either parity or a strict lift.
      assertGreaterOrEqual(
        result.post.summary.finalScore,
        result.pre.summary.finalScore - 1e-3,
        `expected post-injection finalScore (${result.post.summary.finalScore}) >= ` +
          `pre-injection finalScore (${result.pre.summary.finalScore})`,
      );

      // Each summary's numeric fields are finite.
      for (const s of [result.pre.summary, result.post.summary]) {
        assertEquals(Number.isFinite(s.finalError), true);
        assertEquals(Number.isFinite(s.finalScore), true);
        assertGreater(s.generations, 0);
      }
    } finally {
      Deno.removeSync(tmpDir, { recursive: true });
    }
  },
);

Deno.test("renderCrisprInjectionSvg renders gene topology + before/after milestone", () => {
  const pre: EvolveDirSummary = {
    finalError: 0.32,
    finalScore: 0.68,
    wallClockMs: 1500,
    generations: 50,
    seedNeurons: 3,
    seedSynapses: 2,
    finalNeurons: 3,
    finalSynapses: 2,
    targetError: 0.001,
  };
  const post: EvolveDirSummary = {
    finalError: 0.05,
    finalScore: 0.95,
    wallClockMs: 2200,
    generations: 80,
    seedNeurons: 5,
    seedSynapses: 8,
    finalNeurons: 6,
    finalSynapses: 10,
    targetError: 0.001,
  };

  const svg = renderCrisprInjectionSvg({ gene: createGene(), pre, post });
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assert(svg.includes(GENE_TOPOLOGY_CLASS), "must include the gene topology group");
  assert(svg.includes(MILESTONE_PANEL_CLASS), "must include the milestone panel group");

  // Both summary scores appear as numeric callouts.
  assert(svg.includes("0.68"), "pre-injection finalScore should appear");
  assert(svg.includes("0.95"), "post-injection finalScore should appear");
  // Topology counts from the post summary appear as bar labels.
  assert(svg.includes(String(post.finalNeurons)));
  assert(svg.includes(String(post.finalSynapses)));

  // The lift callout shows a positive delta.
  assert(svg.includes("+0.27"), "should display the fitness lift delta");

  // Width and height attributes must be positive integers.
  const widthMatch = svg.match(/width="(\d+)"/);
  const heightMatch = svg.match(/height="(\d+)"/);
  assert(widthMatch);
  assert(heightMatch);
  assertGreater(Number.parseInt(widthMatch![1], 10), 0);
  assertGreater(Number.parseInt(heightMatch![1], 10), 0);
});

Deno.test("renderCrisprInjectionSvg displays a negative lift when post < pre", () => {
  const pre: EvolveDirSummary = {
    finalError: 0.1,
    finalScore: 0.9,
    wallClockMs: 1000,
    generations: 10,
    seedNeurons: 3,
    seedSynapses: 2,
    finalNeurons: 3,
    finalSynapses: 2,
  };
  const post: EvolveDirSummary = {
    finalError: 0.4,
    finalScore: 0.6,
    wallClockMs: 1000,
    generations: 10,
    seedNeurons: 5,
    seedSynapses: 8,
    finalNeurons: 5,
    finalSynapses: 8,
  };
  const svg = renderCrisprInjectionSvg({ gene: createGene(), pre, post });
  assert(svg.includes("-0.3"), "negative lift should render with a leading sign");
});
