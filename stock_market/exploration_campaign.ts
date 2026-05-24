/**
 * GRQ-style exploration campaign for the stock-market direction
 * prediction example (issue #476).
 *
 * The campaign runs a sequence of **structure phases** (random training
 * subsamples with low `costOfGrowth` so NEAT-AI grows topology cheaply)
 * followed by a **polish phase** (full training set with
 * `costOfGrowth = 0` so weights and biases get a long, undistorted tune)
 * and optionally an **intelligent-design pass** that scans the polished
 * champion for activation-function (squash) improvements.
 *
 * After every phase the champion is honestly scored against the *full*
 * train, validation, and test windows — the per-phase
 * `trainingSampleRate` only affects training fitness, not the reported
 * metrics. The reader of the campaign log therefore sees the same
 * apples-to-apples accuracy series across every phase.
 *
 * All artefacts (per-phase records, champion JSON, run summary) are
 * written under the supplied `workingDir`, which the runner script
 * points at the hidden `.synthetic-stock/exploration/` directory so
 * nothing leaks into the working tree. The canonical
 * `docs/data/stock_market/exploration/` directory is updated only when
 * the caller invokes {@link promoteExplorationArtefacts} (wired to the
 * runner's `--promote` flag).
 *
 * 🌱 Generation 1 of the first phase starts from `new Creature(
 * WINDOW_SIZE, OUTPUT_COUNT)` — the NEAT-AI library's uniform-random
 * constructor. No hidden hint, no pretrained champion, no warm start.
 * Subsequent phases inherit the previous phase's evolved champion in
 * place (NEAT-AI's `Creature.evolveDir` mutates the calling creature).
 */
import { copy, ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  alternativeSquashes,
  combineImprovements,
  Creature,
  type CreatureExport,
  type NeatOptions,
  safeWriteJson,
  scanForSquashImprovements,
} from "@stsoftware/neat-ai";

import {
  balancedDirectionalAccuracy,
  directionalAccuracy,
  OUTPUT_COUNT,
  WINDOW_SIZE,
  writeStockTrainingDataset,
} from "./stock_market.ts";
import type { DataSplit, Sample } from "./data.ts";

/** Slug used by the canonical promote-dir layout. */
export const EXAMPLE_SLUG = "stock_market";

/** Default hidden working directory the runner script points us at. */
export const DEFAULT_WORKING_DIR = ".synthetic-stock/exploration";

/** Default promote-target inside `docs/data/`. */
export const DEFAULT_PROMOTE_DIR = "docs/data/stock_market/exploration";

/** One phase of the exploration campaign. */
export interface ExplorationPhase {
  /** Human-readable phase label, used in summaries and on disk. */
  name: string;
  /**
   * Fraction of training records NEAT-AI samples each generation
   * (forwarded as `NeatOptions.trainingSampleRate`). Must lie in
   * (0, 1]. Structure phases use 0.05–0.15; the polish phase uses 1.
   */
  trainingSampleRate: number;
  /**
   * `NeatOptions.costOfGrowth`. Structure phases use a very small but
   * non-zero value so NEAT-AI keeps adding neurons / synapses quickly;
   * the polish phase uses 0 so weight tuning is undistorted.
   */
  costOfGrowth: number;
  /** Hard generation cap for this phase. */
  maxGenerations: number;
  /**
   * Wall-clock cap for the phase, in minutes. Tests pass 0 to skip
   * NEAT-AI's GPU/discovery FFI cleanup path (the Deno test sanitiser
   * flags its dynamic library as a leak).
   */
  timeoutMinutes: number;
}

/**
 * Default phase schedule mirroring the GRQ-style sampler pattern
 * referenced in issue #476: three structure phases that escalate the
 * training subsample (5% → 10% → 15%) followed by a long polish at full
 * data with `costOfGrowth = 0`.
 */
export const DEFAULT_EXPLORATION_PHASES: readonly ExplorationPhase[] = [
  {
    name: "structure-05pct",
    trainingSampleRate: 0.05,
    costOfGrowth: 0.000001,
    maxGenerations: 50,
    timeoutMinutes: 2,
  },
  {
    name: "structure-10pct",
    trainingSampleRate: 0.10,
    costOfGrowth: 0.000001,
    maxGenerations: 50,
    timeoutMinutes: 2,
  },
  {
    name: "structure-15pct",
    trainingSampleRate: 0.15,
    costOfGrowth: 0.000001,
    maxGenerations: 50,
    timeoutMinutes: 2,
  },
  {
    name: "polish",
    trainingSampleRate: 1,
    costOfGrowth: 0,
    maxGenerations: 200,
    timeoutMinutes: 5,
  },
];

