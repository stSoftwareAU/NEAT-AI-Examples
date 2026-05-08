/**
 * CRISPR Gene Injection Example (issue #88).
 *
 * Demonstrates a structural intervention that is unique to NEAT-style
 * neuroevolution: a hand-crafted "edit gene" — a small subgraph of
 * neurons and synapses with known-good behaviour — is spliced directly
 * into a stalled population, then evolution continues. Random weight
 * mutation alone cannot construct this structure because the missing
 * topology has no path to follow; CRISPR-style injection bypasses
 * that gradient by inserting the structure wholesale.
 *
 * The runner walks a deterministic synthetic task:
 *
 *   1. Build a target creature whose two TANH hidden neurons together
 *      compute a non-linear function of two inputs.
 *   2. Generate synthetic training data from the target.
 *   3. Build a baseline population whose members have *no* hidden
 *      neurons — they cannot capture the non-linearity, so a simple
 *      perturb-and-keep evolution loop quickly plateaus.
 *   4. Inject the hand-crafted gene into the top N members of the
 *      stalled population, replacing them with gene-bearing variants.
 *   5. Resume the same evolution loop and watch fitness lift sharply.
 *
 * The deterministic perturbation loop keeps the example fast and
 * reproducible without delegating to the full NEAT evolver — every
 * generation's best fitness is recorded so the rendered SVG shows the
 * stall, the injection marker, and the post-injection lift.
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, CreatureUtil, safeWriteJson } from "@stsoftware/neat-ai";

import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  asCreatureExport,
  type LegacyCreatureJSON,
  type LegacyNeuron,
  type LegacySynapse,
} from "../common/legacy_types.ts";

export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 96,
  recordsPerFile: 96,
  seed: 88008800,
};

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/crispr_injection.svg";

/** UUIDs that identify the hand-crafted edit gene's hidden neurons. */
export const GENE_NEURON_UUIDS = ["gene-hidden-0", "gene-hidden-1"] as const;

/**
 * A hand-crafted "edit gene": a structural fragment with hidden neurons
 * and the synapses needed to wire them into a host creature. The gene
 * carries the input-side and output-side weights it expects to be
 * spliced with, so injection is reversible and self-contained.
 */
export interface InjectedGene {
  /** Hidden neurons that make up the gene (in injection order). */
  hidden: readonly LegacyNeuron[];
  /** Synapses connecting host inputs into the gene. */
  inputSynapses: readonly { fromInputIndex: number; toUUID: string; weight: number }[];
  /** Synapses connecting the gene to host outputs. */
  outputSynapses: readonly { fromUUID: string; toOutputUUID: string; weight: number }[];
  /** Synapses internal to the gene (between gene neurons). */
  internalSynapses: readonly { fromUUID: string; toUUID: string; weight: number }[];
}

/** Configuration options for {@link runCrisprExperiment}. */
export interface CrisprConfig {
  /** Random seed driving mutation and population selection. */
  seed: number;
  /** Generations to evolve before injecting the gene. */
  preInjectionGenerations: number;
  /** Generations to evolve after injecting the gene. */
  postInjectionGenerations: number;
  /** Number of population members to splice the gene into. */
  injectionCount: number;
  /** Population size held constant across generations. */
  populationSize: number;
  /** Standard deviation of each weight perturbation. */
  mutationStrength: number;
}

/** A per-generation fitness snapshot. */
export interface FitnessRecord {
  /** Zero-indexed generation number. */
  generation: number;
  /** Best score observed across the population at this generation. */
  bestFitness: number;
  /** True for the generation that received the gene injection. */
  injection: boolean;
}

