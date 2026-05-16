/**
 * CRISPR Gene Injection Example — minimal-seed evolution + before/after
 * milestone summary (audit issue #209, telemetry simplified under #302).
 *
 * The original demo built a baseline population with no hidden neurons,
 * ran a deterministic perturb-and-keep loop until fitness plateaued,
 * spliced a hand-crafted "edit gene" (two TANH hidden neurons + their
 * synapses) into the top members, and continued the loop. That helper —
 * {@link runCrisprExperiment} — is retained as an exported utility and
 * is still exercised by the test suite so the gene-splicing primitive
 * (`injectGene`, `mutateMember`, `createGene`, `createBaselineJSON`,
 * `createTargetCreature`) keeps its contract.
 *
 * Under #209 the runner was rewired so the published evolution genuinely
 * *learns* the network structure from a minimal NEAT-AI seed; under
 * #302 the per-generation telemetry hook was removed in favour of
 * NEAT-AI's milestone-only telemetry surface. The runner now makes two
 * `Creature.evolveDir(...)` calls — one before injection from a minimal
 * seed, and a second after injecting the hand-crafted gene into the
 * pre-injection champion. The "fitness lift" narrative is preserved
 * from the post-vs-pre {@link EvolveDirSummary} deltas, not from
 * per-generation rows.
 *
 * Usage:
 *   ./crispr_injection/run.sh
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  CreatureUtil,
  type NeatOptions,
  safeWriteJson,
} from "@stsoftware/neat-ai";

import { type EvolveDirSummary } from "../common/evolve_dir_summary.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  asCreatureExport,
  type LegacyCreatureJSON,
  type LegacyNeuron,
  type LegacySynapse,
} from "../common/legacy_types.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-crispr-injection";

/** Number of input neurons fed to the NEAT-AI seed. Matches the target creature. */
export const INPUT_COUNT = 2;

/** Number of output neurons fed to the NEAT-AI seed. Matches the target creature. */
export const OUTPUT_COUNT = 1;

/** Combined gene-topology + before/after milestone SVG path. */
export const SCREENSHOT_PATH = "docs/screenshots/crispr_injection.svg";

/** Configuration for the synthetic training set (inputs only — labels come from the target). */
export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 256,
  recordsPerFile: 128,
  seed: 88008800,
};

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

/** Sensible defaults for the legacy demonstration runner. */
export const DEFAULT_CRISPR_CONFIG: CrisprConfig = {
  seed: 0xcafebabe,
  preInjectionGenerations: 8,
  postInjectionGenerations: 8,
  injectionCount: 3,
  populationSize: 6,
  mutationStrength: 0.15,
};

/** Configuration for the audit-compliant minimal-seed evolution run. */
export interface CrisprEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /** Wall-clock backstop in minutes (bumped to 15 for the Refresh-2026-05 re-evolution under #373). */
  timeoutMinutes: number;
  /** NEAT population size — small enough for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /** RNG seed forwarded to NEAT-AI for deterministic-ish runs. */
  seed: number;
}

/**
 * Defaults tuned so each evolution phase converges via `targetError`
 * well inside the 15-minute backstop on a developer machine while still
 * showing visible neuron / synapse growth from the minimal seed. The
 * backstop was bumped from 5 → 15 minutes for the Refresh-2026-05
 * re-evolution under issue #373; in practice both phases still exit
 * via `targetError` long before the wall-clock cap fires.
 */
export const DEFAULT_CRISPR_EVOLUTION_CONFIG: CrisprEvolutionConfig = {
  targetError: 0.000001,
  timeoutMinutes: 15,
  populationSize: 32,
  maxIterations: 30000,
  seed: 209209,
};

/** Result of a single phase of {@link runCrisprInjectionEvolution}. */
export interface CrisprPhaseResult {
  /** The creature mutated in place by `evolveDir`. */
  champion: Creature;
  /** Milestone summary captured from the `evolveDir` call. */
  summary: EvolveDirSummary;
  /** Total wall-clock time of this phase, in milliseconds. */
  wallClockMs: number;
  /** Final per-record error returned by `evolveDir`. */
  finalError: number;
  /** Generations completed in this phase. */
  generations: number;
  /** Initial neuron count of this phase's seed (before evolution). */
  seedNeuronCount: number;
  /** Initial synapse count of this phase's seed (before evolution). */
  seedSynapseCount: number;
  /** True when the phase ended because `targetError` was reached. */
  solved: boolean;
}

/** Combined result of the before-and-after CRISPR injection demo. */
export interface CrisprInjectionResult {
  /** Pre-injection phase, evolved from a minimal seed. */
  pre: CrisprPhaseResult;
  /** Post-injection phase, evolved after splicing the gene in. */
  post: CrisprPhaseResult;
  /** The post-injection champion creature. */
  champion: Creature;
}

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

      // The "gene" — hidden neurons we later inject into a host.
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
 * Gaussian draw of standard deviation {@link mutationStrength}.
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
 * Legacy CRISPR experiment helper retained for backwards compatibility.
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

