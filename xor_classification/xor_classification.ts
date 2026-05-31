/**
 * XOR Classification Example (multi-run persistence wired under #326).
 *
 * Evolves a NEAT-AI creature to learn the XOR truth table — the
 * canonical "Hello World" of neuroevolution.
 *
 * 🌱 **Generation 1 is built by the NEAT-AI factory (issue #520; when no
 * prior champion exists).** The fresh-run creature is minted by
 * `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })` instead
 * of a bare `new Creature(2, 1)`. XOR is the ideal smoke-test that the
 * factory produces a valid seed: the classification cost couples the
 * output to a LOGISTIC activation, and the factory pre-sizes a small RELU
 * hidden layer with He/Xavier-scaled random weights. **No weights or
 * biases are hand-specified by this example** — every parameter is drawn
 * from the seeded global PRNG. Structural mutation (add-neuron,
 * add-synapse, weight tuning) is delegated to the NEAT-AI library via
 * `creature.evolveDir(...)`, whose configuration is unchanged, so
 * evolution behaves exactly as before.
 *
 * Under #326 the runner gained the multi-run idiom (issues #318, #319,
 * #320): with no prior state it behaves like a single random-noise run;
 * after a run it persists the champion + a per-run milestone summary so
 * the next invocation resumes from the saved creature. `--fresh` wipes
 * the persisted state, `--timeout=<minutes>` overrides the wall-clock
 * backstop, and `--target-error=<value>` overrides the early-exit
 * threshold. The runner emits two charts (`milestones.svg` and
 * `complexity.svg`) plus the decision-boundary SVG.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  createSeededRng,
  Creature,
  type CreatureExport,
  type DatasetFactoryOptions,
  type NeatOptions,
  safeWriteJson,
  setRandomNumberGenerator,
} from "@stsoftware/neat-ai";

import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  type NewMultiRunSample,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import { renderMultiRunErrorChartSVG } from "../common/multi_run_error_chart.ts";
import { renderMultiRunComplexityChartSVG } from "../common/multi_run_complexity_chart.ts";
import { renderDecisionBoundarySVG } from "./svg.ts";

/** Number of input features. */
export const INPUT_COUNT = 2;

/** Number of outputs. */
export const OUTPUT_COUNT = 1;

/**
 * Cost / task name handed to the NEAT-AI factory ({@link Creature.forDataset})
 * when building the seed creature (issue #520). XOR is a binary
 * classification with `{0, 1}` targets, so `BINARY_CROSS_ENTROPY` couples
 * the output activation to a **LOGISTIC** sigmoid (NEAT-AI #2793) — the
 * exact activation this example's `>= 0.5` threshold interface assumes.
 *
 * The cost drives only the *seed*; `evolveDir` itself is left on its
 * default MSE scoring (the runner never sets `NeatOptions.costName`), so
 * evolution behaves exactly as it did before the factory was adopted.
 */
export const CLASSIFICATION_COST = "BINARY_CROSS_ENTROPY";

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
  /**
   * Optional pre-seeded creature export, used by the multi-run resume
   * flow to continue evolution from a prior champion. When supplied, the
   * evolveDir seed is built via {@link Creature.fromJSON} instead of the
   * factory {@link buildSeedCreature}. When absent the first generation
   * starts from the factory seed (the default for a `--fresh` run).
   */
  seedCreatureExport?: CreatureExport;
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
  /** Wall-clock duration of the evolveDir call in milliseconds. */
  wallClockMs: number;
  /** Neuron count of the seed creature before evolveDir ran. */
  seedNeurons: number;
  /** Synapse count of the seed creature before evolveDir ran. */
  seedSynapses: number;
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

/** Path to the decision-boundary SVG the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/xor_decision_boundary.svg";

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "xor_classification";

/**
 * Path to the multi-run error-curve chart the runner emits — error vs
 * cumulative generation across every run, with faint run-boundary guide
 * lines. Replaces the legacy single-run summary chart (issue #326).
 */