/** Result of a single CRISPR experiment. */
export interface CrisprResult {
  /** Per-generation fitness records (length === pre + post + 1). */
  records: FitnessRecord[];
  /** The generation index at which injection occurred. */
  injectionGeneration: number;
  /** Best fitness recorded at the moment of injection. */
  fitnessAtInjection: number;
  /** Best fitness recorded after injection (max across post records). */
  bestFitnessAfterInjection: number;
  /** UUIDs from the injected gene that survive in the final population. */
  retainedGeneUUIDs: string[];
  /** The final population's best member, exported. */
  bestFinalCreatureJSON: LegacyCreatureJSON;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_CRISPR_CONFIG: CrisprConfig = {
  seed: 0xcafebabe,
  preInjectionGenerations: 8,
  postInjectionGenerations: 8,
  injectionCount: 3,
  populationSize: 6,
  mutationStrength: 0.15,
};

/**
 * Builds the target creature whose two TANH hidden neurons together
 * compute a non-linear function the baseline (no hidden) cannot match.
 * Synthetic training data is generated from this creature's outputs.
 */
export function createTargetCreature(): Creature {
  const json: LegacyCreatureJSON = {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },

      // The "gene" — hidden neurons we will later inject into a baseline.
      // Big weights push the TANH neurons into saturation, so the target
      // output behaves like an XOR-flavoured discriminator the baseline
      // cannot mimic with a pair of linear input→output synapses.
      {
        type: "hidden",
        squash: "TANH",
        index: 2,
        bias: 0.5,
        uuid: GENE_NEURON_UUIDS[0],
      },
      {
        type: "hidden",
        squash: "TANH",
        index: 3,
        bias: -0.5,
        uuid: GENE_NEURON_UUIDS[1],
      },

      { type: "output", squash: "LOGISTIC", index: 4, bias: 0, uuid: "output-0" },
    ],
    synapses: [
      { from: 0, to: 2, weight: 4.0 },
      { from: 1, to: 2, weight: -3.5 },
      { from: 0, to: 3, weight: -3.0 },
      { from: 1, to: 3, weight: 3.5 },
      { from: 2, to: 4, weight: 5.0 },
      { from: 3, to: 4, weight: 5.0 },
    ],
    input: 2,
    output: 1,
  };
  return Creature.fromJSON(asCreatureExport(json));
}

/**
 * Builds the baseline creature: 2 inputs wired straight to the output.
 * Without hidden capacity this creature cannot fit the target's non-linearity,
 * so a perturbation-only evolution loop will plateau quickly.
 */
export function createBaselineJSON(seed: number): LegacyCreatureJSON {
  const random = createDeterministicRandom(seed);
  return {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "output", squash: "LOGISTIC", index: 2, bias: 0, uuid: "output-0" },
    ],
    synapses: [
      { from: 0, to: 2, weight: random() * 0.6 - 0.3 },
      { from: 1, to: 2, weight: random() * 0.6 - 0.3 },
    ],
    input: 2,
    output: 1,
  };
}

/**
 * Returns the hand-crafted edit gene: two TANH hidden neurons plus the
 * input/output synapses that splice them into a host creature.
 */
export function createGene(): InjectedGene {
  return {
    hidden: [
      {
        type: "hidden",
        squash: "TANH",
        index: 0, // Re-indexed during injection.
        bias: 0.5,
        uuid: GENE_NEURON_UUIDS[0],
      },
      {
        type: "hidden",
        squash: "TANH",
        index: 0,
        bias: -0.5,
        uuid: GENE_NEURON_UUIDS[1],
      },
    ],
    inputSynapses: [
      { fromInputIndex: 0, toUUID: GENE_NEURON_UUIDS[0], weight: 4.0 },
      { fromInputIndex: 1, toUUID: GENE_NEURON_UUIDS[0], weight: -3.5 },
      { fromInputIndex: 0, toUUID: GENE_NEURON_UUIDS[1], weight: -3.0 },
      { fromInputIndex: 1, toUUID: GENE_NEURON_UUIDS[1], weight: 3.5 },
    ],
    outputSynapses: [
      { fromUUID: GENE_NEURON_UUIDS[0], toOutputUUID: "output-0", weight: 5.0 },
      { fromUUID: GENE_NEURON_UUIDS[1], toOutputUUID: "output-0", weight: 5.0 },
    ],
    internalSynapses: [],
  };
}

/**
 * Splices the gene's hidden neurons and synapses into the host JSON.
 *
 * Returns a new {@link LegacyCreatureJSON} — the input is not mutated.
 * The gene's neurons are inserted between the host's inputs and outputs;
 * indices are recomputed so `Creature.fromJSON` accepts the result.
 *
 * If a gene UUID already exists in the host (idempotent re-injection)
 * the duplicate is skipped so injection can safely run twice.
 */