/* ------------------------------------------------------------------ */
/*  Audit-compliant before/after evolveDir flow                        */
/* ------------------------------------------------------------------ */

/**
 * Run a single phase of NEAT-AI evolution from `seed` against `dataDir`
 * and return a milestone summary. The seed is mutated in place.
 */
async function runEvolveDirPhase(
  seed: Creature,
  dataDir: string,
  config: CrisprEvolutionConfig,
  seedOffset = 0,
): Promise<CrisprPhaseResult> {
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");
  if (config.maxIterations <= 0) throw new Error("maxIterations must be positive");

  const seedNeuronCount = seed.neurons.length;
  const seedSynapseCount = seed.synapses.length;
  const start = Date.now();

  const neatOptions: NeatOptions = {
    seed: config.seed + seedOffset,
    populationSize: config.populationSize,
    iterations: config.maxIterations,
    targetError: config.targetError,
    timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
    // No feedbackLoop key → engine treats the run as forward-only.
    costOfGrowth: 0,
    mutationRate: 0.6,
    mutationAmount: 3,
    verbose: false,
    log: 0,
    threads: 1,
  };

  const result = await seed.evolveDir(dataDir, neatOptions);
  const wallClockMs = Date.now() - start;

  const finalError = Number.isFinite(result.error) ? result.error : 0;
  const finalScore = Number.isFinite(result.score) ? result.score : 0;
  const generations = Math.max(1, result.generation ?? 1);
  const solved = finalError <= config.targetError;

  const summary: EvolveDirSummary = {
    finalError,
    finalScore,
    wallClockMs,
    generations,
    seedNeurons: seedNeuronCount,
    seedSynapses: seedSynapseCount,
    finalNeurons: seed.neurons.length,
    finalSynapses: seed.synapses.length,
    targetError: config.targetError,
    timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
  };

  return {
    champion: seed,
    summary,
    wallClockMs,
    finalError,
    generations,
    seedNeuronCount,
    seedSynapseCount,
    solved,
  };
}

/**
 * Run the CRISPR injection demo end-to-end:
 *
 *   1. Phase 1 — evolve a minimal `new Creature(INPUT_COUNT, OUTPUT_COUNT)`
 *      seed via `evolveDir` until either `targetError` is reached or
 *      `maxIterations` is exhausted (no gene yet).
 *   2. Splice the hand-crafted edit gene into a JSON snapshot of the
 *      pre-injection champion.
 *   3. Phase 2 — evolve the spliced creature with a second `evolveDir`
 *      call. The post-injection summary's `finalScore` should exceed
 *      the pre-injection summary's, demonstrating the "fitness lift"
 *      the example is built around.
 */
export async function runCrisprInjectionEvolution(
  dataDir: string,
  config: CrisprEvolutionConfig = DEFAULT_CRISPR_EVOLUTION_CONFIG,
): Promise<CrisprInjectionResult> {
  const preSeed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const pre = await runEvolveDirPhase(preSeed, dataDir, config, 0);

  // Splice the gene into the pre-injection champion (via its JSON form
  // so the gene's UUID-keyed primitives keep their contract) and feed
  // the result back into a fresh `Creature` for the second phase.
  const preChampionJSON = legacyJSONFromCreature(pre.champion);
  const injectedJSON = injectGene(preChampionJSON, createGene());
  const injectedCreature = Creature.fromJSON(asCreatureExport(injectedJSON));
  injectedCreature.validate();

  const post = await runEvolveDirPhase(injectedCreature, dataDir, config, 1);

  return { pre, post, champion: post.champion };
}

/**
 * Best-effort projection of a live {@link Creature} into the
 * {@link LegacyCreatureJSON} shape consumed by {@link injectGene}.
 * Uses the creature's neuron/synapse arrays so weights / squashes /
 * biases / UUIDs survive the round-trip.
 */
function legacyJSONFromCreature(creature: Creature): LegacyCreatureJSON {
  const neurons: LegacyNeuron[] = creature.neurons.map((n, i) => ({
    type: n.type as LegacyNeuron["type"],
    squash: n.squash,
    index: i,
    bias: n.bias,
    uuid: n.uuid ?? `auto-${i}`,
  }));
  const synapses: LegacySynapse[] = creature.synapses.map((s) => ({
    from: s.from,
    to: s.to,
    weight: s.weight,
  }));
  return {
    neurons,
    synapses,
    input: creature.input,
    output: creature.output,
  };
}

/* ------------------------------------------------------------------ */
/*  CLI entry point                                                    */
/* ------------------------------------------------------------------ */

