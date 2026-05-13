#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi

/**
 * Evolution Showcase Example — minimal-seed evolution + milestone summary
 * (audit issue #211, per-generation telemetry retired under #301).
 *
 * The pre-audit demo seeded NEAT-AI with a hand-tuned topology and ran a
 * bespoke evolution loop. The audit (#211) repurposes the example so the
 * published evolution genuinely *learns* the network structure from a
 * minimal NEAT-AI seed:
 *
 *   1. The hand-crafted teacher creature is still built, but it is used
 *      **only** as the ground-truth that synthesises labels for the
 *      binary `.bin` training set. NEAT-AI never sees it as a seed.
 *   2. The seed passed to NEAT-AI is `new Creature(INPUT_COUNT,
 *      OUTPUT_COUNT)` — no hidden-layer hint, no pre-built
 *      `network.json`, no hand-tuned shape.
 *   3. `Creature.evolveDir(dataDir, options)` runs forward-only over the
 *      pre-generated `.bin` training set (per #190) until either the
 *      `targetError` threshold is reached or the `timeoutMinutes: 5`
 *      backstop fires.
 *   4. Under #301 the per-generation `onTrainingEvent` hook, the chunked
 *      `evolveDir` loop, and the multi-panel checkpoint strip were
 *      removed in favour of NEAT-AI's supported milestone-only
 *      telemetry surface (see [#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298)
 *      for the decision record). The run now makes one `evolveDir` call
 *      and renders a single milestone summary SVG from its return value
 *      via the shared `EvolveDirSummary` helper from #284.
 */

import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  type NeatOptions,
  safeWriteJson,
} from "@stsoftware/neat-ai";

import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";

/** Number of input features used by both teacher and learner creatures. */
export const INPUT_COUNT = 4;

/** Number of outputs (single-output regression). */
export const OUTPUT_COUNT = 1;

/** Hidden working directory root for this example's artefacts. */
export const SHOWCASE_ROOT = ".synthetic-evolution-showcase";

/** Milestone summary SVG path — sourced from `evolveDir`'s return value (#301). */
export const EVOLUTION_SUMMARY_SVG_PATH =
  "docs/screenshots/evolution_showcase/evolution_summary.svg";

/** Synthetic dataset configuration — deterministic and small enough for fast scoring. */
export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 96,
  recordsPerFile: 96,
  seed: 96009600,
};

/** Configuration for the minimal-seed evolution run. */
export interface ShowcaseEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /** Wall-clock backstop in minutes (issue #211 mandates 5 as upper bound). */
  timeoutMinutes: number;
  /** NEAT population size. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /** RNG seed forwarded to NEAT-AI for deterministic-ish runs. */
  seed: number;
}

/**
 * Defaults tuned so the demo runs for tens of seconds on a developer
 * machine while showing visible neuron / synapse growth from the
 * minimal seed.
 *
 * The teacher creature this minimal seed has to imitate sums two
 * products of saturating-TANH hidden activations — non-trivial enough
 * that a hidden-less direct seed plateaus quickly. The default
 * `targetError` of 0.05 is reasonable for the task: it forces real
 * structural growth (a direct seed plateaus around per-record error
 * 0.27) but is still reachable inside the 5-minute backstop. Runs that
 * hit the `maxIterations` cap before the target is met still produce
 * the milestone summary chart.
 */
export const DEFAULT_SHOWCASE_EVOLUTION_CONFIG: ShowcaseEvolutionConfig = {
  targetError: 0.05,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterations: 3000,
  seed: 211_211,
};

/** Result of {@link runMinimalSeedShowcase}. */
export interface ShowcaseEvolutionResult {
  /** The best creature found by `evolveDir`. */
  champion: Creature;
  /** Milestone summary built from `evolveDir`'s return value (issue #301). */
  summary: EvolveDirSummary;
  /** Total wall-clock time of the evolution call, in milliseconds. */
  wallClockMs: number;
  /** Final per-record error returned by `evolveDir`. */
  finalError: number;
  /** Total generations completed. */
  generations: number;
}

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
// Dataset preparation
// ---------------------------------------------------------------------------

/**
 * Build the synthetic dataset on disk (if missing). Returns the directory
 * holding the binary `.bin` files. Subsequent calls reuse the existing
 * files so `evolveDir` always reads byte-identical data.
 */
export function prepareDataset(dataDir: string): string {
  ensureDirSync(dataDir);
  const hasData = [...Deno.readDirSync(dataDir)].some(
    (e) => e.isFile && e.name.endsWith(".bin"),
  );
  if (!hasData) {
    const teacher = createTeacherCreature();
    generateSyntheticData(teacher, dataDir, SYNTHETIC_CONFIG);
  }
  return dataDir;
}

// ---------------------------------------------------------------------------
// Evolution loop (single evolveDir call)
// ---------------------------------------------------------------------------

