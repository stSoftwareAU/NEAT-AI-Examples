/**
 * Evolution Showcase Example (issue #96).
 *
 * Long-running flagship example whose entire purpose is to make the
 * gen-1-vs-gen-10000 contrast visible. Starts from a tiny seed creature
 * (4 inputs wired straight to a single output, no hidden capacity) and
 * evolves for many thousands of generations against a deterministic
 * non-linear regression target. Captures snapshots at the canonical
 * `[1, 10, 100, 1000, 10000]` checkpoints and renders them as a single
 * multi-panel SVG strip via {@link renderEvolutionProgressSvg} so the
 * topology growth and score improvement are visible at a glance.
 *
 * The synthetic dataset is generated deterministically via
 * {@link generateSyntheticData} from a fixed-topology teacher creature
 * with hidden TANH neurons — non-trivial enough that a hidden-less
 * baseline plateaus quickly and visible improvement requires both
 * weight tuning and structural growth.
 *
 * **Long-running by design.** The default configuration evolves for
 * 10000 generations and is deliberately not wired into `quality.sh`.
 * For fast unit-test verification the abbreviated checkpoints
 * `[1, 5, 10]` are exercised by the companion test file.
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  captureSnapshot,
  DEFAULT_CHECKPOINTS,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  asCreatureExport,
  type LegacyCreatureJSON,
  type LegacyNeuron,
  type LegacySynapse,
} from "../common/legacy_types.ts";

/** Number of input features used by both teacher and learner creatures. */
export const INPUT_COUNT = 4;

/** Number of outputs (single-output regression). */
export const OUTPUT_COUNT = 1;

/** Path the runner writes the rendered multi-panel SVG to. */
export const SCREENSHOT_PATH = "docs/screenshots/evolution_showcase_evolution.svg";

/** Hidden working directory root for this example's artefacts. */
export const SHOWCASE_ROOT = ".synthetic-evolution-showcase";

/** Synthetic dataset configuration — deterministic and small enough for fast scoring. */
export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 96,
  recordsPerFile: 96,
  seed: 96009600,
};

/** Configuration controlling {@link runEvolutionShowcase}. */
export interface ShowcaseConfig {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Total generations to evolve. The largest checkpoint is typically equal to this. */
  generations: number;
  /** Population size held constant across generations. */
  populationSize: number;
  /** Generations at which to capture a snapshot. */
  checkpoints: number[];
  /** Standard deviation of each weight perturbation. */
  mutationStrength: number;
  /** Probability per generation of inserting a new hidden neuron. */
  addNeuronRate: number;
  /** Probability per generation of inserting a new synapse. */
  addSynapseRate: number;
  /** Output directory for snapshot files (created if missing). */
  outputDir: string;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
}

/** Per-generation progress payload. */
export interface GenerationInfo {
  /** One-indexed generation counter. */
  generation: number;
  /** Best score in the population at this generation. */
  bestScore: number;
  /** Number of neurons in the current champion. */
  championNeuronCount: number;
  /** Number of synapses in the current champion. */
  championSynapseCount: number;
}

/** Result of a full showcase run. */
export interface ShowcaseResult {
  /** Best creature observed across the entire run. */
  champion: Creature;
  /** Best score observed across the entire run. */
  bestScore: number;
  /** Number of generations actually evolved. */
  generations: number;
  /** Output directory the snapshots were written to. */
  outputDir: string;
}

/** Default showcase configuration — runs to the canonical 10000th generation. */
export const DEFAULT_SHOWCASE_CONFIG: ShowcaseConfig = {
  seed: 96_00_96,
  generations: 10_000,
  populationSize: 12,
  checkpoints: [...DEFAULT_CHECKPOINTS],
  mutationStrength: 0.35,
  addNeuronRate: 0.02,
  addSynapseRate: 0.05,
  outputDir: join(SHOWCASE_ROOT, "snapshots"),
};

// ---------------------------------------------------------------------------
// Teacher creature (deterministic regression target)
// ---------------------------------------------------------------------------

/**
 * Build the teacher creature whose forward pass defines the synthetic
 * regression target. The teacher has four TANH hidden neurons fed by
 * the four inputs and a single linear (IDENTITY) output. Saturating
 * weights push each TANH neuron near `±1`, and the output is the
 * sum of two products of TANH outputs — an XOR-flavoured surface that
 * a hidden-less baseline cannot mimic. Meaningful fitness gains
 * therefore require structural growth in the learner.
 */
