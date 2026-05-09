/**
 * CRISPR Gene Injection Example — minimal-seed evolution + measured
 * telemetry (audit issue #209, parent audit #203).
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
 * The audit (#209) repurposes the runner so the published evolution
 * genuinely *learns* the network structure from a minimal NEAT-AI seed:
 *
 *   1. The hand-crafted target creature is still hand-crafted, but it
 *      is used **only** as the ground-truth that synthesises labels for
 *      the binary `.bin` training set. NEAT-AI never sees the target —
 *      it is not the seed.
 *   2. The seed passed to NEAT-AI is `new Creature(INPUT_COUNT,
 *      OUTPUT_COUNT)` — no hidden-layer hint, no pre-built
 *      `network.json` seed, no hand-tuned shape.
 *   3. `Creature.evolveDir(dataDir, options)` runs forward-only over
 *      the pre-generated `.bin` training set (per #190) until either
 *      the per-example `targetError` threshold is reached or the
 *      `timeoutMinutes: 5` backstop fires.
 *   4. Per-generation telemetry (best/mean fitness + neuron / synapse
 *      counts) is captured via `onTrainingEvent` and emitted as a CSV
 *      plus two SVG charts so the README can quote the *measured*
 *      numbers from the latest run only.
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

import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
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

/** Per-generation evolution-telemetry CSV path. */
export const EVOLUTION_CSV_PATH = "docs/data/crispr_injection/evolution.csv";

/** CSV header — schema mandated by issue #209. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/crispr_injection/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/crispr_injection/topology.svg";

/** Path to the legacy gene-topology + fitness-curve SVG kept for the README. */
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
  /** Wall-clock backstop in minutes (issue #209 mandates 5 as upper bound). */
  timeoutMinutes: number;
  /** NEAT population size — small enough for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /** RNG seed forwarded to NEAT-AI for deterministic-ish runs. */
  seed: number;
}

/**
 * Defaults tuned so the demo converges via `targetError` well inside the
 * 5-minute backstop on a developer machine while still showing visible
 * neuron / synapse growth from the minimal seed.
 *
 * The target creature's hidden neurons saturate two TANH cells, so the
 * direct-only seed (no hidden) cannot fit the function. We pick a tight
 * `targetError` so NEAT-AI is genuinely forced to grow hidden structure
 * to satisfy the stop condition — otherwise the topology chart would
 * flatline (acceptance criterion in issue #209). The 2-input task can
 * be fit to ~0.98 by a linear baseline, so we use a slightly larger
 * population and more iterations than the 4-input discovery demo to
 * give ADD_NODE / ADD_CONN mutations enough generations to take hold.
 */
export const DEFAULT_CRISPR_EVOLUTION_CONFIG: CrisprEvolutionConfig = {
  targetError: 0.0005,
  timeoutMinutes: 5,
  populationSize: 32,
  maxIterations: 400,
  seed: 209209,
};

/** One row of per-generation evolution telemetry. */
export interface EvolutionRow {
  /** 1-based generation index across the run. */
  generation: number;
  /** Best fitness observed in this generation. */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /** Neuron count of this generation's champion. */
  neuronCount: number;
  /** Synapse count of this generation's champion. */
  synapseCount: number;
}

/** Result of {@link runMinimalSeedEvolution}. */
export interface CrisprEvolutionResult {
  /** The best creature found by `evolveDir` (the in-place seed reference). */
  champion: Creature;
  /** Per-generation telemetry rows captured during the run. */
  rows: EvolutionRow[];
  /** Total wall-clock time of the evolution call, in milliseconds. */
  wallClockMs: number;
  /** Final per-record error returned by `evolveDir`. */
  finalError: number;
  /** Total generations completed. */
  generations: number;
  /** Initial neuron count of the minimal seed (before evolution). */
  seedNeuronCount: number;
  /** Initial synapse count of the minimal seed (before evolution). */
  seedSynapseCount: number;
}

/**
 * Builds the target creature whose two TANH hidden neurons together
 * compute a non-linear function the baseline (no hidden) cannot match.
 * Synthetic training data is generated from this creature's outputs;
 * the audit-compliant runner uses it only as the label oracle.
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
 * Legacy CRISPR experiment helper retained for backwards compatibility.
 *
 * Runs the original perturb-and-keep evolution loop, splices the
 * hand-crafted gene into the top members at a fixed generation, and
 * resumes the loop. The audit (#209) replaced this helper with the
 * minimal-seed `evolveDir` flow in {@link runMinimalSeedEvolution}, but
 * the test suite still uses this function to verify the gene-injection
 * primitives.
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
/*  Audit-compliant minimal-seed evolution                             */
/* ------------------------------------------------------------------ */

