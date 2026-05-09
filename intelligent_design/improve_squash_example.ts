/**
 * Intelligent Design Example — minimal-seed evolution + squash scan
 * (audit issue #214).
 *
 * This example keeps its original purpose — systematically test
 * different activation functions (squashes) for each hidden neuron in a
 * creature — but the audit (#214) brings the seed and the published
 * telemetry into line with the rest of the suite:
 *
 *   1. The hand-crafted reference creature is now used **only** as the
 *      label oracle that synthesises the binary `.bin` training set.
 *      NEAT-AI never sees it.
 *   2. The seed passed to NEAT-AI is `new Creature(INPUT_COUNT,
 *      OUTPUT_COUNT)` — no hidden-layer hint, no pre-built
 *      `network.json`, no hand-tuned shape.
 *   3. `Creature.evolveDir(dataDir, options)` runs forward-only over the
 *      pre-generated `.bin` training set until either the per-example
 *      `targetError` threshold is reached or the `timeoutMinutes: 5`
 *      backstop fires.
 *   4. Per-generation telemetry (best/mean fitness + neuron / synapse
 *      counts) is captured via `onTrainingEvent` and emitted as a CSV
 *      plus two SVG charts so the README can quote the *measured*
 *      numbers from the latest run only.
 *   5. The "intelligent design" framing is preserved by running
 *      `scanForSquashImprovements` on the **evolved champion** — the
 *      example demonstrates that even after evolution there are still
 *      activation-function substitutions that improve the score.
 *
 * The pre-audit `createReferenceCreature` and `generateSyntheticData`
 * helpers are retained as exports — they document the historical
 * framing and are still exercised by the unit tests.
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

import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";

export { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-intelligent-design";

/** Per-generation evolution-telemetry CSV path (audit #214 schema). */
export const EVOLUTION_CSV_PATH = "docs/data/intelligent_design/evolution.csv";

/** CSV header — matches the schema mandated by issue #214. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/intelligent_design/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/intelligent_design/topology.svg";

/** Number of input neurons fed to the NEAT-AI seed and the reference creature. */
export const INPUT_COUNT = 4;

/** Number of output neurons fed to the NEAT-AI seed and the reference creature. */
export const OUTPUT_COUNT = 1;

/**
 * Synthetic-data configuration used by both the legacy helper and the
 * minimal-seed runner. The seed is the same as the pre-audit version so
 * existing data fixtures stay reproducible.
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
  /** Wall-clock backstop in minutes (issue #214 mandates 5 as upper bound). */
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
 *
 * The reference creature this seed must imitate has 4 inputs, 5 hidden
 * neurons (with mixed squashes), and 1 output (see
 * {@link createReferenceCreature}). A `targetError` of 0.005 is tight
 * enough that the minimal seed has to grow real hidden structure while
 * still being reachable inside the 5-minute backstop.
 */