export function createTeacherCreature(): Creature {
  const json: LegacyCreatureJSON = {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "teacher-input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "teacher-input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "teacher-input-2" },
      { type: "input", squash: "LOGISTIC", index: 3, uuid: "teacher-input-3" },
      // Saturating TANH weights → near-bipolar hidden activations.
      { type: "hidden", squash: "TANH", index: 4, bias: 0.4, uuid: "teacher-hidden-0" },
      { type: "hidden", squash: "TANH", index: 5, bias: -0.3, uuid: "teacher-hidden-1" },
      { type: "hidden", squash: "TANH", index: 6, bias: 0.2, uuid: "teacher-hidden-2" },
      { type: "hidden", squash: "TANH", index: 7, bias: -0.1, uuid: "teacher-hidden-3" },
      // IDENTITY output keeps the target unbounded so MSE has real range.
      { type: "output", squash: "IDENTITY", index: 8, bias: 0, uuid: "teacher-output-0" },
    ],
    synapses: [
      // Inputs → hidden — large weights drive TANH into saturation.
      { from: 0, to: 4, weight: 3.5 },
      { from: 1, to: 4, weight: -3.0 },
      { from: 2, to: 5, weight: -3.2 },
      { from: 3, to: 5, weight: 3.4 },
      { from: 0, to: 6, weight: 2.8 },
      { from: 2, to: 6, weight: -2.6 },
      { from: 1, to: 7, weight: 2.5 },
      { from: 3, to: 7, weight: -2.7 },
      // Hidden → output — opposite signs encode XOR-like interactions.
      { from: 4, to: 8, weight: 1.5 },
      { from: 5, to: 8, weight: -1.4 },
      { from: 6, to: 8, weight: 1.2 },
      { from: 7, to: 8, weight: -1.1 },
    ],
    input: INPUT_COUNT,
    output: OUTPUT_COUNT,
  };
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
  return creature;
}

// ---------------------------------------------------------------------------
// Learner seed creature + structural mutations
// ---------------------------------------------------------------------------

/**
 * Build the learner's seed creature: four inputs wired straight to a
 * single LOGISTIC output, with small random weights. Has no hidden
 * capacity at all — fitness cannot improve past a low ceiling without
 * structural growth, so the gen-1 panel and gen-10000 panel show
 * meaningfully different topologies.
 */
export function createSeedCreatureJSON(random: () => number): LegacyCreatureJSON {
  const neurons: LegacyNeuron[] = [];
  for (let i = 0; i < INPUT_COUNT; i++) {
    neurons.push({ type: "input", squash: "LOGISTIC", index: i, uuid: `learner-input-${i}` });
  }
  neurons.push({
    // IDENTITY output matches the teacher's unbounded output range.
    type: "output",
    squash: "IDENTITY",
    index: INPUT_COUNT,
    bias: (random() * 2 - 1) * 0.2,
    uuid: "learner-output-0",
  });
  const synapses: LegacySynapse[] = [];
  for (let i = 0; i < INPUT_COUNT; i++) {
    synapses.push({ from: i, to: INPUT_COUNT, weight: (random() * 2 - 1) * 0.5 });
  }
  return { neurons, synapses, input: INPUT_COUNT, output: OUTPUT_COUNT };
}

/**
 * Re-index neuron `index` fields so they form a contiguous run starting
 * at 0, with inputs first, hidden in the middle, outputs last. Synapse
 * `from`/`to` indices are translated through the mapping.
 */
function normaliseIndices(json: LegacyCreatureJSON): LegacyCreatureJSON {
  const inputs = json.neurons.filter((n) => n.type === "input");
  const hidden = json.neurons.filter((n) => n.type === "hidden" || n.type === "constant");
  const outputs = json.neurons.filter((n) => n.type === "output");
  const merged = [...inputs, ...hidden, ...outputs].map((n) => ({ ...n }));

  const oldIndexToUUID = new Map<number, string>();
  for (const n of json.neurons) oldIndexToUUID.set(n.index, n.uuid);

  merged.forEach((n, i) => {
    n.index = i;
  });

  const uuidToNewIndex = new Map<string, number>();
  for (const n of merged) uuidToNewIndex.set(n.uuid, n.index);

  const synapses: LegacySynapse[] = [];
  for (const s of json.synapses) {
    const fromUUID = oldIndexToUUID.get(s.from);
    const toUUID = oldIndexToUUID.get(s.to);
    if (fromUUID === undefined || toUUID === undefined) continue;
    const fromIdx = uuidToNewIndex.get(fromUUID);
    const toIdx = uuidToNewIndex.get(toUUID);
    if (fromIdx === undefined || toIdx === undefined) continue;
    synapses.push({ from: fromIdx, to: toIdx, weight: s.weight });
  }

  return { neurons: merged, synapses, input: json.input, output: json.output };
}

