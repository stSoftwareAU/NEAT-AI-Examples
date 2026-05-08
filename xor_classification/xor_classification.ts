/**
 * XOR Classification Example
 *
 * Evolves a NEAT-AI creature to learn the XOR truth table — the
 * canonical "Hello World" of neuroevolution.
 *
 * 🌱 **Generation 1 starts from random noise.** The initial creature is
 * built by the NEAT-AI library's uniform-random `new Creature(2, 1)`
 * constructor — direct input → output synapses with random weights and
 * a random output bias drawn from the seeded global PRNG. **No
 * topology, weights, or biases are hand-specified by this example.**
 * Structural mutation (add-neuron, add-synapse, weight tuning) is
 * delegated to the NEAT-AI library via `creature.evolveDir(...)`. XOR
 * is not linearly separable, so the random direct-only seed cannot
 * solve the task — NEAT must invent at least one hidden neuron to
 * succeed.
 *
 * Inputs (per sample): `[a, b]` ∈ {0, 1}^2.
 * Output: a scalar in `(0, 1)`. Sample is classified as `1` when the
 * output is `>= 0.5`, else `0`.
 * Fitness: 1 - mean squared error across the four samples (higher is
 * better). The task is "solved" when every truth-table row is
 * classified correctly AND the mean squared error drops below
 * `errorThreshold`. A hard `maxGenerations` cap stops the run even if
 * the threshold is not reached.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  createSeededRng,
  Creature,
  type CreatureExport,
  type NeatOptions,
  safeWriteJson,
  setRandomNumberGenerator,
} from "@stsoftware/neat-ai";

import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import {
  captureSnapshot,
  DEFAULT_CHECKPOINTS,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { renderDecisionBoundarySVG } from "./svg.ts";

/** Number of input features. */
export const INPUT_COUNT = 2;

/** Number of outputs. */
export const OUTPUT_COUNT = 1;

/** A single XOR sample: two binary inputs and the expected output. */
export interface XorSample {
  inputs: readonly [number, number];
  target: number;
}

/**
 * The full XOR truth table. The four samples are emitted in a fixed
 * order so any test (and the rendered SVG) can rely on the indexing.
 */
export function xorSamples(): XorSample[] {
  return [
    { inputs: [0, 0], target: 0 },
    { inputs: [0, 1], target: 1 },
    { inputs: [1, 0], target: 1 },
    { inputs: [1, 1], target: 0 },
  ];
}

/** Configuration options for {@link evolveXorController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Maximum number of generations before giving up. */
  maxGenerations: number;
  /** Mean-squared-error threshold below which the task counts as solved. */
  errorThreshold: number;
  /**
   * Probability that any given creature is mutated each generation. The
   * NEAT-AI default is 0.3 — too conservative for the tiny XOR problem
   * where the seed must grow at least one hidden neuron from scratch.
   */
  mutationRate: number;
  /**
   * Number of mutation operators applied per mutated creature each
   * generation. Higher values bias the search toward structural growth
   * (ADD_NODE, ADD_CONN). The NEAT-AI default is 1.
   */
  mutationAmount: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, the running champion
   * is captured at every generation matching `snapshotConfig.checkpoints`
   * and written to `snapshotConfig.outputDir`.
   */
  snapshotConfig?: SnapshotConfig;
  /**
   * Existing data directory containing the four XOR samples as a binary
   * file. When omitted, a temporary directory is created and cleaned up
   * automatically. Tests that want to inspect the data files can pass
   * their own directory here.
   */
  dataDir?: string;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestFitness: number;
  bestError: number;
  meanFitness: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best fitness reached by the champion (1 - MSE - tiny version penalty). */
  bestFitness: number;
  /** Mean squared error of the champion across the four samples. */
  bestError: number;
  /** Number of generations actually run. */
  generations: number;
  /** True when the champion classifies all four samples correctly. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 50,
  maxGenerations: 2000,
  errorThreshold: 0.05,
  mutationRate: 0.6,
  mutationAmount: 3,
};

/**
 * Build a uniform-random NEAT seed creature. Seeds the library's global
 * PRNG with {@link createSeededRng} and then defers to
 * `new Creature(INPUT_COUNT, OUTPUT_COUNT)`, the library's uniform-random
 * constructor — every weight, bias, and synapse is drawn from the
 * seeded PRNG. No topology, weight, or bias is hand-specified by this
 * example.
 *
 * The constructor produces direct input → output synapses with no
 * hidden neurons, so the gen-1 creature cannot represent XOR (the
 * problem is not linearly separable). NEAT must invent at least one
 * hidden neuron during evolution to break the 0.25 MSE plateau.
 *
 * The single output neuron's activation is pinned to LOGISTIC. This is
 * the example's classification interface — predictions are interpreted
 * via a `>= 0.5` threshold and MSE is taken against `{0, 1}` targets,
 * both of which assume an output bounded to `[0, 1]`. Hidden neurons
 * (added later by structural mutation) are not constrained.
 */
