/**
 * Intelligent Design Example — minimal-seed evolution + squash scan
 * (audit issue #214, telemetry simplified under #302).
 *
 * The example evolves a creature from a minimal NEAT-AI seed and then
 * systematically tests alternative activation functions on the evolved
 * champion. Under #302 the per-generation telemetry hook was removed in
 * favour of NEAT-AI's supported milestone-only telemetry surface — the
 * demo now makes a single `Creature.evolveDir(...)` call and renders a
 * milestone summary SVG via the shared {@link renderEvolveDirSummarySvg}
 * helper.
 *
 *   1. The hand-crafted reference creature is used **only** as the
 *      label oracle that synthesises the binary `.bin` training set.
 *      NEAT-AI never sees it.
 *   2. The seed passed to NEAT-AI is `new Creature(INPUT_COUNT,
 *      OUTPUT_COUNT)` — no hidden-layer hint, no pre-built
 *      `network.json`, no hand-tuned shape.
 *   3. `Creature.evolveDir(dataDir, options)` runs forward-only over the
 *      pre-generated `.bin` training set until either the per-example
 *      `targetError` threshold is reached or the `timeoutMinutes: 20`
 *      backstop fires (raised from the original audit's 5-minute cap by
 *      issue #378 — +15 minutes of additional wall-clock budget for the
 *      `Refresh-2026-05` milestone).
 *   4. A single milestone summary SVG is rendered from the `evolveDir`
 *      return value plus the seed and final creature topology.
 *   5. The "intelligent design" framing is preserved by running
 *      `scanForSquashImprovements` on the **evolved champion**.
 */

import { parseArgs } from "@std/cli";
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  alternativeSquashes,
  combineImprovements,
  Creature,
  type NeatOptions,
  safeWriteJson,
  scanForSquashImprovements,
} from "@stsoftware/neat-ai";
import { addTag, getTag } from "@stsoftware/tags/mod";

import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";

export { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-intelligent-design";

/** Milestone summary SVG path — sourced from the `evolveDir` return value. */
export const EVOLUTION_SUMMARY_SVG_PATH =
  "docs/screenshots/intelligent_design/evolution_summary.svg";

/** Number of input neurons fed to the NEAT-AI seed and the reference creature. */
export const INPUT_COUNT = 4;

/** Number of output neurons fed to the NEAT-AI seed and the reference creature. */
export const OUTPUT_COUNT = 1;

/**
 * Synthetic-data configuration used by the legacy reference helper and
 * the minimal-seed runner. The seed is unchanged from the pre-rewire
 * version so existing data fixtures stay reproducible.
 */
export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 500,
  recordsPerFile: 500,
  seed: 42424242,
};

/* ------------------------------------------------------------------ */
/*  Audit (#214) — minimal-seed evolution                              */
/* ------------------------------------------------------------------ */

/** Configuration for {@link runMinimalSeedEvolution}. */
export interface MinimalSeedEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /**
   * Wall-clock backstop in minutes. Issue #214 originally mandated 5 as the
   * upper bound; issue #378 grants +15 minutes of additional evolution budget
   * (5 → 20) for the `Refresh-2026-05` milestone refresh.
   */
  timeoutMinutes: number;
  /** NEAT population size. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /** Probability that any given creature is mutated each generation. */
  mutationRate: number;
  /** Number of mutation operators applied per mutated creature. */
  mutationAmount: number;
  /** RNG seed forwarded to NEAT-AI for deterministic-ish runs. */
  seed: number;
}

/**
 * Defaults tuned so the demo converges via `targetError` well inside
 * the 5-minute backstop on a developer machine while still exhibiting
 * visible neuron / synapse growth from the minimal seed.
 */
export const DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG: MinimalSeedEvolutionConfig = {
  targetError: 0.0001,
  // Issue #378: refresh-2026-05 grants +15 minutes of additional wall-clock
  // evolution budget (5 → 20). maxIterations is lifted in lock-step so that
  // wall-clock remains the genuine limiter.
  timeoutMinutes: 20,
  populationSize: 24,
  maxIterations: 3000,
  mutationRate: 0.8,
  mutationAmount: 5,
  seed: 214214,
};