/** Box-Muller standard-normal sample. */
function gaussian(random: () => number): number {
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Perturb every synapse weight and every hidden/output bias by a Gaussian draw. */
function perturbWeights(
  json: LegacyCreatureJSON,
  random: () => number,
  strength: number,
): LegacyCreatureJSON {
  const neurons = json.neurons.map((n) =>
    n.type === "input"
      ? { ...n }
      : { ...n, bias: (n.bias ?? 0) + gaussian(random) * strength * 0.5 }
  );
  const synapses = json.synapses.map((s) => ({
    ...s,
    weight: s.weight + gaussian(random) * strength,
  }));
  return { ...json, neurons, synapses };
}

/**
 * Insert a new TANH hidden neuron between a random non-output source
 * and a random non-input target. The new neuron arrives with one
 * incoming and one outgoing synapse so it has a path through the
 * network from the moment it is inserted. Returns the parent unchanged
 * if no eligible source/target pair exists.
 */
function addHiddenNeuron(
  json: LegacyCreatureJSON,
  random: () => number,
  uniqueSuffix: number,
): LegacyCreatureJSON {
  const sources = json.neurons.filter((n) => n.type !== "output");
  const targets = json.neurons.filter((n) => n.type !== "input");
  if (sources.length === 0 || targets.length === 0) return json;

  const src = sources[Math.floor(random() * sources.length)];
  const tgt = targets[Math.floor(random() * targets.length)];
  if (src.uuid === tgt.uuid) return json;

  const newNeuron: LegacyNeuron = {
    type: "hidden",
    squash: "TANH",
    // Index will be re-assigned by normaliseIndices.
    index: json.neurons.length,
    bias: (random() * 2 - 1) * 0.2,
    uuid: `learner-hidden-${uniqueSuffix}`,
  };
  const next: LegacyCreatureJSON = {
    neurons: [...json.neurons.map((n) => ({ ...n })), newNeuron],
    synapses: [
      ...json.synapses.map((s) => ({ ...s })),
      // Connect src → newNeuron and newNeuron → tgt with modest weights.
      { from: src.index, to: newNeuron.index, weight: (random() * 2 - 1) * 0.6 },
      { from: newNeuron.index, to: tgt.index, weight: (random() * 2 - 1) * 0.6 },
    ],
    input: json.input,
    output: json.output,
  };
  return normaliseIndices(next);
}

/**
 * Insert a new synapse between a random non-output source and a random
 * non-input target, skipping pairs that are already connected. Returns
 * the parent unchanged when every eligible pair already has an edge.
 */
function addSynapse(
  json: LegacyCreatureJSON,
  random: () => number,
): LegacyCreatureJSON {
  const sources = json.neurons.filter((n) => n.type !== "output");
  const targets = json.neurons.filter((n) => n.type !== "input");
  if (sources.length === 0 || targets.length === 0) return json;

  const existing = new Set(json.synapses.map((s) => `${s.from}->${s.to}`));
  // Try a handful of random pairs before giving up.
  for (let attempt = 0; attempt < 8; attempt++) {
    const src = sources[Math.floor(random() * sources.length)];
    const tgt = targets[Math.floor(random() * targets.length)];
    if (src.uuid === tgt.uuid) continue;
    const key = `${src.index}->${tgt.index}`;
    if (existing.has(key)) continue;
    return {
      ...json,
      synapses: [
        ...json.synapses.map((s) => ({ ...s })),
        { from: src.index, to: tgt.index, weight: (random() * 2 - 1) * 0.5 },
      ],
    };
  }
  return json;
}

/** A tracker for `learner-hidden-N` UUID uniqueness across mutations. */
interface MutationContext {
  /** Strictly increasing counter feeding `learner-hidden-<N>` UUIDs. */
  hiddenSuffix: number;
}

/**
 * Mutate a parent creature: always perturb weights, occasionally insert
 * a new hidden neuron, occasionally insert a new synapse. Returns a
 * fresh JSON object — the parent is not mutated.
 */
export function mutate(
  parent: LegacyCreatureJSON,
  random: () => number,
  config: ShowcaseConfig,
  context: MutationContext,
): LegacyCreatureJSON {
  let next = perturbWeights(parent, random, config.mutationStrength);
  if (random() < config.addNeuronRate) {
    context.hiddenSuffix += 1;
    next = addHiddenNeuron(next, random, context.hiddenSuffix);
  }
  if (random() < config.addSynapseRate) {
    next = addSynapse(next, random);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Dataset loading + in-memory scoring
// ---------------------------------------------------------------------------

/** A single in-memory training record: input vector + target output vector. */
export interface TrainingSample {
  inputs: Float32Array;
  targets: Float32Array;
}

/**
 * Read every `synthetic_*.bin` file under `dataDir` and decode it into
 * an array of {@link TrainingSample}s. Each record in the binary
 * stream holds {@link INPUT_COUNT} input floats followed by
 * {@link OUTPUT_COUNT} target floats — the same layout produced by
 * {@link generateSyntheticData}.
 */
export function loadDataset(dataDir: string): TrainingSample[] {
  const samples: TrainingSample[] = [];
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dataDir)) {
    if (entry.isFile && entry.name.endsWith(".bin")) files.push(entry.name);
  }
  files.sort();
  const recordFloats = INPUT_COUNT + OUTPUT_COUNT;
  for (const name of files) {
    const buf = Deno.readFileSync(join(dataDir, name));
    const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    for (let offset = 0; offset + recordFloats <= view.length; offset += recordFloats) {
      const inputs = new Float32Array(INPUT_COUNT);
      const targets = new Float32Array(OUTPUT_COUNT);
      for (let i = 0; i < INPUT_COUNT; i++) inputs[i] = view[offset + i];
      for (let j = 0; j < OUTPUT_COUNT; j++) {
        targets[j] = view[offset + INPUT_COUNT + j];
      }
      samples.push({ inputs, targets });
    }
  }
  return samples;
}

/**
 * Score a creature on the in-memory dataset. Returns negative mean
 * squared error so that higher is better — matches the convention used
 * by every other example's onGeneration callback.
 */
export function scoreOnDataset(creature: Creature, samples: readonly TrainingSample[]): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const s of samples) {
    creature.clearState();
    const out = creature.activate(s.inputs);
    let recordError = 0;
    for (let i = 0; i < s.targets.length; i++) {
      const d = (out[i] ?? 0) - s.targets[i];
      recordError += d * d;
    }
    total += recordError / s.targets.length;
  }
  return -total / samples.length;
}