export function buildRandomSeedCreature(seed: number): CreatureExport {
  setRandomNumberGenerator(createSeededRng(seed));
  const json = new Creature(INPUT_COUNT, OUTPUT_COUNT).exportJSON();
  for (const neuron of json.neurons) {
    if (neuron.type === "output") neuron.squash = "LOGISTIC";
  }
  return json;
}

/**
 * Write the four XOR samples as a Float32 binary file the NEAT-AI
 * library can consume via `creature.evolveDir(dir, ...)`. Each record
 * is `INPUT_COUNT + OUTPUT_COUNT` floats (input, input, target).
 */
export function writeXorDataset(dataDir: string): string {
  ensureDirSync(dataDir);
  const samples = xorSamples();
  const stride = INPUT_COUNT + OUTPUT_COUNT;
  const buffer = new Float32Array(samples.length * stride);
  for (let i = 0; i < samples.length; i++) {
    buffer[i * stride + 0] = samples[i].inputs[0];
    buffer[i * stride + 1] = samples[i].inputs[1];
    buffer[i * stride + INPUT_COUNT] = samples[i].target;
  }
  const path = join(dataDir, "xor.bin");
  Deno.writeFileSync(path, new Uint8Array(buffer.buffer));
  return path;
}

/** Activate the creature on a single sample, returning the scalar output. */
export function predict(creature: Creature, inputs: readonly [number, number]): number {
  creature.clearState();
  const out = creature.activate(Float32Array.from([inputs[0], inputs[1]]));
  return out[0];
}

/**
 * Mean squared error of a creature across the four XOR samples. Lower
 * is better; perfect fit is 0, worst is 1.
 */
export function meanSquaredError(creature: Creature): number {
  const samples = xorSamples();
  let sum = 0;
  for (const { inputs, target } of samples) {
    const prediction = predict(creature, inputs);
    const diff = prediction - target;
    sum += diff * diff;
  }
  return sum / samples.length;
}

/**
 * Number of samples (out of four) the creature classifies correctly,
 * using a 0.5 threshold on the output.
 */
export function correctCount(creature: Creature): number {
  const samples = xorSamples();
  let correct = 0;
  for (const { inputs, target } of samples) {
    const predicted = predict(creature, inputs) >= 0.5 ? 1 : 0;
    if (predicted === target) correct++;
  }
  return correct;
}

/**
 * Compute the schedule of segment endpoints. The list always starts
 * past gen 0 and ends at `maxGenerations`. Checkpoint values that fall
 * within `[1, maxGenerations]` become extra segment boundaries so a
 * snapshot can be captured at exactly that generation.
 */
export function planSegments(
  checkpoints: readonly number[],
  maxGenerations: number,
): number[] {
  const set = new Set<number>();
  for (const c of checkpoints) {
    if (c >= 1 && c <= maxGenerations) set.add(c);
  }
  set.add(maxGenerations);
  return [...set].sort((a, b) => a - b);
}