/** Outcome of a single phase, including honest hold-out scores. */
export interface PhaseRecord {
  name: string;
  trainingSampleRate: number;
  costOfGrowth: number;
  generations: number;
  wallClockMs: number;
  /** Final per-record error reported by `evolveDir`. */
  trainError: number;
  /** Final score reported by `evolveDir`. */
  finalScore: number;
  finalNeurons: number;
  finalSynapses: number;
  /** Raw directional accuracy on the **full** training window. */
  trainAccuracy: number;
  /** Balanced directional accuracy on the **full** training window. */
  trainBalanced: number;
  /** Raw directional accuracy on the validation window. */
  validationAccuracy: number;
  /** Balanced directional accuracy on the validation window. */
  validationBalanced: number;
  /** Raw directional accuracy on the test window. */
  testAccuracy: number;
  /** Balanced directional accuracy on the test window. */
  testBalanced: number;
}

/** Optional squash-scan record appended to the summary. */
export interface SquashScanRecord {
  targetSquash: string;
  tested: number;
  improved: number;
  applied: boolean;
  baselineScore: number;
  improvedScore: number | null;
  durationMs: number;
}

/** Full run summary persisted to `summary.json`. */
export interface ExplorationSummary {
  slug: string;
  startedAt: string;
  finishedAt: string;
  totalWallClockMs: number;
  trainSize: number;
  validationSize: number;
  testSize: number;
  phases: PhaseRecord[];
  squashScan: SquashScanRecord | null;
  championNeurons: number;
  championSynapses: number;
  seedNeurons: number;
  seedSynapses: number;
}

/** Configuration for {@link runExplorationCampaign}. */
export interface RunExplorationCampaignOptions {
  /** Chronological train / validation / test split. */
  split: DataSplit;
  /** Feature window size; defaults to {@link WINDOW_SIZE}. */
  windowSize?: number;
  /**
   * Hidden working directory the campaign writes into. The runner
   * script defaults to {@link DEFAULT_WORKING_DIR}.
   */
  workingDir: string;
  /** RNG seed forwarded to every NEAT-AI evolveDir call. */
  seed?: number;
  /** NEAT population size used for every phase. */
  populationSize?: number;
  /** Phase schedule; defaults to {@link DEFAULT_EXPLORATION_PHASES}. */
  phases?: readonly ExplorationPhase[];
  /** When true, runs `scanForSquashImprovements` on the polish champion. */
  squashScan?: boolean;
  /** Optional override for the squash scan's target activation. */
  squashScanTarget?: string;
  /** Optional override for the mutation rate forwarded to NEAT-AI. */
  mutationRate?: number;
  /** Optional override for the mutation amount forwarded to NEAT-AI. */
  mutationAmount?: number;
  /** Optional logger; defaults to `console.log`. Tests pass `() => {}`. */
  log?: (msg: string) => void;
}

/** Combined result returned by {@link runExplorationCampaign}. */
export interface ExplorationResult {
  summary: ExplorationSummary;
  champion: Creature;
  /** Always false from the campaign itself — see {@link promoteExplorationArtefacts}. */
  promoted: boolean;
}

function validatePhase(phase: ExplorationPhase, index: number): void {
  if (phase.trainingSampleRate <= 0 || phase.trainingSampleRate > 1) {
    throw new Error(
      `phase[${index}] (${phase.name}): trainingSampleRate must be in (0, 1], ` +
        `got ${phase.trainingSampleRate}`,
    );
  }
  if (phase.costOfGrowth < 0) {
    throw new Error(
      `phase[${index}] (${phase.name}): costOfGrowth must be >= 0, ` +
        `got ${phase.costOfGrowth}`,
    );
  }
  if (phase.maxGenerations <= 0) {
    throw new Error(
      `phase[${index}] (${phase.name}): maxGenerations must be > 0, ` +
        `got ${phase.maxGenerations}`,
    );
  }
  if (phase.timeoutMinutes < 0) {
    throw new Error(
      `phase[${index}] (${phase.name}): timeoutMinutes must be >= 0, ` +
        `got ${phase.timeoutMinutes}`,
    );
  }
}

function scoreOnSplit(creature: Creature, samples: Sample[]): {
  accuracy: number;
  balanced: number;
} {
  if (samples.length === 0) return { accuracy: 0, balanced: 0 };
  return {
    accuracy: directionalAccuracy(creature, samples),
    balanced: balancedDirectionalAccuracy(creature, samples),
  };
}