export const DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG: MinimalSeedEvolutionConfig = {
  targetError: 0.005,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterations: 300,
  mutationRate: 0.6,
  mutationAmount: 3,
  seed: 214214,
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
export interface MinimalSeedEvolutionResult {
  /** The best creature found by `evolveDir` (same JS object as the seed). */
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
  /** True when the run ended because `targetError` was reached. */
  solved: boolean;
}

/**
 * Iterations per `evolveDir` chunk. Chunking the run keeps the
 * per-generation telemetry chart in step with topology mutations: the
 * passed-in `creature` reference is only updated at the end of each
 * `evolveDir` call, so smaller chunks make the neuron / synapse line
 * climb in visible step changes rather than as a single jump at the end.
 */
const TELEMETRY_CHUNK_ITERATIONS = 25;

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

/**
 * Run minimal-seed `evolveDir` against the binary `.bin` training set
 * in `dataDir`, capturing per-generation telemetry for the README.
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

  const rows: EvolutionRow[] = [];
  const start = Date.now();
  const budgetMs = config.timeoutMinutes > 0
    ? config.timeoutMinutes * 60_000
    : Number.POSITIVE_INFINITY;

  let evolved = 0;
  let finalError = Number.POSITIVE_INFINITY;
  let solved = false;

  while (evolved < config.maxIterations) {
    // The creature reference is updated by `evolveDir` at the end of
    // each call. Re-read its topology *before* the next chunk so the
    // event handler reports the latest neuron / synapse counts for
    // every generation inside the chunk.
    const segmentStartNeurons = seed.neurons.length;
    const segmentStartSynapses = seed.synapses.length;

    if (Date.now() - start >= budgetMs) break;

    const remaining = config.maxIterations - evolved;
    const chunkIterations = Math.min(TELEMETRY_CHUNK_ITERATIONS, remaining);

    const neatOptions: NeatOptions = {
      seed: config.seed + evolved,
      populationSize: config.populationSize,
      iterations: chunkIterations,
      targetError: config.targetError,
      // Tests pass timeoutMinutes=0 to suppress NEAT-AI's GPU/discovery
      // FFI cleanup (it confuses Deno's resource sanitiser); production
      // runs use the issue #214 backstop of 5.
      ...(config.timeoutMinutes > 0
        ? { timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)) }
        : {}),
      // No feedbackLoop key → engine treats the run as forward-only.
      costOfGrowth: 0,
      // Push NEAT toward structural growth so the example genuinely
      // adds hidden neurons / inter-layer synapses from the minimal
      // seed — required by the audit's "neuron and synapse counts
      // genuinely change" acceptance criterion.
      mutationRate: config.mutationRate,
      mutationAmount: config.mutationAmount,
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

    // Post-chunk: emit one extra row capturing the **new** topology
    // counts so the CSV/SVG charts pick up structural growth that
    // landed during the chunk. Without this row a chunk-internal
    // ADD_NODE / ADD_CONN would not appear until the next chunk's
    // events.
    const postNeurons = seed.neurons.length;
    const postSynapses = seed.synapses.length;
    if (postNeurons !== segmentStartNeurons || postSynapses !== segmentStartSynapses) {
      rows.push({
        generation: evolved,
        bestFitness: Number.isFinite(result.score)
          ? result.score
          : Math.max(0, 1 - (result.error ?? 1)),
        meanFitness: Number.NaN,
        neuronCount: postNeurons,
        synapseCount: postSynapses,
      });
    }

    if (finalError <= config.targetError) {
      solved = true;
      break;
    }
    if (completed < chunkIterations) break;
  }

  // Patch the final row so the chart shows the post-evolution topology
  // — `evolveDir` updates the creature reference *after* the last event
  // fires inside the chunk, so without this fix-up the last row may
  // still report the pre-chunk counts.
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
    solved,
  };
}

/* ------------------------------------------------------------------ */
/*  Legacy helper — hand-crafted reference creature (label oracle)     */
/* ------------------------------------------------------------------ */

/**
 * Build a hand-crafted reference creature with diverse hidden squashes.
 *
 * Post-audit (#214) this creature is **only** used as the label oracle
 * that synthesises the binary `.bin` training set. NEAT-AI never sees
 * it as a seed. The diverse squash mix is what gives the squash
 * improvement scan something interesting to optimise on the **evolved**
 * champion.
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

  console.log("🧬 Intelligent Design Example — minimal-seed evolution + squash scan (issue #214)");
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
      `timeoutMinutes=${evolutionConfig.timeoutMinutes} (issue #214 backstop)`,
  );
  const evolution = await runMinimalSeedEvolution(seed, dataDir, evolutionConfig);
  const finalRow = evolution.rows[evolution.rows.length - 1];
  console.log(
    `   Completed ${evolution.generations} generations in ` +
      `${(evolution.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(evolution.finalError) ? evolution.finalError.toFixed(4) : "n/a"
      })`,
  );
  if (finalRow) {
    console.log(
      `   Champion topology: ${finalRow.neuronCount} neurons, ` +
        `${finalRow.synapseCount} synapses ` +
        `(seed had ${evolution.seedNeuronCount} / ${evolution.seedSynapseCount})`,
    );
  }
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
  // Stage 4 — Emit the per-generation telemetry artefacts.
  // ------------------------------------------------------------------
  console.log("");
  console.log("== Stage 4/4: Writing per-generation telemetry (CSV + 2 SVGs) ==");
  if (evolution.rows.length === 0) {
    console.log("   ⚠️  No per-generation events captured — telemetry skipped.");
  } else {
    ensureDirSync("docs/data/intelligent_design");
    ensureDirSync("docs/screenshots/intelligent_design");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(evolution.rows));
    console.log(`   🗒️  Wrote ${EVOLUTION_CSV_PATH} (${evolution.rows.length} rows)`);

    const fitnessSvg = renderFitnessChartSVG(rowsToFitnessSamples(evolution.rows), {
      title: "Intelligent Design — Best vs Mean Fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`   📈 Wrote ${FITNESS_SVG_PATH}`);

    const topologySvg = renderEvolutionChartSVG(rowsToEvolutionSamples(evolution.rows), {
      title: "Intelligent Design — Score, Neurons, Synapses per Generation",
    });
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, topologySvg);
    console.log(`   📈 Wrote ${TOPOLOGY_SVG_PATH}`);
  }

  // ------------------------------------------------------------------
  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  // ------------------------------------------------------------------
  console.log("");
  console.log("== Summary ==");
  console.log(`   Reference creature: ${referencePath}`);
  console.log(`   Evolved champion:   ${championPath}`);
  if (finalRow) {
    console.log(
      `   Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${
          Number.isFinite(finalRow.meanFitness) ? finalRow.meanFitness.toFixed(4) : "n/a"
        }  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
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