/**
 * Run NEAT structural evolution to learn XOR.
 *
 * The runner builds the **uniform-random seed creature** via
 * {@link buildRandomSeedCreature} (no hidden neurons, random weights and
 * output bias from the seeded PRNG) and delegates structural mutation
 * to the library via `creature.evolveDir` — add-neuron, add-synapse and
 * weight perturbation are all driven by the NEAT primitives, not by
 * the example. Snapshots are captured at
 * `options.snapshotConfig.checkpoints` by splitting the run into
 * segments that end at each checkpoint, allowing the running champion
 * (and its discovered topology) to be recorded as it grows.
 *
 * Determinism: the seed flows through `NeatOptions.seed` and is also
 * used to construct the initial creature, so two runs with the same
 * `seed` produce the same gen-1 seed creature and the same champion.
 */
export async function evolveXorController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ??
    Deno.makeTempDirSync({ prefix: "xor_evolve_data_" });

  try {
    if (ownDataDir) writeXorDataset(dataDir);

    const creature = Creature.fromJSON(buildRandomSeedCreature(options.seed));

    const checkpoints = options.snapshotConfig ? [...options.snapshotConfig.checkpoints] : [];
    const segmentEnds = planSegments(checkpoints, options.maxGenerations);

    let priorGenerations = 0;
    let lastError = meanSquaredError(creature);
    let lastScore = 1 - lastError;
    let solved = false;

    // Topology captured between segments so per-generation events report
    // the segment's *starting* neuron/synapse counts. The library only
    // updates `creature` in-place at the end of each `evolveDir`, so
    // mid-segment we must rely on these captured values rather than
    // reading the creature directly.
    const countTopology = () => {
      const exp = creature.exportJSON();
      return {
        neurons: exp.neurons.length + creature.input,
        synapses: exp.synapses.length,
      };
    };
    let topology = countTopology();

    // Reusable per-segment evolveDir options. We re-derive the seed for
    // each segment from the base seed so different segments explore
    // different mutation paths but the overall run is reproducible.
    for (const endGen of segmentEnds) {
      const iterations = endGen - priorGenerations;
      if (iterations <= 0) continue;

      const segmentOffset = priorGenerations;
      const neatOptions: NeatOptions = {
        seed: options.seed + segmentOffset,
        populationSize: options.populationSize,
        iterations,
        targetError: Math.max(0, Math.min(1, options.errorThreshold)),
        costOfGrowth: 0,
        mutationRate: options.mutationRate,
        mutationAmount: options.mutationAmount,
        verbose: false,
        log: 0,
        threads: 1,
        onTrainingEvent: (event) => {
          if (event.kind !== "generation_complete") return;
          const fitness = event.bestFitness;
          // score = 1 - error - growthPenalty - versionPenalty (1e-6).
          // With costOfGrowth=0 the growth penalty is 0, so error ≈ 1 - fitness
          // (within 1e-6).
          const error = Math.max(0, 1 - fitness);
          options.onGeneration?.({
            generation: priorGenerations + event.generation,
            bestFitness: fitness,
            bestError: error,
            meanFitness: event.averageFitness,
            // Topology of the segment's starting champion (captured
            // before evolveDir was invoked). The actual within-segment
            // best may have grown further; we re-read after the segment
            // ends so the next segment's events reflect the new counts.
            neurons: topology.neurons,
            synapses: topology.synapses,
          });
        },
      };

      const result = await creature.evolveDir(dataDir, neatOptions);
      priorGenerations += result.generation;
      lastError = result.error;
      lastScore = result.score;
      // Refresh the captured topology so the next segment's events
      // reflect the new champion's neuron / synapse counts.
      topology = countTopology();

      // Capture a snapshot whenever this segment ends on a configured
      // checkpoint. The creature has just been mutated in-place to the
      // current best, so its topology and predictions are accurate.
      if (options.snapshotConfig && checkpoints.includes(endGen)) {
        const sampleOutputs = xorSamples().map((s) => predict(creature, s.inputs));
        captureSnapshot(
          options.snapshotConfig,
          endGen,
          creature.exportJSON() as unknown,
          lastScore,
          sampleOutputs,
        );
      }

      if (lastError <= options.errorThreshold) {
        solved = true;
        break;
      }
    }

    return {
      champion: creature,
      bestFitness: lastScore,
      bestError: lastError,
      generations: priorGenerations,
      solved: solved && correctCount(creature) === 4,
    };
  } finally {
    if (ownDataDir) {
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch {
        // Ignore cleanup errors — the temp dir may already be gone.
      }
    }
  }
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/xor_decision_boundary.svg";

