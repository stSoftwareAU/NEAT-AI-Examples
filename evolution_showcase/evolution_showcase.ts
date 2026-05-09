#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi

/**
 * Evolution Showcase Example — minimal-seed evolution + measured telemetry
 * (audit issue #211).
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
 *   4. Per-generation telemetry (best/mean fitness + neuron / synapse
 *      counts) is captured via `onTrainingEvent` and emitted as a CSV
 *      plus two SVG charts so the README can quote the *measured*
 *      numbers from the latest run only.
 *   5. The legacy multi-panel SVG strip is still rendered at the canonical
 *      checkpoints — `[1, 10, 100, 1000, 10000]` — so the
 *      gen-1-vs-late-gen contrast remains visible at a glance.
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

import {
  captureSnapshot,
  DEFAULT_CHECKPOINTS,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";

/** Number of input features used by both teacher and learner creatures. */
export const INPUT_COUNT = 4;

/** Number of outputs (single-output regression). */
export const OUTPUT_COUNT = 1;

/** Path the runner writes the rendered multi-panel SVG to. */
export const SCREENSHOT_PATH = "docs/screenshots/evolution_showcase_evolution.svg";

/** Hidden working directory root for this example's artefacts. */
export const SHOWCASE_ROOT = ".synthetic-evolution-showcase";

/** Per-generation evolution-telemetry CSV path. */
export const EVOLUTION_CSV_PATH = "docs/data/evolution_showcase/evolution.csv";

/** CSV header — schema mandated by issue #211. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/evolution_showcase/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/evolution_showcase/topology.svg";

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
 * minimal seed and reaching at least the gen-1000 canonical checkpoint
 * for the multi-panel snapshot SVG.
 *
 * The teacher creature this minimal seed has to imitate sums two
 * products of saturating-TANH hidden activations — non-trivial enough
 * that a hidden-less direct seed plateaus quickly. The default
 * `targetError` of 0.05 is reasonable for the task: it forces real
 * structural growth (a direct seed plateaus around per-record error
 * 0.27) but is still reachable inside the 5-minute backstop. Runs that
 * hit the `maxIterations` cap before the target is met still produce
 * the audit's required artefacts — the CSV, both telemetry charts, and
 * the multi-panel snapshot SVG — and the final fitness is quoted in
 * the README from the most recent measured run.
 */