export function injectGene(host: LegacyCreatureJSON, gene: InjectedGene): LegacyCreatureJSON {
  const existingUUIDs = new Set(host.neurons.map((n) => n.uuid));

  const inputs = host.neurons.filter((n) => n.type === "input");
  const outputs = host.neurons.filter((n) => n.type === "output");
  const hiddenHost = host.neurons.filter((n) => n.type === "hidden");
  const newGeneNeurons = gene.hidden.filter((n) => !existingUUIDs.has(n.uuid));

  const merged: LegacyNeuron[] = [
    ...inputs.map((n) => ({ ...n })),
    ...hiddenHost.map((n) => ({ ...n })),
    ...newGeneNeurons.map((n) => ({ ...n })),
    ...outputs.map((n) => ({ ...n })),
  ];

  // Reindex neurons to a contiguous run.
  merged.forEach((n, i) => {
    n.index = i;
  });

  const uuidToIndex = new Map<string, number>();
  for (const n of merged) uuidToIndex.set(n.uuid, n.index);

  // Translate host synapses through the new index map (uuids are stable).
  const oldIndexToUUID = new Map<number, string>();
  for (const n of host.neurons) oldIndexToUUID.set(n.index, n.uuid);

  const synapses: LegacySynapse[] = [];
  for (const s of host.synapses) {
    const fromUUID = oldIndexToUUID.get(s.from);
    const toUUID = oldIndexToUUID.get(s.to);
    if (fromUUID === undefined || toUUID === undefined) continue;
    const fromIdx = uuidToIndex.get(fromUUID);
    const toIdx = uuidToIndex.get(toUUID);
    if (fromIdx === undefined || toIdx === undefined) continue;
    synapses.push({ from: fromIdx, to: toIdx, weight: s.weight });
  }

  // Add gene synapses, deduplicating against any host edges already present.
  const seen = new Set(synapses.map((s) => `${s.from}->${s.to}`));
  const addEdge = (from: number, to: number, weight: number) => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    synapses.push({ from, to, weight });
  };

  for (const s of gene.inputSynapses) {
    const toIdx = uuidToIndex.get(s.toUUID);
    if (toIdx === undefined) continue;
    addEdge(s.fromInputIndex, toIdx, s.weight);
  }
  for (const s of gene.internalSynapses) {
    const fromIdx = uuidToIndex.get(s.fromUUID);
    const toIdx = uuidToIndex.get(s.toUUID);
    if (fromIdx === undefined || toIdx === undefined) continue;
    addEdge(fromIdx, toIdx, s.weight);
  }
  for (const s of gene.outputSynapses) {
    const fromIdx = uuidToIndex.get(s.fromUUID);
    const toIdx = uuidToIndex.get(s.toOutputUUID);
    if (fromIdx === undefined || toIdx === undefined) continue;
    addEdge(fromIdx, toIdx, s.weight);
  }

  return {
    neurons: merged,
    synapses,
    input: host.input,
    output: host.output,
  };
}