export const MULTI_RUN_ERROR_SVG_PATH = "docs/screenshots/xor_classification/milestones.svg";

/**
 * Path to the multi-run complexity chart the runner emits — neurons +
 * synapses vs cumulative generation across every run.
 */
export const MULTI_RUN_COMPLEXITY_SVG_PATH = "docs/screenshots/xor_classification/complexity.svg";

/**
 * Default `targetError` for a multi-run invocation. Matches the
 * historical XOR convention — `0.05` (`>= 95%` per-sample fitness).
 */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = DEFAULT_EVOLVE_OPTIONS.errorThreshold;

/**
 * Default wall-clock budget for a single multi-run invocation, in
 * minutes. Five minutes matches the audit-mandated stop condition
 * (audit issue #205) and the issue #326 default.
 */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/** Resolution (cells per side) of the decision-boundary grid. */
export const DECISION_BOUNDARY_GRID = 40;

/**
 * Build a uniform-random NEAT seed creature — the bare `new Creature(...)`
 * baseline, **retained for fixtures and tests** after the fresh-run seed
 * moved to the factory ({@link buildSeedCreature}, issue #520). Seeds the
 * library's global PRNG with {@link createSeededRng} and then defers to
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

/** A single factory training record: an input vector plus its target. */
export type FactoryRecords = Parameters<typeof Creature.forDataset>[0];

/**
 * Convert the fixed XOR truth table ({@link xorSamples}) into the
 * `{ input, output }` record shape the NEAT-AI factory scans. This is the
 * exact data `evolveDir` trains on, so the factory derives its seed from
 * the same four samples the evolution loop sees.
 */
export function xorFactoryRecords(): FactoryRecords {
  return xorSamples().map(({ inputs, target }) => ({
    input: Float32Array.from([inputs[0], inputs[1]]),
    output: Float32Array.from([target]),
  }));
}

/**
 * Build the **factory seed creature** via the NEAT-AI factory
 * ({@link Creature.forDataset}) instead of a bare `new Creature(...)`
 * (issue #520). XOR is a tiny, deterministic problem, so it is the ideal
 * smoke-test that the factory produces a valid, well-initialised seed:
 *
 * - picks a **LOGISTIC output** activation from the classification cost
 *   ({@link CLASSIFICATION_COST}) — the activation the `>= 0.5` threshold
 *   interface and `{0, 1}` MSE both assume;
 * - sizes a **conservative hidden-capacity budget** from the problem
 *   shape (Heaton's rule → a small RELU hidden layer);
 * - scales the random weights to the **per-activation init stddev**
 *   (He/Xavier), so the forward pass neither saturates nor vanishes.
 *
 * The library's global PRNG is reseeded via {@link createSeededRng} so a
 * given `seed` produces a deterministic seed creature. Every weight and
 * bias is still drawn from that PRNG — the factory chooses the topology
 * and scaling, never hand-crafted parameters. The cost shapes only the
 * seed; the runner leaves `evolveDir` on its default MSE scoring so
 * evolution is untouched.
 *
 * This is a milestone-sanctioned departure from the project-wide
 * no-warm-starts policy, made under the factory-adoption tracker
 * (issue #517).
 */