/** Path to the evolution-chart SVG the runner emits for the README. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/xor_classification/evolution.svg";

/** Resolution (cells per side) of the decision-boundary grid. */
export const DECISION_BOUNDARY_GRID = 40;

/**
 * Generations at which the runner captures evolution snapshots. The
 * canonical NEAT-AI strip uses `[1, 10, 100, 1000, 10000]` (matching
 * `DEFAULT_CHECKPOINTS` from `evolution_snapshot.ts`); any checkpoint
 * past `DEFAULT_EVOLVE_OPTIONS.maxGenerations` simply does not fire,
 * so the same list works for reduced-budget test runs.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [...DEFAULT_CHECKPOINTS];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-xor/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/xor_classification_evolution.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🧠 XOR Classification Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-xor");

  console.log("📊 Training samples:");
  for (const { inputs, target } of xorSamples()) {
    console.log(`   (${inputs[0]}, ${inputs[1]}) → ${target}`);
  }

  console.log("\n🧬 Evolving classifier (NEAT structural mutation from random noise)...");
  const evolutionSamples: EvolutionSample[] = [];
  ensureDirSync(SNAPSHOTS_DIR);
  // Empty any stale snapshot files so reruns do not blend old + new gens.
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionStart = Date.now();
  const result = await evolveXorController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestFitness, bestError, neurons, synapses }) => {
      evolutionSamples.push({
        generation,
        score: bestFitness,
        neurons,
        synapses,
      });
      if (generation % 10 === 0 || bestError <= DEFAULT_EVOLVE_OPTIONS.errorThreshold) {
        console.log(
          `   Gen ${generation.toString().padStart(4)}  ` +
            `bestFitness=${bestFitness.toFixed(4)}  ` +
            `bestError=${bestError.toFixed(4)}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(error=${result.bestError.toFixed(4)}, fitness=${result.bestFitness.toFixed(4)}).`,
  );

  console.log("\n🎯 Champion predictions:");
  for (const { inputs, target } of xorSamples()) {
    const out = predict(result.champion, inputs);
    const predicted = out >= 0.5 ? 1 : 0;
    const tick = predicted === target ? "✓" : "✗";
    console.log(`   (${inputs[0]}, ${inputs[1]}) → ${out.toFixed(4)} (target=${target}) ${tick}`);
  }

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`\n💾 Saved champion to ${championPath}`);

  // Render the decision-boundary SVG.
  const svg = renderDecisionBoundarySVG(result.champion, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "XOR Classification — Evolution",
      scoreLabel: "best fitness (1 - MSE)",
    });
    ensureDirSync("docs/screenshots/xor_classification");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "XOR Classification — Evolution Progress",
      caption: {
        finalScore: result.bestFitness,
        totalGenerations: result.generations,
        wallClockMs: Date.now() - evolutionStart,
      },
    });
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(EVOLUTION_PROGRESS_SVG_PATH, progressionSvg);
    console.log(
      `🧬 Wrote evolution-progression strip ${EVOLUTION_PROGRESS_SVG_PATH} ` +
        `(${snapshots.length} panels)`,
    );
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