/**
 * Run minimal-seed `evolveDir` against the binary `.bin` training set in
 * `dataDir` and return a milestone summary built from its return value.
 *
 * The seed passed in must be `new Creature(INPUT_COUNT, OUTPUT_COUNT)` —
 * this function deliberately does not construct the seed itself so the
 * caller (and the tests) can prove no hidden-layer hint leaks in.
 */
export async function runMinimalSeedShowcase(
  seed: Creature,
  dataDir: string,
  config: ShowcaseEvolutionConfig = DEFAULT_SHOWCASE_EVOLUTION_CONFIG,
): Promise<ShowcaseEvolutionResult> {
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");
  if (config.maxIterations <= 0) throw new Error("maxIterations must be positive");

  const seedNeurons = seed.neurons.length;
  const seedSynapses = seed.synapses.length;

  const neatOptions: NeatOptions = {
    seed: config.seed,
    populationSize: config.populationSize,
    iterations: config.maxIterations,
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
  };

  const start = Date.now();
  const result = await seed.evolveDir(dataDir, neatOptions);
  const wallClockMs = Date.now() - start;

  const finalError = Number.isFinite(result.error) ? result.error : 0;
  const finalScore = Number.isFinite(result.score) ? result.score : 0;
  const generations = Math.max(1, result.generation ?? 1);

  const summary: EvolveDirSummary = {
    finalError,
    finalScore,
    wallClockMs,
    generations,
    seedNeurons,
    seedSynapses,
    finalNeurons: seed.neurons.length,
    finalSynapses: seed.synapses.length,
    targetError: config.targetError,
    timeoutMinutes: config.timeoutMinutes,
  };

  return {
    champion: seed,
    summary,
    wallClockMs,
    finalError,
    generations,
  };
}

// ---------------------------------------------------------------------------
// Runner entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Evolution Showcase Example — minimal-seed evolution (issue #211)");
  console.log("");

  const stage = (label: string) => console.log(`\n== ${label} ==`);

  const { dataDir, creaturesDir } = setupWorkingDirs(SHOWCASE_ROOT);

  // Stage 1 — Build the hand-crafted teacher creature and synthesise the
  // binary `.bin` training set. The teacher is the *label oracle* only;
  // NEAT-AI never sees it.
  stage("Stage 1/3: Generating binary training set from a hand-crafted teacher");
  const teacher = createTeacherCreature();
  console.log(
    `   Teacher creature: ${teacher.input} inputs, ${teacher.neurons.length} neurons, ` +
      `${teacher.synapses.length} synapses (label oracle only — NEAT-AI does not see it)`,
  );
  prepareDataset(dataDir);
  const teacherPath = join(creaturesDir, "teacher.json");
  await safeWriteJson(teacherPath, teacher.exportJSON());
  console.log(`   Saved teacher creature to ${teacherPath}`);

  // Stage 2 — Evolve from the minimal seed.
  stage("Stage 2/3: Evolving from a minimal NEAT-AI seed");
  console.log(
    `   Seed: new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  console.log(
    `   Seed topology: ${seed.neurons.length} neurons, ${seed.synapses.length} synapses`,
  );

  const config = DEFAULT_SHOWCASE_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${config.targetError}, ` +
      `timeoutMinutes=${config.timeoutMinutes} (issue #211 backstop)`,
  );

  const result = await runMinimalSeedShowcase(seed, dataDir, config);
  console.log(
    `   Completed ${result.generations} generations in ` +
      `${(result.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(result.finalError) ? result.finalError.toFixed(4) : "n/a"
      })`,
  );
  console.log(
    `   Champion topology: ${result.summary.finalNeurons} neurons, ` +
      `${result.summary.finalSynapses} synapses ` +
      `(seed had ${result.summary.seedNeurons} / ${result.summary.seedSynapses})`,
  );

  // Save champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`   Saved evolved champion to ${championPath}`);

  // Stage 3 — Emit the milestone summary SVG (issue #301).
  stage("Stage 3/3: Writing milestone summary SVG");
  ensureDirSync("docs/screenshots/evolution_showcase");
  const summarySvg = renderEvolveDirSummarySvg(result.summary, {
    title: "Evolution Showcase — evolveDir Run Summary",
  });
  await Deno.writeTextFile(EVOLUTION_SUMMARY_SVG_PATH, summarySvg);
  console.log(`   📈 Wrote ${EVOLUTION_SUMMARY_SVG_PATH}`);

  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  stage("Summary");
  console.log(`   Teacher creature:  ${teacherPath}`);
  console.log(`   Evolved champion:  ${championPath}`);
  console.log(
    `   Final summary: generations=${result.summary.generations}  ` +
      `bestScore=${result.summary.finalScore.toFixed(4)}  ` +
      `bestError=${result.summary.finalError.toFixed(4)}  ` +
      `seed=${result.summary.seedNeurons}/${result.summary.seedSynapses}  ` +
      `final=${result.summary.finalNeurons}/${result.summary.finalSynapses}`,
  );
  console.log(`   Wall-clock: ${(result.wallClockMs / 1000).toFixed(1)}s`);
  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