/** Result of {@link runMinimalSeedEvolution}. */
export interface MinimalSeedEvolutionResult {
  /** The best creature found by `evolveDir` (same JS object as the seed). */
  champion: Creature;
  /** Milestone summary captured from the single `evolveDir` call. */
  summary: EvolveDirSummary;
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
  /** True when the run ended because `targetError` was reached. */
  solved: boolean;
}

/**
 * Run minimal-seed `evolveDir` against the binary `.bin` training set
 * in `dataDir`, returning a milestone summary captured from the
 * `evolveDir` return value plus the seed and final creature topology.
 *
 * The seed passed in **must** be `new Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` — this function deliberately does not construct the
 * seed itself so callers (and the tests) can prove that no hidden-layer
 * hint leaks in.
 */
export async function runMinimalSeedEvolution(
  seed: Creature,
  dataDir: string,
  config: MinimalSeedEvolutionConfig = DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG,
): Promise<MinimalSeedEvolutionResult> {
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes < 0) throw new Error("timeoutMinutes must be >= 0");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");
  if (config.maxIterations <= 0) throw new Error("maxIterations must be positive");

  const seedNeuronCount = seed.neurons.length;
  const seedSynapseCount = seed.synapses.length;

  const start = Date.now();

  const neatOptions: NeatOptions = {
    seed: config.seed,
    populationSize: config.populationSize,
    iterations: config.maxIterations,
    targetError: config.targetError,
    // Tests pass timeoutMinutes=0 to suppress NEAT-AI's GPU/discovery
    // FFI cleanup (it confuses Deno's resource sanitiser); production
    // runs use the issue #214 backstop of 5.
    ...(config.timeoutMinutes > 0
      ? { timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)) }
      : {}),
    // No feedbackLoop key → engine treats the run as forward-only.
    costOfGrowth: 0,
    mutationRate: config.mutationRate,
    mutationAmount: config.mutationAmount,
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
    ...(config.timeoutMinutes > 0
      ? { timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)) }
      : {}),
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

/* ------------------------------------------------------------------ */
/*  Legacy helper — hand-crafted reference creature (label oracle)     */
/* ------------------------------------------------------------------ */

/**
 * Build a hand-crafted reference creature with diverse hidden squashes.
 *
 * This creature is **only** used as the label oracle that synthesises
 * the binary `.bin` training set. NEAT-AI never sees it as a seed. The
 * diverse squash mix is what gives the squash improvement scan
 * something interesting to optimise on the **evolved** champion.
 */
export function createReferenceCreature(): Creature {
  const json: LegacyCreatureJSON = {
    neurons: [
      // Input neurons
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },
      { type: "input", squash: "LOGISTIC", index: 3, uuid: "input-3" },

      // Hidden neurons with various squashes — diversity is what makes
      // the squash improvement scan interesting on the evolved champion.
      { type: "hidden", squash: "TANH", index: 4, bias: 0.1, uuid: "hidden-0" },
      { type: "hidden", squash: "LOGISTIC", index: 5, bias: -0.2, uuid: "hidden-1" },
      { type: "hidden", squash: "LeakyReLU", index: 6, bias: 0.05, uuid: "hidden-2" },
      { type: "hidden", squash: "SELU", index: 7, bias: -0.1, uuid: "hidden-3" },
      { type: "hidden", squash: "Swish", index: 8, bias: 0.15, uuid: "hidden-4" },

      // Output neuron
      { type: "output", squash: "LOGISTIC", index: 9, bias: 0, uuid: "output-0" },
    ],
    synapses: [
      // Input to hidden layer
      { from: 0, to: 4, weight: 0.5 },
      { from: 1, to: 4, weight: -0.3 },
      { from: 1, to: 5, weight: 0.7 },
      { from: 2, to: 5, weight: 0.4 },
      { from: 2, to: 6, weight: -0.2 },
      { from: 3, to: 6, weight: 0.6 },
      { from: 0, to: 7, weight: 0.3 },
      { from: 3, to: 7, weight: -0.4 },
      { from: 1, to: 8, weight: 0.5 },
      { from: 2, to: 8, weight: 0.2 },

      // Hidden to hidden (some depth)
      { from: 4, to: 6, weight: 0.3 },
      { from: 5, to: 7, weight: -0.2 },
      { from: 6, to: 8, weight: 0.4 },

      // Hidden to output
      { from: 4, to: 9, weight: 0.6 },
      { from: 5, to: 9, weight: -0.3 },
      { from: 6, to: 9, weight: 0.4 },
      { from: 7, to: 9, weight: -0.5 },
      { from: 8, to: 9, weight: 0.7 },
    ],
    input: 4,
    output: 1,
  };

  return Creature.fromJSON(asCreatureExport(json));
}

