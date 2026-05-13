/**
 * XOR Classification Example (per-generation telemetry retired under #301).
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
 * Under #301 the per-generation `onTrainingEvent` hook, the chunked
 * `evolveDir` loop, and the multi-panel checkpoint strip were removed
 * in favour of NEAT-AI's supported milestone-only telemetry surface
 * (see [#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298)
 * for the decision record). The run now makes one `evolveDir` call and
 * renders a single milestone summary SVG from its return value via
 * the shared `EvolveDirSummary` helper from #284.
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
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
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
   * Wall-clock backstop in minutes for the whole run, passed verbatim
   * to NEAT-AI's `evolveDir(...)` per the audit policy in issue #205
   * (5-minute upper bound). NEAT-AI requires a positive integer, so a
   * minimum of 1 is enforced internally. Tests pass `0` to skip the
   * backstop because the option loads NEAT-AI's GPU / discovery code
   * path whose dynamic library is flagged by Deno's `--allow-ffi`
   * sanitizer.
   */
  timeoutMinutes: number;
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
  /**
   * Existing data directory containing the four XOR samples as a binary
   * file. When omitted, a temporary directory is created and cleaned up
   * automatically. Tests that want to inspect the data files can pass
   * their own directory here.
   */
  dataDir?: string;
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
  /** Milestone summary built from `evolveDir`'s return value (issue #301). */
  summary: EvolveDirSummary;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 50,
  maxGenerations: 2000,
  errorThreshold: 0.05,
  // Audit policy from issue #205: 5-minute wall-clock backstop. The
  // tiny XOR problem typically converges in a few seconds; this is a
  // safety net so the runner never wedges.
  timeoutMinutes: 5,
  mutationRate: 0.6,
  mutationAmount: 3,
};

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/xor_decision_boundary.svg";

/** Milestone summary SVG path — sourced from `evolveDir`'s return value (#301). */
export const EVOLUTION_SUMMARY_SVG_PATH =
  "docs/screenshots/xor_classification/evolution_summary.svg";

/** Resolution (cells per side) of the decision-boundary grid. */
export const DECISION_BOUNDARY_GRID = 40;

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
 * Run NEAT structural evolution to learn XOR.
 *
 * The runner builds the **uniform-random seed creature** via
 * {@link buildRandomSeedCreature} (no hidden neurons, random weights and
 * output bias from the seeded PRNG) and delegates structural mutation
 * to the library via `creature.evolveDir` — add-neuron, add-synapse and
 * weight perturbation are all driven by the NEAT primitives, not by
 * the example.
 *
 * One `evolveDir` call covers the whole budget. The return value's
 * `{ error, score, time, generation }` fields plus the seed and final
 * topology counts feed an {@link EvolveDirSummary} for the milestone
 * summary chart (issue #301).
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
    const seedNeurons = creature.neurons.length;
    const seedSynapses = creature.synapses.length;

    const neatOptions: NeatOptions = {
      seed: options.seed,
      populationSize: options.populationSize,
      iterations: options.maxGenerations,
      targetError: Math.max(0, Math.min(1, options.errorThreshold)),
      // The audit policy in #205 mandates a 5-minute safety
      // backstop for the production runner. NEAT-AI activates its
      // GPU/discovery cleanup machinery when the option is set, and
      // that machinery loads a dynamic library that Deno's test
      // sanitizer flags as a leak when --allow-ffi is enabled. We
      // include the option only when the caller asked for it
      // (`timeoutMinutes > 0`); tests override to 0 so the leak
      // detector stays clean while still exercising every other
      // code path.
      ...(options.timeoutMinutes > 0
        ? { timeoutMinutes: Math.max(1, Math.floor(options.timeoutMinutes)) }
        : {}),
      costOfGrowth: 0,
      mutationRate: options.mutationRate,
      mutationAmount: options.mutationAmount,
      verbose: false,
      log: 0,
      threads: 1,
    };

    const start = Date.now();
    const result = await creature.evolveDir(dataDir, neatOptions);
    const wallClockMs = Date.now() - start;

    const finalError = Number.isFinite(result.error) ? result.error : 0;
    const finalScore = Number.isFinite(result.score) ? result.score : 0;
    const generations = Math.max(1, result.generation ?? 1);
    const solved = finalError <= options.errorThreshold &&
      correctCount(creature) === 4;

    const summary: EvolveDirSummary = {
      finalError,
      finalScore,
      wallClockMs,
      generations,
      seedNeurons,
      seedSynapses,
      finalNeurons: creature.neurons.length,
      finalSynapses: creature.synapses.length,
      targetError: options.errorThreshold,
      ...(options.timeoutMinutes > 0 ? { timeoutMinutes: options.timeoutMinutes } : {}),
    };

    return {
      champion: creature,
      bestFitness: finalScore,
      bestError: finalError,
      generations,
      solved,
      summary,
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
  const result = await evolveXorController();

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

  // Milestone summary SVG sourced from the evolveDir return value
  // (issue #301): one chart, no per-generation telemetry.
  ensureDirSync("docs/screenshots/xor_classification");
  const summarySvg = renderEvolveDirSummarySvg(result.summary, {
    title: "XOR Classification — evolveDir Run Summary",
  });
  await Deno.writeTextFile(EVOLUTION_SUMMARY_SVG_PATH, summarySvg);
  console.log(`📈 Wrote milestone summary ${EVOLUTION_SUMMARY_SVG_PATH}`);

  console.log(
    `\n🏁 Final summary: generations=${result.summary.generations}  ` +
      `bestFitness=${result.summary.finalScore.toFixed(4)}  ` +
      `bestError=${result.summary.finalError.toFixed(4)}  ` +
      `seed=${result.summary.seedNeurons}/${result.summary.seedSynapses}  ` +
      `final=${result.summary.finalNeurons}/${result.summary.finalSynapses}`,
  );
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