// ---------------------------------------------------------------------------
// Evolution loop
// ---------------------------------------------------------------------------

/**
 * Build the synthetic dataset on disk (if missing) and load it into
 * memory. Returns the in-memory samples ready for fast scoring.
 */
export function prepareDataset(dataDir: string): TrainingSample[] {
  ensureDirSync(dataDir);
  // Generate only when the directory has no `.bin` files — otherwise reuse.
  const hasData = [...Deno.readDirSync(dataDir)].some(
    (e) => e.isFile && e.name.endsWith(".bin"),
  );
  if (!hasData) {
    const teacher = createTeacherCreature();
    generateSyntheticData(teacher, dataDir, SYNTHETIC_CONFIG);
  }
  return loadDataset(dataDir);
}

/**
 * Run the long-form evolution showcase. Captures snapshots at the
 * configured checkpoints, returns the champion + final score.
 */
export function runEvolutionShowcase(
  config: ShowcaseConfig,
  dataset: readonly TrainingSample[],
): ShowcaseResult {
  if (config.generations <= 0) {
    throw new Error(`generations must be positive, got ${config.generations}`);
  }
  if (config.populationSize <= 1) {
    throw new Error(`populationSize must be > 1, got ${config.populationSize}`);
  }
  if (dataset.length === 0) {
    throw new Error("dataset must contain at least one record");
  }

  const random = createDeterministicRandom(config.seed);
  const snapshotConfig: SnapshotConfig = {
    checkpoints: [...config.checkpoints],
    outputDir: config.outputDir,
  };
  ensureDirSync(config.outputDir);

  const context: MutationContext = { hiddenSuffix: 0 };

  // Initial population: identical seed creatures with independent random weights.
  let population: { json: LegacyCreatureJSON; score: number }[] = [];
  for (let i = 0; i < config.populationSize; i++) {
    const json = createSeedCreatureJSON(random);
    const score = scoreOnDataset(Creature.fromJSON(asCreatureExport(json)), dataset);
    population.push({ json, score });
  }

  let bestJSON = population[0].json;
  let bestScore = -Infinity;

  // Sample inputs reused across snapshots for visual continuity.
  const sampleSlice = dataset.slice(0, Math.min(4, dataset.length));

  for (let g = 1; g <= config.generations; g++) {
    population.sort((a, b) => b.score - a.score);
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestJSON = generationBest.json;
    }

    if (config.checkpoints.includes(g)) {
      const sampleOutputs = sampleSlice.map((s) => {
        const c = Creature.fromJSON(asCreatureExport(bestJSON));
        c.clearState();
        return Array.from(c.activate(s.inputs));
      });
      captureSnapshot(snapshotConfig, g, bestJSON, bestScore, sampleOutputs);
    }

    config.onGeneration?.({
      generation: g,
      bestScore: generationBest.score,
      championNeuronCount: bestJSON.neurons.length,
      championSynapseCount: bestJSON.synapses.length,
    });

    if (g === config.generations) break;

    // Truncation selection: top half are parents, elite carries over.
    const parentCount = Math.max(1, Math.floor(config.populationSize / 2));
    const parents = population.slice(0, parentCount);
    const next: typeof population = [];
    next.push(parents[0]);

    // Reserve one offspring slot per generation for a forced
    // structural mutation. Without this guarantee, structural
    // variants with new hidden neurons typically arrive worse than
    // the perturb-only elite (their new weights are random) and get
    // dropped before subsequent weight tuning has a chance to tune
    // them up, freezing the topology forever.
    const forceStructural = (parent: LegacyCreatureJSON): LegacyCreatureJSON => {
      context.hiddenSuffix += 1;
      let mutated = addHiddenNeuron(parent, random, context.hiddenSuffix);
      mutated = perturbWeights(mutated, random, config.mutationStrength * 0.5);
      return mutated;
    };

    while (next.length < config.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      let childJSON: LegacyCreatureJSON;
      let childScore: number;
      try {
        childJSON = next.length === 1
          ? forceStructural(parent.json)
          : mutate(parent.json, random, config, context);
        const childCreature = Creature.fromJSON(asCreatureExport(childJSON));
        childCreature.validate();
        childScore = scoreOnDataset(childCreature, dataset);
      } catch {
        // If a structural mutation produced an invalid topology, fall
        // back to the parent unchanged so the loop never stalls.
        childJSON = parent.json;
        childScore = parent.score;
      }
      next.push({ json: childJSON, score: childScore });
    }
    population = next;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestScore,
    generations: config.generations,
    outputDir: config.outputDir,
  };
}