/** Box-Muller standard-normal sample. */
function gaussian(random: () => number): number {
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Returns a clone of {@link member} with each synapse weight perturbed by a
 * Gaussian draw of standard deviation {@link mutationStrength}. The host JSON
 * is not modified.
 */
export function mutateMember(
  member: LegacyCreatureJSON,
  random: () => number,
  mutationStrength: number,
): LegacyCreatureJSON {
  return {
    ...member,
    neurons: member.neurons.map((n) => ({ ...n })),
    synapses: member.synapses.map((s) => ({
      ...s,
      weight: s.weight + gaussian(random) * mutationStrength,
    })),
  };
}

/**
 * Score a JSON creature against the supplied training directory.
 * Constructs a fresh {@link Creature} so weights from {@link mutateMember}
 * propagate through to the scorer.
 */
export async function scoreMember(member: LegacyCreatureJSON, dataDir: string): Promise<number> {
  const creature = Creature.fromJSON(asCreatureExport(member));
  creature.validate();
  const result = await creature.scoreDir(dataDir, {});
  return result.score;
}

/**
 * Run one (mu + lambda)-style step: keep the elite, fill the rest with
 * mutated copies of the elite, score everyone, return scores plus the
 * updated population sorted best-first.
 */
async function evolveOneGeneration(
  population: LegacyCreatureJSON[],
  dataDir: string,
  random: () => number,
  mutationStrength: number,
): Promise<{ population: LegacyCreatureJSON[]; bestScore: number }> {
  const scored: { member: LegacyCreatureJSON; score: number }[] = [];
  for (const m of population) {
    const score = await scoreMember(m, dataDir);
    scored.push({ member: m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const elite = scored[0].member;
  const next: LegacyCreatureJSON[] = [elite];
  while (next.length < population.length) {
    next.push(mutateMember(elite, random, mutationStrength));
  }
  return { population: next, bestScore: scored[0].score };
}

/**
 * Run the full CRISPR experiment: build a baseline population, evolve
 * it until fitness plateaus, splice in the hand-crafted gene, and
 * continue evolving. Returns per-generation fitness records plus the
 * subset of gene UUIDs that survive in the final population.
 */
export async function runCrisprExperiment(
  config: CrisprConfig,
  dataDir: string,
): Promise<CrisprResult> {
  if (config.populationSize <= 0) {
    throw new Error(`populationSize must be positive, got ${config.populationSize}`);
  }
  if (config.injectionCount < 0 || config.injectionCount > config.populationSize) {
    throw new Error(
      `injectionCount must lie in [0, ${config.populationSize}], got ${config.injectionCount}`,
    );
  }
  if (config.preInjectionGenerations < 0 || config.postInjectionGenerations < 0) {
    throw new Error("generation counts must be non-negative");
  }

  const random = createDeterministicRandom(config.seed);
  let population: LegacyCreatureJSON[] = [];
  for (let i = 0; i < config.populationSize; i++) {
    population.push(createBaselineJSON(config.seed + i + 1));
  }

  const records: FitnessRecord[] = [];

  // Pre-injection evolution — expected to plateau quickly.
  for (let g = 0; g < config.preInjectionGenerations; g++) {
    const result = await evolveOneGeneration(
      population,
      dataDir,
      random,
      config.mutationStrength,
    );
    population = result.population;
    records.push({ generation: g, bestFitness: result.bestScore, injection: false });
  }

  // CRISPR injection: splice the gene into the top N members.
  const gene = createGene();
  for (let i = 0; i < config.injectionCount && i < population.length; i++) {
    population[i] = injectGene(population[i], gene);
  }

  // Score the post-injection generation immediately so the marker has data.
  const injectionGen = config.preInjectionGenerations;
  const scoredInjected: { member: LegacyCreatureJSON; score: number }[] = [];
  for (const m of population) {
    scoredInjected.push({ member: m, score: await scoreMember(m, dataDir) });
  }
  scoredInjected.sort((a, b) => b.score - a.score);
  population = scoredInjected.map((s) => s.member);
  records.push({
    generation: injectionGen,
    bestFitness: scoredInjected[0].score,
    injection: true,
  });

  // Post-injection evolution — the gene's structure now has weights to tune.
  for (let g = 0; g < config.postInjectionGenerations; g++) {
    const result = await evolveOneGeneration(
      population,
      dataDir,
      random,
      config.mutationStrength,
    );
    population = result.population;
    records.push({
      generation: injectionGen + 1 + g,
      bestFitness: result.bestScore,
      injection: false,
    });
  }

  const fitnessAtInjection = records[injectionGen].bestFitness;
  const post = records.slice(injectionGen + 1);
  const bestFitnessAfterInjection = post.length > 0
    ? Math.max(...post.map((r) => r.bestFitness))
    : fitnessAtInjection;

  // Find the elite (still index 0 after evolveOneGeneration sorts) and
  // see which gene UUIDs survived in the final population.
  const finalUUIDs = new Set<string>();
  for (const m of population) {
    for (const n of m.neurons) finalUUIDs.add(n.uuid);
  }
  const retainedGeneUUIDs = GENE_NEURON_UUIDS.filter((u) => finalUUIDs.has(u));

  return {
    records,
    injectionGeneration: injectionGen,
    fitnessAtInjection,
    bestFitnessAfterInjection,
    retainedGeneUUIDs,
    bestFinalCreatureJSON: population[0],
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 CRISPR Gene Injection Example");
  console.log("");

  const { dataDir, creaturesDir, outputDir } = setupWorkingDirs(".synthetic-crispr-injection");

  // Step 1: Build target + baseline.
  console.log("📦 Step 1: Building target creature and baseline population...");
  const target = createTargetCreature();
  CreatureUtil.makeUUID(target);
  await safeWriteJson(join(creaturesDir, "target.json"), target.exportJSON());

  // Step 2: Generate synthetic training data.
  console.log("\n📊 Step 2: Generating synthetic training data...");
  generateSyntheticData(target, dataDir, SYNTHETIC_CONFIG);

  // Step 3: Run the CRISPR experiment.
  console.log("\n🧪 Step 3: Running pre-injection evolution + injection + post-injection...");
  const result = await runCrisprExperiment(DEFAULT_CRISPR_CONFIG, dataDir);
  console.log(`   Generations recorded: ${result.records.length}`);
  console.log(`   Injection generation: ${result.injectionGeneration}`);
  console.log(`   Fitness at injection:        ${result.fitnessAtInjection.toPrecision(6)}`);
  console.log(`   Best fitness post-injection: ${result.bestFitnessAfterInjection.toPrecision(6)}`);
  console.log(`   Retained gene UUIDs: ${result.retainedGeneUUIDs.join(", ") || "(none)"}`);

  // Step 4: Persist the gene topology and the best post-injection creature.
  const geneCreatureJSON = injectGene(createBaselineJSON(0), createGene());
  await safeWriteJson(join(creaturesDir, "gene.json"), geneCreatureJSON);
  await safeWriteJson(join(creaturesDir, "best.json"), result.bestFinalCreatureJSON);

  // Step 5: Render the SVG.
  const { renderCrisprSVG } = await import("./svg.ts");
  const svg = renderCrisprSVG({
    records: result.records,
    injectionGeneration: result.injectionGeneration,
    gene: createGene(),
  });

  const outputSvgPath = join(outputDir, "crispr_injection.svg");
  await Deno.writeTextFile(outputSvgPath, svg);
  console.log(`\n🖼️  Wrote run output ${outputSvgPath}`);

  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote committed screenshot ${SCREENSHOT_PATH}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