/* ------------------------------------------------------------------ */
/*  CLI entry point                                                    */
/* ------------------------------------------------------------------ */

if (import.meta.main) {
  const startedAt = Date.now();

  // Parse command-line arguments
  const args = parseArgs(Deno.args);
  const targetSquash = args.squash ?? "GELU";

  console.log("🧬 Intelligent Design Example — minimal-seed evolution + squash scan (#214, #302)");
  console.log(`   Target squash: ${targetSquash}`);
  console.log(`   Available squashes: ${alternativeSquashes.length}`);
  console.log("");

  // Set up directories (all under a hidden, gitignored folder)
  const { dataDir, creaturesDir, outputDir } = setupWorkingDirs(WORKING_ROOT);

  // ------------------------------------------------------------------
  // Stage 1 — Build the hand-crafted reference and synthesise the
  // binary `.bin` training set. The reference is only the label oracle.
  // ------------------------------------------------------------------
  console.log(
    "== Stage 1/4: Generating binary training set from a hand-crafted reference ==",
  );
  const reference = createReferenceCreature();
  const referenceExport = reference.exportJSON();
  console.log(
    `   Reference creature: ${reference.input} inputs, ${reference.neurons.length} neurons, ` +
      `${reference.synapses.length} synapses (label oracle only — NEAT-AI does not see it)`,
  );
  generateSyntheticData(reference, dataDir, SYNTHETIC_CONFIG);
  const referencePath = join(creaturesDir, "reference.json");
  await safeWriteJson(referencePath, referenceExport);
  console.log(`   Saved reference creature to ${referencePath}`);

  // ------------------------------------------------------------------
  // Stage 2 — Evolve from a minimal seed (`new Creature(input, output)`).
  // ------------------------------------------------------------------
  console.log("");
  console.log("== Stage 2/4: Evolving from a minimal NEAT-AI seed ==");
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  console.log(
    `   Seed: new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  console.log(
    `   Seed topology: ${seed.neurons.length} neurons, ${seed.synapses.length} synapses`,
  );
  const evolutionConfig = DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${evolutionConfig.targetError}, ` +
      `timeoutMinutes=${evolutionConfig.timeoutMinutes}`,
  );
  const evolution = await runMinimalSeedEvolution(seed, dataDir, evolutionConfig);
  console.log(
    `   Completed ${evolution.generations} generations in ` +
      `${(evolution.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(evolution.finalError) ? evolution.finalError.toFixed(4) : "n/a"
      })`,
  );
  console.log(
    `   Champion topology: ${evolution.summary.finalNeurons} neurons, ` +
      `${evolution.summary.finalSynapses} synapses ` +
      `(seed had ${evolution.seedNeuronCount} / ${evolution.seedSynapseCount})`,
  );
  const championPath = join(creaturesDir, "champion.json");
  const championExport = evolution.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`   Saved evolved champion to ${championPath}`);

  // Score the evolved champion against the binary training set so the
  // squash scan has a baseline to beat.
  const baselineResult = await evolution.champion.scoreDir(dataDir, {});
  const baselineScore = baselineResult.score;
  addTag(championExport, "score", `${baselineScore}`);
  addTag(championExport, "error", `${baselineResult.error}`);
  console.log(`   Evolved champion score: ${baselineScore.toPrecision(6)}`);

  // ------------------------------------------------------------------
  // Stage 3 — Squash improvement scan on the evolved champion.
  // ------------------------------------------------------------------
  console.log("");
  console.log("== Stage 3/4: Scanning the evolved champion for squash improvements ==");
  console.log(`   Testing: ${targetSquash}`);

  const scanResult = await scanForSquashImprovements({
    creature: championExport,
    targetSquash: targetSquash,
    outputDir: outputDir,
    dataDir: dataDir,
    bestScore: baselineScore,
    maxImprovements: 5, // Limit for the example
    timeoutMs: 5 * 60 * 1000, // 5 minutes for the example
    onProgress: (completed, total) => {
      if (completed % 10 === 0) {
        const percent = ((completed / total) * 100).toFixed(1);
        console.log(`   Progress: ${percent}% (${completed}/${total})`);
      }
    },
  });

  console.log(
    `\n✨ Scan complete in ${format(scanResult.duration, { ignoreZero: true })}`,
  );
  console.log(`   Tested: ${scanResult.tested} neurons`);
  console.log(`   Improvements found: ${scanResult.improved}`);
  if (scanResult.timedOut) {
    console.log("   ⏰ Scan was terminated due to timeout");
  }

  // Combine improvements (if any) onto the evolved champion.
  let improvedScore: number | null = null;
  if (scanResult.improvements.size > 0) {
    console.log("\n🧪 Combining improvements on the evolved champion...");

    const { creature: improvedCreature, message } = await combineImprovements(
      championExport,
      scanResult.improvements,
      dataDir,
      baselineScore,
    );

    improvedScore = Number.parseFloat(getTag(improvedCreature, "score") ?? "0");
    const improvement = improvedScore - baselineScore;

    console.log(`   ${message}`);
    console.log(`   Final score: ${improvedScore.toPrecision(6)}`);
    console.log(`   Improvement: ${improvement.toPrecision(3)}`);

    const improvedPath = join(creaturesDir, "improved.json");
    await safeWriteJson(improvedPath, improvedCreature);
    console.log(`   Saved improved creature to ${improvedPath}`);
  } else {
    console.log("\n🚫 No improvements found for this squash function.");
    console.log("   Try a different target squash or a larger creature.");
  }

  // ------------------------------------------------------------------
  // Stage 4 — Emit the milestone summary SVG.
  // ------------------------------------------------------------------
  console.log("");
  console.log("== Stage 4/4: Writing milestone summary SVG ==");
  ensureDirSync("docs/screenshots/intelligent_design");
  const summarySvg = renderEvolveDirSummarySvg(evolution.summary, {
    title: "Intelligent Design — evolveDir Run Summary",
  });
  await Deno.writeTextFile(EVOLUTION_SUMMARY_SVG_PATH, summarySvg);
  console.log(`   📈 Wrote ${EVOLUTION_SUMMARY_SVG_PATH}`);

  // ------------------------------------------------------------------
  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  // ------------------------------------------------------------------
  console.log("");
  console.log("== Summary ==");
  console.log(`   Reference creature: ${referencePath}`);
  console.log(`   Evolved champion:   ${championPath}`);
  console.log(
    `   Final: generations=${evolution.generations}  ` +
      `error=${evolution.summary.finalError.toPrecision(4)}  ` +
      `score=${evolution.summary.finalScore.toPrecision(4)}  ` +
      `neurons=${evolution.summary.finalNeurons}  synapses=${evolution.summary.finalSynapses}`,
  );
  console.log(`   Evolution wall-clock: ${(evolution.wallClockMs / 1000).toFixed(1)}s`);
  if (improvedScore !== null) {
    console.log(
      `   Squash scan: ${scanResult.improved} improvements; ` +
        `score ${baselineScore.toPrecision(6)} → ${improvedScore.toPrecision(6)}`,
    );
  }
  console.log(
    `\n🏁 Demo completed in ${format(Date.now() - startedAt, { ignoreZero: true })}`,
  );
}