// ---------------------------------------------------------------------------
// Runner entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Evolution Showcase Example (long-running flagship)");
  console.log("");

  const { dataDir, creaturesDir } = setupWorkingDirs(SHOWCASE_ROOT);
  const snapshotsDir = join(SHOWCASE_ROOT, "snapshots");
  ensureDirSync(snapshotsDir);

  console.log("📊 Step 1: Preparing synthetic dataset...");
  const dataset = prepareDataset(dataDir);
  console.log(`   Loaded ${dataset.length} samples from ${dataDir}`);

  console.log("\n🧬 Step 2: Evolving — this is deliberately long-running.");
  const result = runEvolutionShowcase(
    { ...DEFAULT_SHOWCASE_CONFIG, outputDir: snapshotsDir },
    dataset,
  );

  console.log(
    `\n🏁 Final score: ${result.bestScore.toFixed(6)} after ${result.generations} generations.`,
  );

  // Save champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the multi-panel SVG strip.
  const snapshots = loadSnapshots(snapshotsDir);
  if (snapshots.length === 0) {
    console.warn("⚠️  No snapshots captured — SVG not rendered.");
  } else {
    const wallClockMs = Date.now() - start;
    const svg = renderEvolutionProgressSvg(snapshots, {
      title: "Evolution Showcase — gen 1 → 10000",
      caption: {
        finalScore: result.bestScore,
        totalGenerations: result.generations,
        wallClockMs,
        text: "long-running flagship",
      },
    });
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${snapshots.length} panels)`);
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