export function buildSeedCreature(records: FactoryRecords, seed: number): CreatureExport {
  if (records.length === 0) {
    throw new Error("buildSeedCreature: records must not be empty");
  }
  setRandomNumberGenerator(createSeededRng(seed));
  const options: DatasetFactoryOptions = { cost: CLASSIFICATION_COST };
  return Creature.forDataset(records, options).exportJSON();
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
 * The runner builds the fresh **factory seed creature** via
 * {@link buildSeedCreature} (cost-derived LOGISTIC output, a small RELU
 * hidden layer, He/Xavier-scaled random weights) when no
 * `seedCreatureExport` is supplied, or rebuilds the prior champion from
 * its export to resume. Structural mutation is delegated to the library via
 * `creature.evolveDir` — add-neuron, add-synapse and weight perturbation
 * are all driven by the NEAT primitives, not by the example.
 *
 * One `evolveDir` call covers the whole budget. The return value's
 * `{ error, score, time, generation }` fields plus the seed and final
 * topology counts feed the multi-run milestone history (issue #326).
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

    // When `seedCreatureExport` is supplied (multi-run resume), rebuild
    // the prior champion. Otherwise build the fresh seed via the NEAT-AI
    // factory (issue #520) so the gen-1 creature carries a cost-derived
    // LOGISTIC output and a sane hidden-capacity budget.
    const creature = options.seedCreatureExport !== undefined
      ? Creature.fromJSON(options.seedCreatureExport)
      : Creature.fromJSON(buildSeedCreature(xorFactoryRecords(), options.seed));
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

    return {
      champion: creature,
      bestFitness: finalScore,
      bestError: finalError,
      generations,
      solved,
      wallClockMs,
      seedNeurons,
      seedSynapses,
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

/** Options accepted by {@link runMultiRunXor}. */
export interface RunMultiRunXorOptions {
  /** Argv (defaults to `Deno.args`). Recognised flags: `--fresh`,
   * `--timeout=<minutes>`, `--target-error=<value>`. */
  argv?: readonly string[];
  /** Base directory override for the multi-run persistence helpers and
   * chart artefacts (used by tests). Defaults to `docs`. */
  baseDir?: string;
  /** Optional overrides applied to `DEFAULT_EVOLVE_OPTIONS` (used by
   * tests to cap iterations without depending on wall-clock timing). */
  evolveOverrides?: Partial<EvolveOptions>;
}

/** Outcome of a single multi-run invocation. */
export interface MultiRunResult {
  /** The underlying evolveDir result. */
  evolveResult: EvolveResult;
  /** Number of this run within the persisted history (1-based). */
  runIndex: number;
  /** Cumulative generation total *after* this run was appended. */
  lastCumulativeGen: number;
  /** Total number of milestones in the merged history. */
  totalMilestones: number;
  /** `true` when the prior champion was reloaded as the seed creature. */
  resumed: boolean;
}

/**
 * Convert an {@link EvolveResult} into a {@link NewMultiRunSample}. The
 * supervised XOR run produces a single end-of-run summary
 * (`evolveDir` returns `{ error, score, generation, time }`), so each
 * run contributes one milestone to the merged history.
 */
export function evolveResultToMultiRunSample(result: EvolveResult): NewMultiRunSample {
  const error = Math.max(0, Math.min(1, result.bestError));
  return {
    runGen: result.generations,
    bestScore: result.bestFitness,
    error,
    neurons: result.champion.neurons.length,
    synapses: result.champion.synapses.length,
    generationWallClockMs: result.wallClockMs,
  };
}

/**
 * End-to-end multi-run wiring: parses flags, optionally wipes prior
 * state, loads the saved champion (when present) to seed the next run,
 * evolves the controller, appends the new run's milestone to the merged
 * history, and renders both multi-run charts.
 *
 * Returns a {@link MultiRunResult} so callers (CLI + tests) can report
 * on the run without re-reading disk.
 */
export async function runMultiRunXor(
  options: RunMultiRunXorOptions = {},
): Promise<MultiRunResult> {
  const argv = options.argv ?? Deno.args;
  const flags = parseMultiRunFlags(argv);
  const slug = EXAMPLE_SLUG;

  if (flags.fresh) {
    await wipeMultiRunState(slug, options.baseDir);
  }

  const state = await loadMultiRunState(slug, options.baseDir);
  const resumed = state.creatureExport !== undefined;

  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  const evolveOptions: EvolveOptions = {
    ...DEFAULT_EVOLVE_OPTIONS,
    timeoutMinutes,
    errorThreshold: targetError,
    seedCreatureExport: state.creatureExport,
    ...options.evolveOverrides,
  };

  const evolveResult = await evolveXorController(evolveOptions);

  const newSamples: NewMultiRunSample[] = [evolveResultToMultiRunSample(evolveResult)];

  await appendMultiRunRun(slug, {
    creatureExport: evolveResult.champion.exportJSON(),
    newSamples,
    runIndex: state.nextRunIndex,
    baseCumulativeGen: state.lastCumulativeGen,
  }, options.baseDir);

  const merged = await loadMultiRunState(slug, options.baseDir);

  if (merged.milestones.length > 0) {
    const base = options.baseDir ?? "docs";
    const screenshotsDir = join(base, "screenshots", slug);
    ensureDirSync(screenshotsDir);

    const errorSvg = renderMultiRunErrorChartSVG(merged.milestones, {
      title: "XOR Classification — multi-run error vs cumulative generations",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

    const complexitySvg = renderMultiRunComplexityChartSVG(merged.milestones, {
      title: "XOR Classification — multi-run creature complexity",
      caption: true,
    });
    await Deno.writeTextFile(join(screenshotsDir, "complexity.svg"), complexitySvg);
  }

  return {
    evolveResult,
    runIndex: state.nextRunIndex,
    lastCumulativeGen: merged.lastCumulativeGen,
    totalMilestones: merged.milestones.length,
    resumed,
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧠 XOR Classification Example (multi-run)");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-xor");

  console.log("📊 Training samples:");
  for (const { inputs, target } of xorSamples()) {
    console.log(`   (${inputs[0]}, ${inputs[1]}) → ${target}`);
  }

  // CI/quality quick mode (mirrors the cart-pole / snake / maze idioms).
  // When the runner is invoked with `XOR_QUICK=1` the multi-run state and
  // chart SVGs are written under a temp directory so the canonical docs
  // artefacts checked into the repo are never overwritten by a CI run,
  // and the iterations cap is forced low so the section finishes well
  // inside `quality.sh`'s per-section budget.
  const quick = Deno.env.get("XOR_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "xor_quick_" });
    console.log(
      "⚡ Quick mode (XOR_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
  }
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  console.log("\n🧬 Evolving classifier via Creature.evolveDir()...");
  console.log(
    `   Stop conditions: targetError=${targetError}, timeoutMinutes=${timeoutMinutes}` +
      (quick ? ", maxGenerations=3 (quick mode)" : ""),
  );

  const multi = await runMultiRunXor({
    baseDir: quickBaseDir,
    evolveOverrides: quick ? { maxGenerations: 3 } : undefined,
  });
  const { evolveResult: result } = multi;

  if (multi.resumed) {
    console.log(`🔁 Resumed from prior champion (run ${multi.runIndex}).`);
  } else {
    console.log(`🌱 Fresh start — run ${multi.runIndex} begins from the factory seed.`);
  }

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

  // The champion creature is persisted by `runMultiRunXor` under
  // `docs/data/xor_classification/creature.json`. Also drop a copy under
  // the example's working directory for ad-hoc inspection.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`\n💾 Saved champion to ${championPath}`);

  // Render the decision-boundary SVG (a distinct artefact from the
  // multi-run charts). Quick mode keeps this under the temp directory
  // so a CI invocation never overwrites the canonical docs screenshot.
  const svg = renderDecisionBoundarySVG(result.champion, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(join(tmpScreenshots, "xor_decision_boundary.svg"), svg);
    console.log("⏭️  Quick mode: skipped overwriting canonical decision-boundary screenshot");
  } else {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);
  }

  console.log(
    `📈 Multi-run charts updated under ${
      quick ? quickBaseDir : "docs"
    }/screenshots/${EXAMPLE_SLUG}/ — ` +
      `${multi.totalMilestones} cumulative milestone(s) across ${multi.runIndex} run(s).`,
  );

  if (quick && quickBaseDir !== undefined) {
    try {
      await Deno.remove(quickBaseDir, { recursive: true });
    } catch {
      // Tolerable — temp dir cleanup is best-effort.
    }
  }

  console.log(
    `\n🏁 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