export const DEFAULT_SHOWCASE_EVOLUTION_CONFIG: ShowcaseEvolutionConfig = {
  targetError: 0.05,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterations: 3000,
  seed: 211_211,
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

/** Result of {@link runMinimalSeedShowcase}. */
export interface ShowcaseEvolutionResult {
  /** The best creature found by `evolveDir`. */
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
// Telemetry emission helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Evolution loop (chunked evolveDir)
// ---------------------------------------------------------------------------

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
 * `dataDir`, capturing per-generation telemetry plus optional checkpoint
 * snapshots for the README.
 *
 * The seed passed in must be `new Creature(INPUT_COUNT, OUTPUT_COUNT)` —
 * this function deliberately does not construct the seed itself so the
 * caller (and the tests) can prove no hidden-layer hint leaks in.
 */
export async function runMinimalSeedShowcase(
  seed: Creature,
  dataDir: string,
  config: ShowcaseEvolutionConfig = DEFAULT_SHOWCASE_EVOLUTION_CONFIG,
  snapshotConfig?: SnapshotConfig,
): Promise<ShowcaseEvolutionResult> {
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
  // Track which checkpoints have been written so we never double-capture.
  const capturedCheckpoints = new Set<number>();

  while (evolved < config.maxIterations) {
    // Re-read the creature topology *before* the next chunk so the event
    // handler reports the latest neuron / synapse counts for every
    // generation inside the chunk.
    const segmentStartNeurons = seed.neurons.length;
    const segmentStartSynapses = seed.synapses.length;

    const elapsedMs = Date.now() - start;
    if (elapsedMs >= budgetMs) break;

    const remaining = config.maxIterations - evolved;
    const chunkIterations = Math.min(PHASE_CHUNK_ITERATIONS, remaining);

    let chunkBestFitness = -Infinity;
    let chunkLastGeneration = evolved;

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
        const generation = evolved + event.generation;
        rows.push({
          generation,
          bestFitness: event.bestFitness,
          meanFitness: event.averageFitness,
          neuronCount: segmentStartNeurons,
          synapseCount: segmentStartSynapses,
        });
        if (event.bestFitness > chunkBestFitness) {
          chunkBestFitness = event.bestFitness;
        }
        chunkLastGeneration = generation;
      },
    };

    const result = await seed.evolveDir(dataDir, neatOptions);
    const completed = result.generation ?? chunkIterations;
    evolved += completed;
    finalError = result.error ?? finalError;

    // Capture a snapshot at any checkpoint generation reached during the
    // chunk. The creature reference is now updated to the post-chunk
    // champion topology, so the snapshot reflects what NEAT-AI looked
    // like at the end of the chunk.
    if (snapshotConfig) {
      const lastGen = chunkLastGeneration > 0 ? chunkLastGeneration : evolved;
      for (const checkpoint of snapshotConfig.checkpoints) {
        if (capturedCheckpoints.has(checkpoint)) continue;
        if (checkpoint > lastGen) continue;
        const snapScore = Number.isFinite(chunkBestFitness)
          ? chunkBestFitness
          : (rows[rows.length - 1]?.bestFitness ?? 0);
        captureSnapshot(
          snapshotConfig,
          checkpoint,
          seed.exportJSON(),
          snapScore,
        );
        capturedCheckpoints.add(checkpoint);
      }
    }

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

  // Capture a snapshot at the final generation if it is one of the
  // configured checkpoints (and was not already captured).
  if (snapshotConfig && rows.length > 0) {
    const finalGen = rows[rows.length - 1].generation;
    for (const checkpoint of snapshotConfig.checkpoints) {
      if (capturedCheckpoints.has(checkpoint)) continue;
      if (checkpoint > finalGen) continue;
      captureSnapshot(
        snapshotConfig,
        checkpoint,
        seed.exportJSON(),
        rows[rows.length - 1].bestFitness,
      );
      capturedCheckpoints.add(checkpoint);
    }
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

// ---------------------------------------------------------------------------
// Runner entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Evolution Showcase Example — minimal-seed evolution (issue #211)");
  console.log("");

  const stage = (label: string) => console.log(`\n== ${label} ==`);

  const { dataDir, creaturesDir } = setupWorkingDirs(SHOWCASE_ROOT);
  const snapshotsDir = join(SHOWCASE_ROOT, "snapshots");
  ensureDirSync(snapshotsDir);

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

  const snapshotConfig: SnapshotConfig = {
    checkpoints: [...DEFAULT_CHECKPOINTS],
    outputDir: snapshotsDir,
  };
  const result = await runMinimalSeedShowcase(seed, dataDir, config, snapshotConfig);
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

  // Save champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`   Saved evolved champion to ${championPath}`);

  // Stage 3 — Emit per-generation telemetry artefacts.
  stage("Stage 3/3: Writing per-generation telemetry (CSV + 3 SVGs)");
  if (result.rows.length === 0) {
    console.log("   ⚠️  No per-generation events captured — telemetry skipped.");
  } else {
    ensureDirSync("docs/data/evolution_showcase");
    ensureDirSync("docs/screenshots/evolution_showcase");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(result.rows));
    console.log(`   🗒️  Wrote ${EVOLUTION_CSV_PATH} (${result.rows.length} rows)`);

    const fitnessSvg = renderFitnessChartSVG(rowsToFitnessSamples(result.rows), {
      title: "Evolution Showcase — Best vs Mean Fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`   📈 Wrote ${FITNESS_SVG_PATH}`);

    const topologySvg = renderEvolutionChartSVG(rowsToEvolutionSamples(result.rows), {
      title: "Evolution Showcase — Score, Neurons, Synapses per Generation",
    });
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, topologySvg);
    console.log(`   📈 Wrote ${TOPOLOGY_SVG_PATH}`);
  }

  // Render the canonical multi-panel snapshot strip from whatever
  // checkpoints were captured. This is the SVG embedded under the main
  // README's Screenshots section (`readme_structure_test.ts` enforces the
  // path), so we render it regardless of whether the topology
  // chart was emitted.
  const snapshots = loadSnapshots(snapshotsDir);
  if (snapshots.length === 0) {
    console.warn("   ⚠️  No snapshots captured — multi-panel SVG not rendered.");
  } else {
    const wallClockMs = Date.now() - start;
    const finalScore = result.rows[result.rows.length - 1]?.bestFitness ?? 0;
    const svg = renderEvolutionProgressSvg(snapshots, {
      title: "Evolution Showcase — minimal seed → evolved champion",
      caption: {
        finalScore,
        totalGenerations: result.generations,
        wallClockMs,
        text: "minimal-seed evolveDir (issue #211)",
      },
    });
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(`   🖼️  Wrote ${SCREENSHOT_PATH} (${snapshots.length} panels)`);
  }

  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  stage("Summary");
  console.log(`   Teacher creature:  ${teacherPath}`);
  console.log(`   Evolved champion:  ${championPath}`);
  if (finalRow) {
    console.log(
      `   Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${finalRow.meanFitness.toFixed(4)}  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(`   Wall-clock: ${(result.wallClockMs / 1000).toFixed(1)}s`);
  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