/**
 * Run the full structure → polish campaign and return a structured
 * summary plus the evolved champion.
 *
 * The function:
 *   1. Writes the **full** training samples to `<workingDir>/data/` as
 *      a single binary `.bin` file. NEAT-AI's `trainingSampleRate`
 *      handles per-generation subsampling; we never split the dataset.
 *   2. Seeds gen 1 of the first phase from
 *      `new Creature(windowSize, OUTPUT_COUNT)`.
 *   3. For each phase, mutates the creature in place via
 *      `creature.evolveDir(...)` and then scores it against the full
 *      train, validation, and test windows.
 *   4. Persists per-phase records and a final summary to the working
 *      directory; the champion is saved as `champion.json` after every
 *      phase so an interrupted run still leaves the best-so-far on disk.
 */
export async function runExplorationCampaign(
  options: RunExplorationCampaignOptions,
): Promise<ExplorationResult> {
  const phases = options.phases ?? DEFAULT_EXPLORATION_PHASES;
  if (phases.length === 0) {
    throw new Error("runExplorationCampaign: at least one phase is required");
  }
  phases.forEach(validatePhase);

  if (options.split.train.length === 0) {
    throw new Error("runExplorationCampaign: split.train must be non-empty");
  }

  const log = options.log ?? ((msg: string) => console.log(msg));
  const windowSize = options.windowSize ?? WINDOW_SIZE;
  const seed = options.seed ?? 24601;
  const populationSize = options.populationSize ?? 30;
  const mutationRate = options.mutationRate ?? 0.6;
  const mutationAmount = options.mutationAmount ?? 3;

  ensureDirSync(options.workingDir);
  const dataDir = join(options.workingDir, "data");
  ensureDirSync(dataDir);

  // Write the FULL training set; NEAT-AI subsamples per generation via
  // `trainingSampleRate` so the honest hold-out scores after every phase
  // remain comparable.
  writeStockTrainingDataset(options.split.train, dataDir, windowSize);

  const creature = new Creature(windowSize, OUTPUT_COUNT);
  // Pin the output activation to LOGISTIC so the `>= 0.5` directional
  // threshold (and the multi-run example's convention) keeps working.
  const seedJson: CreatureExport = creature.exportJSON();
  for (const neuron of seedJson.neurons) {
    if (neuron.type === "output") neuron.squash = "LOGISTIC";
  }
  const seededCreature = Creature.fromJSON(seedJson);
  const seedNeurons = seededCreature.neurons.length;
  const seedSynapses = seededCreature.synapses.length;

  const startedAt = new Date();
  const campaignStartMs = Date.now();
  const phaseRecords: PhaseRecord[] = [];

  let cursor: Creature = seededCreature;

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    log(
      `▶ Phase ${i + 1}/${phases.length} ${phase.name} ` +
        `sampleRate=${phase.trainingSampleRate} costOfGrowth=${phase.costOfGrowth} ` +
        `gens<=${phase.maxGenerations} timeout=${phase.timeoutMinutes}m`,
    );

    const neatOptions: NeatOptions = {
      seed,
      populationSize,
      iterations: phase.maxGenerations,
      targetError: 0,
      ...(phase.timeoutMinutes > 0
        ? { timeoutMinutes: Math.max(1, Math.floor(phase.timeoutMinutes)) }
        : {}),
      trainingSampleRate: phase.trainingSampleRate,
      costOfGrowth: phase.costOfGrowth,
      mutationRate,
      mutationAmount,
      verbose: false,
      log: 0,
      threads: 1,
    };

    const phaseStart = Date.now();
    const evolved = await cursor.evolveDir(dataDir, neatOptions);
    const wallClockMs = Date.now() - phaseStart;

    const trainScore = scoreOnSplit(cursor, options.split.train);
    const valScore = scoreOnSplit(cursor, options.split.validation);
    const testScore = scoreOnSplit(cursor, options.split.test);

    const record: PhaseRecord = {
      name: phase.name,
      trainingSampleRate: phase.trainingSampleRate,
      costOfGrowth: phase.costOfGrowth,
      generations: Math.max(1, evolved.generation ?? 1),
      wallClockMs,
      trainError: Number.isFinite(evolved.error) ? evolved.error : 0,
      finalScore: Number.isFinite(evolved.score) ? evolved.score : 0,
      finalNeurons: cursor.neurons.length,
      finalSynapses: cursor.synapses.length,
      trainAccuracy: trainScore.accuracy,
      trainBalanced: trainScore.balanced,
      validationAccuracy: valScore.accuracy,
      validationBalanced: valScore.balanced,
      testAccuracy: testScore.accuracy,
      testBalanced: testScore.balanced,
    };
    phaseRecords.push(record);
    log(
      `   gen=${record.generations} err=${record.trainError.toPrecision(4)} ` +
        `neurons=${record.finalNeurons} synapses=${record.finalSynapses} | ` +
        `train=${(record.trainBalanced * 100).toFixed(1)}% bal ` +
        `val=${(record.validationBalanced * 100).toFixed(1)}% bal ` +
        `test=${(record.testBalanced * 100).toFixed(1)}% bal`,
    );

    await safeWriteJson(
      join(options.workingDir, `phase_${i + 1}_${phase.name}.json`),
      record,
    );
    // Persist the best-so-far champion every phase so an interrupted
    // run leaves a usable artefact on disk.
    await safeWriteJson(join(options.workingDir, "champion.json"), cursor.exportJSON());
  }

  // Optional squash scan on the polished champion.
  let squashScan: SquashScanRecord | null = null;
  if (options.squashScan) {
    const target = options.squashScanTarget ?? "GELU";
    log(`▶ Squash scan: target=${target} pool=${alternativeSquashes.length}`);
    const baselineResult = await cursor.scoreDir(dataDir, {});
    const baselineScore = baselineResult.score;
    const outputDir = join(options.workingDir, "squash");
    ensureDirSync(outputDir);
    const scanStart = Date.now();
    const scan = await scanForSquashImprovements({
      creature: cursor.exportJSON(),
      targetSquash: target,
      outputDir,
      dataDir,
      bestScore: baselineScore,
      maxImprovements: 5,
      timeoutMs: 5 * 60 * 1000,
    });
    let improvedScore: number | null = null;
    let applied = false;
    if (scan.improvements.size > 0) {
      const { creature: improvedExport } = await combineImprovements(
        cursor.exportJSON(),
        scan.improvements,
        dataDir,
        baselineScore,
      );
      cursor = Creature.fromJSON(improvedExport);
      const replay = await cursor.scoreDir(dataDir, {});
      improvedScore = replay.score;
      applied = improvedScore > baselineScore;
    }
    squashScan = {
      targetSquash: target,
      tested: scan.tested,
      improved: scan.improved,
      applied,
      baselineScore,
      improvedScore,
      durationMs: Date.now() - scanStart,
    };
    log(
      `   tested=${scan.tested} improved=${scan.improved} applied=${applied} ` +
        `baseline=${baselineScore.toPrecision(4)} -> ` +
        `${improvedScore === null ? "n/a" : improvedScore.toPrecision(4)}`,
    );
    await safeWriteJson(join(options.workingDir, "squash_scan.json"), squashScan);
    await safeWriteJson(join(options.workingDir, "champion.json"), cursor.exportJSON());
  }

  const finishedAt = new Date();
  const summary: ExplorationSummary = {
    slug: EXAMPLE_SLUG,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalWallClockMs: Date.now() - campaignStartMs,
    trainSize: options.split.train.length,
    validationSize: options.split.validation.length,
    testSize: options.split.test.length,
    phases: phaseRecords,
    squashScan,
    championNeurons: cursor.neurons.length,
    championSynapses: cursor.synapses.length,
    seedNeurons,
    seedSynapses,
  };
  await safeWriteJson(join(options.workingDir, "summary.json"), summary);

  return { summary, champion: cursor, promoted: false };
}