async function runCrisprExample(): Promise<void> {
  const start = Date.now();
  const stage = (label: string) => console.log(`\n== ${label} ==`);

  console.log("🧬 CRISPR Gene Injection Example");

  // CI/quality quick mode (mirrors the cart_pole CART_POLE_QUICK=1 idiom).
  // When invoked with `CRISPR_QUICK=1` the runner forces a tiny iterations
  // cap, writes its artefacts under a temp directory, and never overwrites
  // the canonical docs SVG. Direct invocations still use the realistic
  // budget set in DEFAULT_CRISPR_EVOLUTION_CONFIG.
  const quick = Deno.env.get("CRISPR_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "crispr_quick_" });
    console.log(
      "⚡ Quick mode (CRISPR_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

  const workingRoot = quick && quickBaseDir !== undefined ? quickBaseDir : WORKING_ROOT;
  const { dataDir, creaturesDir, outputDir } = setupWorkingDirs(workingRoot);

  // Stage 1: Build the ground-truth target and synthesise the .bin set.
  stage("Stage 1/3: Generating binary training set from the hand-crafted target");
  const target = createTargetCreature();
  CreatureUtil.makeUUID(target);
  const targetExport: CreatureExport = target.exportJSON();
  await safeWriteJson(join(creaturesDir, "target.json"), targetExport);
  console.log(
    `   Target creature: ${target.input} inputs, ` +
      `${target.neurons.length} neurons, ${target.synapses.length} synapses`,
  );
  generateSyntheticData(target, dataDir, SYNTHETIC_CONFIG);

  // Stage 2: Run before/after evolveDir phases.
  stage("Stage 2/3: Evolving before and after gene injection");
  const config: CrisprEvolutionConfig = quick
    ? { ...DEFAULT_CRISPR_EVOLUTION_CONFIG, timeoutMinutes: 1, maxIterations: 3 }
    : DEFAULT_CRISPR_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${config.targetError}, ` +
      `timeoutMinutes=${config.timeoutMinutes}`,
  );
  const result = await runCrisprInjectionEvolution(dataDir, config);
  console.log(
    `   Pre-injection : generations=${result.pre.generations}  ` +
      `wallClock=${(result.pre.wallClockMs / 1000).toFixed(1)}s  ` +
      `score=${result.pre.summary.finalScore.toFixed(4)}  ` +
      `error=${result.pre.summary.finalError.toFixed(4)}  ` +
      `neurons=${result.pre.summary.finalNeurons}  synapses=${result.pre.summary.finalSynapses}`,
  );
  console.log(
    `   Post-injection: generations=${result.post.generations}  ` +
      `wallClock=${(result.post.wallClockMs / 1000).toFixed(1)}s  ` +
      `score=${result.post.summary.finalScore.toFixed(4)}  ` +
      `error=${result.post.summary.finalError.toFixed(4)}  ` +
      `neurons=${result.post.summary.finalNeurons}  synapses=${result.post.summary.finalSynapses}`,
  );

  // Save the post-injection champion + a reference baseline-with-gene
  // creature so reviewers can inspect the splicing primitive too.
  const championPath = join(creaturesDir, "best.json");
  await safeWriteJson(championPath, result.champion.exportJSON());
  const geneCreatureJSON = injectGene(createBaselineJSON(0), createGene());
  await safeWriteJson(join(creaturesDir, "gene.json"), geneCreatureJSON);
  console.log(`   Saved evolved champion to ${championPath}`);

  // Stage 3: Render the combined gene-topology + before/after milestone SVG.
  stage("Stage 3/3: Writing combined gene-topology + before/after milestone SVG");
  const { renderCrisprInjectionSvg } = await import("./svg.ts");
  const combinedSvg = renderCrisprInjectionSvg({
    gene: createGene(),
    pre: result.pre.summary,
    post: result.post.summary,
  });
  await Deno.writeTextFile(join(outputDir, "crispr_injection.svg"), combinedSvg);
  if (quick) {
    console.log("   ⏭️  Quick mode: skipped overwriting canonical screenshot");
  } else {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, combinedSvg);
    console.log(`   🖼️  Wrote ${SCREENSHOT_PATH}`);
  }

  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  const lift = result.post.summary.finalScore - result.pre.summary.finalScore;
  console.log("\n== Summary ==");
  console.log(`   Target creature:     ${join(creaturesDir, "target.json")}`);
  console.log(`   Evolved champion:    ${championPath}`);
  console.log(
    `   Fitness lift (post - pre): ${lift >= 0 ? "+" : ""}${lift.toFixed(4)}`,
  );
  console.log(
    `   Topology change: ${result.pre.summary.finalNeurons}/${result.pre.summary.finalSynapses} ` +
      `→ ${result.post.summary.finalNeurons}/${result.post.summary.finalSynapses}`,
  );
  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}

if (import.meta.main) {
  await runCrisprExample();
}