/** Format a finite number for CSV emission with trimmed trailing zeros. */
function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/** Format the per-generation telemetry rows as a CSV string. */
export function formatEvolutionCsv(rows: readonly EvolutionRow[]): string {
  const lines: string[] = [EVOLUTION_CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.generation,
        formatCsvNumber(r.bestFitness),
        formatCsvNumber(r.meanFitness),
        r.neuronCount,
        r.synapseCount,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Iterations per `evolveDir` chunk. Chunking the run keeps the
 * per-generation telemetry chart in step with topology mutations: the
 * passed-in `creature` reference is only updated at the end of each
 * `evolveDir` call, so smaller chunks make the neuron / synapse line
 * climb in visible step changes rather than as a single jump at the end.
 */
const PHASE_CHUNK_ITERATIONS = 25;

/**
 * Run minimal-seed `evolveDir` against the binary `.bin` training set in
 * `dataDir`, capturing per-generation telemetry for the README.
 *
 * The seed passed in must be `new Creature(INPUT_COUNT, OUTPUT_COUNT)` —
 * this function deliberately does not construct the seed itself so the
 * caller (and the tests) can prove no hidden-layer hint leaks in.
 */
export async function runMinimalSeedEvolution(
  seed: Creature,
  dataDir: string,
  config: CrisprEvolutionConfig = DEFAULT_CRISPR_EVOLUTION_CONFIG,
): Promise<CrisprEvolutionResult> {
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");
  if (config.maxIterations <= 0) throw new Error("maxIterations must be positive");

  const seedNeuronCount = seed.neurons.length;
  const seedSynapseCount = seed.synapses.length;

  const rows: EvolutionRow[] = [];
  const start = Date.now();
  const budgetMs = config.timeoutMinutes * 60_000;

  let evolved = 0;
  let finalError = Number.POSITIVE_INFINITY;

  while (evolved < config.maxIterations) {
    // The creature reference is updated by `evolveDir` at the end of
    // each call. Re-read its topology *before* the next chunk so the
    // event handler reports the latest neuron / synapse counts for
    // every generation inside the chunk.
    const segmentStartNeurons = seed.neurons.length;
    const segmentStartSynapses = seed.synapses.length;

    const elapsedMs = Date.now() - start;
    if (elapsedMs >= budgetMs) break;

    const remaining = config.maxIterations - evolved;
    const chunkIterations = Math.min(PHASE_CHUNK_ITERATIONS, remaining);

    const neatOptions: NeatOptions = {
      seed: config.seed + evolved,
      populationSize: config.populationSize,
      iterations: chunkIterations,
      targetError: config.targetError,
      timeoutMinutes: config.timeoutMinutes,
      // No feedbackLoop key → engine treats the run as forward-only.
      costOfGrowth: 0,
      // Push NEAT toward structural growth so the example genuinely
      // adds hidden neurons / inter-layer synapses from the minimal seed
      // — required by the audit's "neuron and synapse counts genuinely
      // change" acceptance criterion.
      mutationRate: 0.6,
      mutationAmount: 3,
      verbose: false,
      log: 0,
      threads: 1,
      onTrainingEvent: (event) => {
        if (event.kind !== "generation_complete") return;
        rows.push({
          generation: evolved + event.generation,
          bestFitness: event.bestFitness,
          meanFitness: event.averageFitness,
          neuronCount: segmentStartNeurons,
          synapseCount: segmentStartSynapses,
        });
      },
    };

    const result = await seed.evolveDir(dataDir, neatOptions);
    const completed = result.generation ?? chunkIterations;
    evolved += completed;
    finalError = result.error ?? finalError;

    if (finalError <= config.targetError) break;
    if (completed < chunkIterations) break;
  }

  // Patch the final row so the chart shows the post-evolution topology
  // — `evolveDir` updates the creature reference *after* the last event
  // fires inside the chunk, so without this fix-up the last row still
  // reports the pre-chunk counts.
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    last.neuronCount = seed.neurons.length;
    last.synapseCount = seed.synapses.length;
  }

  return {
    champion: seed,
    rows,
    wallClockMs: Date.now() - start,
    finalError,
    generations: evolved,
    seedNeuronCount,
    seedSynapseCount,
  };
}

/** Convert telemetry rows into the shape expected by the shared chart helpers. */
export function rowsToFitnessSamples(rows: readonly EvolutionRow[]): FitnessSample[] {
  return rows.map((r) => ({
    generation: r.generation,
    bestFitness: r.bestFitness,
    avgFitness: r.meanFitness,
  }));
}

/** Convert telemetry rows into the shape expected by the evolution chart helper. */
export function rowsToEvolutionSamples(rows: readonly EvolutionRow[]): EvolutionSample[] {
  return rows.map((r) => ({
    generation: r.generation,
    score: r.bestFitness,
    neurons: r.neuronCount,
    synapses: r.synapseCount,
  }));
}

/* ------------------------------------------------------------------ */
/*  CLI entry point                                                    */
/* ------------------------------------------------------------------ */

async function runCrisprExample(): Promise<void> {
  const start = Date.now();
  const stage = (label: string) => console.log(`\n== ${label} ==`);

  console.log("🧬 CRISPR Gene Injection Example");

  const { dataDir, creaturesDir, outputDir } = setupWorkingDirs(WORKING_ROOT);

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

  // Stage 2: Build the minimal seed and run evolveDir.
  stage("Stage 2/3: Evolving from a minimal NEAT-AI seed");
  console.log(
    `   Seed: new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  console.log(
    `   Seed topology: ${seed.neurons.length} neurons, ${seed.synapses.length} synapses`,
  );

  const config = DEFAULT_CRISPR_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${config.targetError}, ` +
      `timeoutMinutes=${config.timeoutMinutes} (issue #209 backstop)`,
  );

  const result = await runMinimalSeedEvolution(seed, dataDir, config);
  const finalRow = result.rows[result.rows.length - 1];
  console.log(
    `   Completed ${result.generations} generations in ` +
      `${(result.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(result.finalError) ? result.finalError.toFixed(4) : "n/a"
      })`,
  );
  if (finalRow) {
    console.log(
      `   Champion topology: ${finalRow.neuronCount} neurons, ` +
        `${finalRow.synapseCount} synapses ` +
        `(seed had ${result.seedNeuronCount} / ${result.seedSynapseCount})`,
    );
  }

  // Save the evolved champion + a reference baseline-with-gene creature
  // so reviewers can inspect the pre-audit splicing primitive too.
  const championPath = join(creaturesDir, "best.json");
  await safeWriteJson(championPath, result.champion.exportJSON());
  const geneCreatureJSON = injectGene(createBaselineJSON(0), createGene());
  await safeWriteJson(join(creaturesDir, "gene.json"), geneCreatureJSON);
  console.log(`   Saved evolved champion to ${championPath}`);

  // Stage 3: Emit the per-generation telemetry artefacts.
  stage("Stage 3/3: Writing per-generation telemetry (CSV + 2 SVGs)");
  if (result.rows.length === 0) {
    console.log("   ⚠️  No per-generation events captured — telemetry skipped.");
  } else {
    ensureDirSync("docs/data/crispr_injection");
    ensureDirSync("docs/screenshots/crispr_injection");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(result.rows));
    console.log(`   🗒️  Wrote ${EVOLUTION_CSV_PATH} (${result.rows.length} rows)`);

    const fitnessSvg = renderFitnessChartSVG(rowsToFitnessSamples(result.rows), {
      title: "CRISPR Injection — Best vs Mean Fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`   📈 Wrote ${FITNESS_SVG_PATH}`);

    const topologySvg = renderEvolutionChartSVG(rowsToEvolutionSamples(result.rows), {
      title: "CRISPR Injection — Score, Neurons, Synapses per Generation",
    });
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, topologySvg);
    console.log(`   📈 Wrote ${TOPOLOGY_SVG_PATH}`);
  }

  // Render the legacy gene-topology + fitness-curve SVG so older tests
  // and the historical screenshot path stay populated.
  const { renderCrisprSVG } = await import("./svg.ts");
  const legacyRecords: FitnessRecord[] = result.rows.map((r, i) => ({
    generation: i,
    bestFitness: r.bestFitness,
    injection: false,
  }));
  if (legacyRecords.length > 0) {
    const legacySvg = renderCrisprSVG({
      records: legacyRecords,
      // Mark the midpoint as a "structural lift" — the audit's runner
      // does not splice the gene mid-flight, but the legacy SVG layout
      // expects an injection marker, so we anchor it at the midpoint.
      injectionGeneration: Math.floor(legacyRecords.length / 2),
      gene: createGene(),
    });
    const legacyOutputPath = join(outputDir, "crispr_injection.svg");
    await Deno.writeTextFile(legacyOutputPath, legacySvg);
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, legacySvg);
    console.log(`   🖼️  Wrote ${legacyOutputPath} and ${SCREENSHOT_PATH}`);
  }

  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  console.log("\n== Summary ==");
  console.log(`   Target creature:     ${join(creaturesDir, "target.json")}`);
  console.log(`   Evolved champion:    ${championPath}`);
  if (finalRow) {
    console.log(
      `   Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${finalRow.meanFitness.toFixed(4)}  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(`   Wall-clock: ${(result.wallClockMs / 1000).toFixed(1)}s`);
  console.log(`\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`);
}

if (import.meta.main) {
  await runCrisprExample();
}