/** Options for {@link promoteExplorationArtefacts}. */
export interface PromoteOptions {
  /** Working directory the campaign wrote into. */
  workingDir: string;
  /**
   * Promote target — typically `docs/data/stock_market/exploration/`.
   * Created if it does not exist.
   */
  promoteDir: string;
}

/**
 * Copy `champion.json`, `summary.json`, and any `phase_*.json` records
 * from the hidden working directory to the promote target. Returns
 * `true` when the promote happens, `false` if there is nothing to copy.
 *
 * The campaign deliberately does **not** call this itself — the runner
 * script wires it to an explicit `--promote` flag so a casual local
 * exploration run never overwrites the canonical artefacts under
 * `docs/data/`.
 */
export async function promoteExplorationArtefacts(
  options: PromoteOptions,
): Promise<boolean> {
  const championSrc = join(options.workingDir, "champion.json");
  const summarySrc = join(options.workingDir, "summary.json");
  try {
    await Deno.stat(championSrc);
    await Deno.stat(summarySrc);
  } catch {
    return false;
  }
  ensureDirSync(options.promoteDir);
  await copy(championSrc, join(options.promoteDir, "champion.json"), { overwrite: true });
  await copy(summarySrc, join(options.promoteDir, "summary.json"), { overwrite: true });

  // Copy every per-phase record so the promoted snapshot is complete.
  for await (const entry of Deno.readDir(options.workingDir)) {
    if (entry.isFile && entry.name.startsWith("phase_") && entry.name.endsWith(".json")) {
      await copy(
        join(options.workingDir, entry.name),
        join(options.promoteDir, entry.name),
        { overwrite: true },
      );
    }
    if (entry.isFile && entry.name === "squash_scan.json") {
      await copy(
        join(options.workingDir, entry.name),
        join(options.promoteDir, entry.name),
        { overwrite: true },
      );
    }
  }
  return true;
}
