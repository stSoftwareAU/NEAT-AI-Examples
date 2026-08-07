/**
 * MNIST recorded-evolution campaign — sampled exploration, full-data
 * polish, optional intelligent-design squash scan. Every phase appends a
 * milestone under `docs/data/mnist_classification/` and refreshes the error,
 * complexity, and **timeline** charts so readers can see how long the
 * journey took. Pass `--fresh` to wipe the creature, stats, and charts and
 * start recording again from scratch.
 */

import { parseArgs } from "@std/cli";
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  combineImprovements,
  Creature,
  type CreatureExport,
  safeWriteJson,
  scanForSquashImprovements,
} from "@stsoftware/neat-ai";
import { getTag } from "@stsoftware/tags/mod";

import {
  BIN_TRAIN_DIR,
  buildMnistFactorySeed,
  classificationAccuracy,
  confusionMatrix,
  evolveMnistClassifier,
  MNIST_EVOLVE_COST_NAME,
  MNIST_EXPLORATION_ROOT,
  type MnistEvolveOptions,
  readMnistTrainingRecords,
  TEST_IMAGES_PATH,
  TEST_IMAGES_SHA256,
  TEST_IMAGES_URL,
  TEST_LABELS_PATH,
  TEST_LABELS_SHA256,
  TEST_LABELS_URL,
  TRAIN_IMAGES_PATH,
  TRAIN_IMAGES_SHA256,
  TRAIN_IMAGES_URL,
  TRAIN_LABELS_PATH,
  TRAIN_LABELS_SHA256,
  TRAIN_LABELS_URL,
  writeMnistTrainingBin,
} from "./mnist_classification.ts";
import {
  buildDigitSamples,
  CLASS_COUNT,
  type DigitSample,
  type DigitSplit,
  FEATURE_COUNT,
  parseIdxImages,
  parseIdxLabels,
  readGzippedFile,
} from "./data.ts";
import { fetchDataset } from "../common/data_cache.ts";
import { loadMultiRunState } from "../common/multi_run_state.ts";
import {
  type HoldoutScores,
  persistMnistRecordedPhase,
  wipeRecordedEvolution,
} from "./recorded_evolution.ts";
import {
  elitismForArchivedChampions,
  maybeUpdateSampleRateChampion,
  savePhaseChampion,
  shouldAdvanceLineageChampion,
} from "./phase_champions.ts";
import {
  intelligentDesignOutputDir,
  loadPopulationPoolSeeds,
  loopIndexFromPhaseName,
  priorLoopPhaseNames,
  saveSamplerLoopChampion,
  wipePopulationPool,
} from "./population_pool.ts";
import { DEFAULT_SQUASH_CANDIDATES, randomWeightedSquash } from "./squash_random.ts";

/** Hidden working directory for exploration state (never checked in). */
export const EXPLORATION_ROOT = MNIST_EXPLORATION_ROOT;

/** Campaign artefact paths under one exploration root (tests pass a temp dir). */
export function explorationPaths(explorationRoot = EXPLORATION_ROOT): {
  champion: string;
  phaseLog: string;
  summary: string;
  calibration: string;
  generationLog: string;
  experiments: string;
} {
  return {
    champion: join(explorationRoot, "champion.json"),
    phaseLog: join(explorationRoot, "phases.jsonl"),
    summary: join(explorationRoot, "campaign_summary.json"),
    calibration: join(explorationRoot, "calibration.json"),
    generationLog: join(explorationRoot, "generations.tsv"),
    experiments: join(explorationRoot, "experiments"),
  };
}

/** Persisted champion between exploration phases. */
export const EXPLORATION_CHAMPION_PATH = explorationPaths().champion;

/** Persisted sampler calibration from the last `--fresh` probe. */
export const EXPLORATION_CALIBRATION_PATH = explorationPaths().calibration;

/**
 * Evolve-option overrides applied in unit tests only — the runner never
 * sets these, so production runs keep NEAT-AI's defaults (issue #727).
 */
export type ExplorationEvolveOverrides = Partial<
  Pick<
    MnistEvolveOptions,
    "testCaps" | "timeoutMinutes" | "freshSeedExport" | "elitism" | "maxGenerations"
  >
>;

/**
 * One exploration loop — sampled-exploration cadence: early loops
 * use small `trainingSampleRate` and tiny `costOfGrowth` so NEAT can grow
 * structure quickly; the final loop trains on the full set.
 */
export interface ExplorationPhase {
  /** Human-readable phase label written to the phase log. */
  name: string;
  /** NEAT-AI `trainingSampleRate` in `(0, 1]`. */
  trainingSampleRate: number;
  /** Topology growth penalty — lower ⇒ more structural mutation. */
  costOfGrowth: number;
  /** Wall-clock budget for this phase, in minutes. */
  timeoutMinutes: number;
  /** NEAT population size for this phase. */
  populationSize: number;
  /**
   * Optional generation cap. Used for polish passes (few full-data
   * generations); structure phases omit this and run until the
   * `timeoutMinutes` budget is exhausted.
   */
  maxGenerations?: number;
}

/** Target wall-clock budget for one full exploration loop (minutes). */
export const DEFAULT_EXPLORATION_LOOP_MINUTES = 60;

/** How many times to repeat the structure-1…4 + polish cadence per invocation. */
export const DEFAULT_EXPLORATION_LOOP_REPEATS = 2;

/** Backstop wall-clock budget per polish pass (generations cap fires first). */
export const POLISH_TIMEOUT_MINUTES = 5;

/** Full-data polish generations per repeat — kept small so loops stay ~60 min. */
export const POLISH_MAX_GENERATIONS = 2;

/** Desired structure-phase generation time on full data (ms). ~1–2 s per gen. */
export const TARGET_MS_PER_GENERATION = 1500;

/** Wall-clock budget for the calibration probe (minutes). */
export const CALIBRATION_PROBE_MINUTES = 2;

/** Relative structure subsample ladder — sampler loops 1–4 (loop 5 is 100%). */
const STRUCTURE_SAMPLE_LADDER = [0.01, 0.05, 0.15, 0.15] as const;

/** Sampler loop count per repeat (loops 1–4 structure, loop 5 polish). */
export const SAMPLER_LOOP_COUNT = 5;

/**
 * Loops 3–4 randomise the training subsample between 10% and 50% so
 * successive structure passes see a different slice of the data.
 */
export function randomStructureSampleRate(random = Math.random): number {
  return Math.round((0.10 + random() * 0.40) * 100) / 100;
}

/** One pass of the sampler cadence (loops 1–4 subsample → loop 5 polish). */
const EXPLORATION_PHASE_TEMPLATE = [
  {
    name: "loop-1",
    ladderIndex: 0,
    costOfGrowth: 5e-10,
    populationSize: 50,
  },
  {
    name: "loop-2",
    ladderIndex: 1,
    costOfGrowth: 1e-9,
    populationSize: 40,
  },
  {
    name: "loop-3",
    ladderIndex: 2,
    costOfGrowth: 1e-8,
    populationSize: 40,
  },
  {
    name: "loop-4",
    ladderIndex: 3,
    costOfGrowth: 1e-8,
    populationSize: 40,
  },
  {
    name: "loop-5",
    ladderIndex: -1,
    costOfGrowth: 0,
    populationSize: 20,
  },
] as const;

/**
 * Map a full-data probe ({@link measuredMsPerGenAtFullData}) to the four
 * structure subsample rates. When full data is already fast enough the
 * template ladder (5% → 15%) is used unchanged; otherwise every rung is
 * scaled down proportionally toward {@link TARGET_MS_PER_GENERATION}.
 */
export function structureSampleRatesForCalibration(
  measuredMsPerGenAtFullData: number,
  targetMsPerGen = TARGET_MS_PER_GENERATION,
): { rates: readonly [number, number, number, number]; scale: number } {
  if (!Number.isFinite(measuredMsPerGenAtFullData) || measuredMsPerGenAtFullData <= 0) {
    throw new Error("measuredMsPerGenAtFullData must be a positive finite number.");
  }
  const scale = measuredMsPerGenAtFullData <= targetMsPerGen
    ? 1
    : Math.min(1, targetMsPerGen / measuredMsPerGenAtFullData);
  const rates = STRUCTURE_SAMPLE_LADDER.map((templateRate) =>
    scale >= 1 ? templateRate : Math.max(0.001, (scale * templateRate) / 0.15)
  ) as [number, number, number, number];
  return { rates, scale };
}

/** Probe full-data generation speed and derive structure subsample rates. */
export async function calibrateTrainingSampleRate(options: {
  dataDir: string;
  seedCreatureExport: CreatureExport;
  targetMsPerGeneration?: number;
  probeGenerations?: number;
  /** Unit-test-only evolve overrides (never set by the runner). */
  evolveOverrides?: ExplorationEvolveOverrides;
}): Promise<{
  sampleRates: readonly [number, number, number, number];
  scale: number;
  msPerGeneration: number;
  probeGenerations: number;
  probeWallClockMs: number;
  championExport: CreatureExport;
  seedNeurons: number;
  seedSynapses: number;
  finalNeurons: number;
  finalSynapses: number;
}> {
  const target = options.targetMsPerGeneration ?? TARGET_MS_PER_GENERATION;
  const seedCreature = Creature.fromJSON(options.seedCreatureExport);
  const probe = await evolveMnistClassifier({
    dataDir: options.dataDir,
    timeoutMinutes: CALIBRATION_PROBE_MINUTES,
    seedCreatureExport: options.seedCreatureExport,
    trainingSampleRate: 1,
    costOfGrowth: 0,
    populationSize: 20,
    ...options.evolveOverrides,
  });
  const msPerGeneration = probe.wallClockMs / Math.max(1, probe.generations);
  const { rates, scale } = structureSampleRatesForCalibration(msPerGeneration, target);
  return {
    sampleRates: rates,
    scale,
    msPerGeneration,
    probeGenerations: probe.generations,
    probeWallClockMs: probe.wallClockMs,
    championExport: probe.champion.exportJSON(),
    seedNeurons: seedCreature.neurons.length,
    seedSynapses: seedCreature.synapses.length,
    finalNeurons: probe.champion.neurons.length,
    finalSynapses: probe.champion.synapses.length,
  };
}

/** Load a prior calibration record written under {@link EXPLORATION_CALIBRATION_PATH}. */
export async function loadExplorationCalibration(
  explorationRoot = EXPLORATION_ROOT,
): Promise<
  {
    sampleRates: readonly [number, number, number, number];
    msPerGeneration: number;
    scale: number;
  } | undefined
> {
  try {
    const text = await Deno.readTextFile(explorationPaths(explorationRoot).calibration);
    const parsed = JSON.parse(text) as {
      sampleRates: readonly [number, number, number, number];
      msPerGeneration: number;
      scale: number;
    };
    if (!Array.isArray(parsed.sampleRates) || parsed.sampleRates.length !== 4) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Build a multi-repeat phase schedule that targets ~`loopMinutes` wall-clock.
 *
 * Structure phases use the remaining budget after polish slots are reserved;
 * each runs until its timeout. Polish passes cap at {@link POLISH_MAX_GENERATIONS}
 * full-data generations (timeout is only a backstop).
 */
export function buildExplorationLoopPhases(options?: {
  loopMinutes?: number;
  repeats?: number;
  structureSampleRates?: readonly [number, number, number, number];
}): ExplorationPhase[] {
  const loopMinutes = options?.loopMinutes ?? DEFAULT_EXPLORATION_LOOP_MINUTES;
  const repeats = options?.repeats ?? DEFAULT_EXPLORATION_LOOP_REPEATS;
  const structureRates = options?.structureSampleRates ?? STRUCTURE_SAMPLE_LADDER;
  if (loopMinutes < repeats * POLISH_TIMEOUT_MINUTES + repeats * 4) {
    throw new Error(
      `loopMinutes=${loopMinutes} is too small for ${repeats} repeat(s) ` +
        `(need at least ${repeats * POLISH_TIMEOUT_MINUTES + repeats * 4} minutes).`,
    );
  }

  const polishBudget = repeats * POLISH_TIMEOUT_MINUTES;
  const structureBudget = loopMinutes - polishBudget;
  const structurePhaseCount = repeats * 4;
  const structureTimeoutMinutes = Math.max(
    1,
    Math.floor(structureBudget / structurePhaseCount),
  );

  const phases: ExplorationPhase[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const template of EXPLORATION_PHASE_TEMPLATE) {
      const suffix = repeats > 1 ? `-r${repeat + 1}` : "";
      if (template.ladderIndex === -1) {
        phases.push({
          name: `${template.name}${suffix}`,
          trainingSampleRate: 1,
          costOfGrowth: template.costOfGrowth,
          populationSize: template.populationSize,
          timeoutMinutes: POLISH_TIMEOUT_MINUTES,
          maxGenerations: POLISH_MAX_GENERATIONS,
        });
      } else {
        const idx = template.ladderIndex;
        const templateRate = structureRates[idx];
        const trainingSampleRate = (idx === 2 || idx === 3)
          ? randomStructureSampleRate()
          : templateRate;
        phases.push({
          name: `${template.name}${suffix}`,
          trainingSampleRate,
          costOfGrowth: template.costOfGrowth,
          populationSize: template.populationSize,
          timeoutMinutes: structureTimeoutMinutes,
        });
      }
    }
  }
  return phases;
}

/**
 * Build a single structure phase at one training sample rate — useful for a
 * long low-rate run (e.g. 1% for an hour) while injecting archived winners
 * from other sample levels into the population.
 */
export function buildSingleSampleRatePhases(options: {
  trainingSampleRate: number;
  loopMinutes: number;
  populationSize?: number;
  costOfGrowth?: number;
}): ExplorationPhase[] {
  const { trainingSampleRate, loopMinutes } = options;
  if (!Number.isFinite(trainingSampleRate) || trainingSampleRate <= 0 || trainingSampleRate > 1) {
    throw new Error("trainingSampleRate must be in (0, 1].");
  }
  if (loopMinutes < 1) {
    throw new Error("loopMinutes must be at least 1.");
  }
  const pctLabel = trainingSampleRate >= 1
    ? "100pct"
    : `${(trainingSampleRate * 100).toFixed(trainingSampleRate < 0.01 ? 2 : 0)}pct`;
  return [{
    name: `structure-${pctLabel}`,
    trainingSampleRate,
    costOfGrowth: options.costOfGrowth ??
      (trainingSampleRate >= 1 ? 0 : 5e-10),
    populationSize: options.populationSize ?? 50,
    timeoutMinutes: loopMinutes,
    ...(trainingSampleRate >= 1 ? { maxGenerations: POLISH_MAX_GENERATIONS } : {}),
  }];
}

/**
 * Default schedule: two repeats of the five-phase cadence targeting ~60 minutes.
 * Training fitness uses subsamples during structure phases;
 * {@link evaluateOnHoldout} always scores the full validation + test sets.
 */
export const DEFAULT_EXPLORATION_PHASES: readonly ExplorationPhase[] = buildExplorationLoopPhases();

/** Squash candidates for a full `--squash-scan` pass (one scan each). */
export { DEFAULT_SQUASH_CANDIDATES } from "./squash_random.ts";

/** One line in the append-only phase log at `explorationPaths().phaseLog`. */
export interface ExplorationPhaseRecord {
  phase: string;
  trainingSampleRate: number;
  costOfGrowth: number;
  generations: number;
  evolveDirError: number;
  evolveDirScore: number;
  validationAccuracy: number;
  testAccuracy: number;
  neurons: number;
  synapses: number;
  wallClockMs: number;
  timestamp: string;
}

/** Options for {@link runExplorationCampaign}. */
export interface RunExplorationCampaignOptions {
  /** Binary `.bin` directory consumed by `evolveDir`. */
  dataDir: string;
  /** Train / validation / test split for honest hold-out scoring. */
  split: DigitSplit;
  /** Phase schedule (defaults to {@link buildExplorationLoopPhases}()). */
  phases?: readonly ExplorationPhase[];
  /** Target loop wall-clock when building the default schedule (minutes). */
  loopMinutes?: number;
  /** Repeat count for the default schedule (structure-1…4 + polish). */
  loopRepeats?: number;
  /**
   * When set, run one long phase at this training sample rate for
   * {@link loopMinutes} instead of the default five-phase cadence.
   */
  singleSampleRate?: number;
  /** Starting champion export (tests only). */
  seedCreatureExport?: CreatureExport;
  /**
   * When true, wipe every checked-in artefact (`docs/data/`, charts,
   * `campaign_record.json`) and restart the campaign clock.
   */
  fresh?: boolean;
  /** Run a weighted-random Intelligent Design squash pass after the sampler loop. */
  randomizedIntelligentDesign?: boolean;
  /** Run every squash in {@link DEFAULT_SQUASH_CANDIDATES} (overrides single ID pass). */
  squashScan?: boolean;
  /** Squash names to try when `squashScan` is true. */
  squashCandidates?: readonly string[];
  /** Total training records in the `.bin` file. */
  trainingRecords: number;
  /** Skip the full-data calibration probe (tests / explicit schedules). */
  skipCalibrate?: boolean;
  /**
   * Working root for gitignored campaign scratch state — champion, phase
   * log, calibration, population pool. Defaults to {@link EXPLORATION_ROOT};
   * tests pass a temp directory so no run pollutes the working tree.
   */
  explorationRoot?: string;
  /**
   * Base directory for the recorded artefacts (milestones, charts, run
   * summary). Defaults to `docs`; tests pass a temp directory.
   */
  baseDir?: string;
  /** Unit-test-only evolve overrides (never set by the runner). */
  evolveOverrides?: ExplorationEvolveOverrides;
}

/** Outcome of {@link runExplorationCampaign}. */
export interface ExplorationCampaignResult {
  champion: Creature;
  holdout: HoldoutScores;
  phaseRecords: ExplorationPhaseRecord[];
  squashImproved: boolean;
}

export type { HoldoutScores };

/** Load MNIST IDX files (cached) and build the canonical train/val/test split. */
export async function loadMnistDigitSplit(): Promise<{
  trainSamples: DigitSample[];
  split: DigitSplit;
}> {
  await Promise.all([
    fetchDataset({ url: TRAIN_IMAGES_URL, path: TRAIN_IMAGES_PATH, sha256: TRAIN_IMAGES_SHA256 }),
    fetchDataset({ url: TRAIN_LABELS_URL, path: TRAIN_LABELS_PATH, sha256: TRAIN_LABELS_SHA256 }),
    fetchDataset({ url: TEST_IMAGES_URL, path: TEST_IMAGES_PATH, sha256: TEST_IMAGES_SHA256 }),
    fetchDataset({ url: TEST_LABELS_URL, path: TEST_LABELS_PATH, sha256: TEST_LABELS_SHA256 }),
  ]);

  const [trainImageBytes, trainLabelBytes, testImageBytes, testLabelBytes] = await Promise.all([
    readGzippedFile(TRAIN_IMAGES_PATH),
    readGzippedFile(TRAIN_LABELS_PATH),
    readGzippedFile(TEST_IMAGES_PATH),
    readGzippedFile(TEST_LABELS_PATH),
  ]);
  const trainSamples = buildDigitSamples(
    parseIdxImages(trainImageBytes),
    parseIdxLabels(trainLabelBytes),
  );
  const testSamples = buildDigitSamples(
    parseIdxImages(testImageBytes),
    parseIdxLabels(testLabelBytes),
  );

  const TRAIN_COUNT = 50000;
  const VAL_COUNT = 10000;
  if (trainSamples.length < TRAIN_COUNT + VAL_COUNT) {
    throw new Error(
      `Need at least ${TRAIN_COUNT + VAL_COUNT} training samples, got ${trainSamples.length}`,
    );
  }

  const split: DigitSplit = {
    train: trainSamples.slice(0, TRAIN_COUNT),
    validation: trainSamples.slice(TRAIN_COUNT, TRAIN_COUNT + VAL_COUNT),
    test: testSamples,
  };
  return { trainSamples, split };
}

/** Score a creature on the **full** validation and test sets. */
export function evaluateOnHoldout(creature: Creature, split: DigitSplit): HoldoutScores {
  const validationAccuracy = classificationAccuracy(creature, split.validation);
  const matrix = confusionMatrix(creature, split.test);
  const testAccuracy = matrix.reduce((acc, row, i) => acc + row[i], 0) /
    (split.test.length || 1);
  return { validationAccuracy, testAccuracy };
}

/** Append one {@link ExplorationPhaseRecord} to the phase log. */
export async function appendPhaseRecord(
  record: ExplorationPhaseRecord,
  explorationRoot = EXPLORATION_ROOT,
): Promise<void> {
  ensureDirSync(explorationRoot);
  await Deno.writeTextFile(
    explorationPaths(explorationRoot).phaseLog,
    `${JSON.stringify(record)}\n`,
    { append: true, create: true },
  );
}

/** Persist the exploration champion (working copy only). */
export async function saveExplorationChampion(
  creature: Creature,
  explorationRoot = EXPLORATION_ROOT,
): Promise<void> {
  ensureDirSync(explorationRoot);
  await safeWriteJson(explorationPaths(explorationRoot).champion, creature.exportJSON());
}

/**
 * Run {@link scanForSquashImprovements} for one target squash and apply
 * any improvements found. Returns the (possibly updated) creature export.
 */
export async function runSquashImprovementPass(
  creatureExport: CreatureExport,
  dataDir: string,
  targetSquash: string,
  baselineScore: number,
  outputDir: string,
): Promise<{ creatureExport: CreatureExport; improved: boolean; message: string }> {
  ensureDirSync(outputDir);
  const scanResult = await scanForSquashImprovements({
    creature: creatureExport,
    targetSquash,
    outputDir,
    dataDir,
    bestScore: baselineScore,
    maxImprovements: 8,
    timeoutMs: 10 * 60 * 1000,
    options: { costName: MNIST_EVOLVE_COST_NAME },
  });

  if (scanResult.improvements.size === 0) {
    return {
      creatureExport,
      improved: false,
      message: `No squash improvements for ${targetSquash} (${scanResult.tested} neurons tested)`,
    };
  }

  const { creature: improvedCreature, message } = await combineImprovements(
    creatureExport,
    scanResult.improvements,
    dataDir,
    baselineScore,
  );
  return { creatureExport: improvedCreature, improved: true, message };
}

/** Wipe gitignored scratch state under {@link EXPLORATION_ROOT}. */
export async function wipeExplorationState(
  explorationRoot = EXPLORATION_ROOT,
): Promise<void> {
  try {
    await Deno.remove(explorationRoot, { recursive: true });
  } catch {
    // Directory may not exist yet.
  }
  await wipePopulationPool(explorationRoot);
}

/**
 * Run the full exploration campaign. Each phase is persisted under `docs/`
 * immediately so an overnight run can be interrupted and resumed.
 */
export async function runExplorationCampaign(
  options: RunExplorationCampaignOptions,
): Promise<ExplorationCampaignResult> {
  const explorationRoot = options.explorationRoot ?? EXPLORATION_ROOT;
  const paths = explorationPaths(explorationRoot);
  const baseDir = options.baseDir ?? "docs";

  if (options.fresh) {
    console.log("🧹 --fresh: wiping creature, milestones, charts, and campaign record.");
    await wipeRecordedEvolution(baseDir);
    await wipeExplorationState(explorationRoot);
  }

  ensureDirSync(explorationRoot);

  const multiState = await loadMultiRunState("mnist_classification", baseDir);
  let runIndex = multiState.nextRunIndex;
  let baseCumulativeGen = multiState.lastCumulativeGen;

  let championExport = options.seedCreatureExport ?? multiState.creatureExport;
  if (championExport === undefined) {
    if (options.fresh) {
      // Issue #518: drop the legacy --hidden-seed lookup. Always build
      // the fresh seed via the NEAT-AI factory so the campaign starts
      // from problem-intrinsic defaults rather than a hardcoded MNIST
      // architecture.
      const records = readMnistTrainingRecords(options.dataDir);
      championExport = buildMnistFactorySeed(records).exportJSON();
      console.log(
        "🌱 Fresh factory seed — Creature.forDataset(records, " +
          `{ cost: "${MNIST_EVOLVE_COST_NAME}" }) (SOFTMAX outputs, ` +
          "factory-sized hidden layer, dead-pixel pruning).",
      );
    } else {
      throw new Error(
        "No saved champion — pass --fresh to begin recording from the factory seed.",
      );
    }
  }

  let phases = options.phases;
  if (phases === undefined && options.singleSampleRate !== undefined) {
    phases = buildSingleSampleRatePhases({
      trainingSampleRate: options.singleSampleRate,
      loopMinutes: options.loopMinutes ?? DEFAULT_EXPLORATION_LOOP_MINUTES,
    });
    console.log(
      `\n📋 Single-sample schedule: ${(options.singleSampleRate * 100).toFixed(2)}% ` +
        `for ${options.loopMinutes ?? DEFAULT_EXPLORATION_LOOP_MINUTES} minute(s).`,
    );
  } else if (phases === undefined) {
    let structureSampleRates: readonly [number, number, number, number] = STRUCTURE_SAMPLE_LADDER;
    if (!options.skipCalibrate) {
      if (options.fresh) {
        console.log(
          `\n📏 Calibrating on full training data (target ${TARGET_MS_PER_GENERATION} ms/generation)…`,
        );
        console.log(
          `   Training binary ≈${
            (options.trainingRecords * (FEATURE_COUNT + CLASS_COUNT) * 4 / 1024 / 1024).toFixed(0)
          } MiB ` +
            `(${options.trainingRecords.toLocaleString()} records).`,
        );
        const calibration = await calibrateTrainingSampleRate({
          dataDir: options.dataDir,
          seedCreatureExport: championExport,
          evolveOverrides: options.evolveOverrides,
        });
        championExport = calibration.championExport;
        structureSampleRates = calibration.sampleRates;
        await safeWriteJson(paths.calibration, {
          targetMsPerGeneration: TARGET_MS_PER_GENERATION,
          msPerGeneration: calibration.msPerGeneration,
          scale: calibration.scale,
          sampleRates: calibration.sampleRates,
          probeGenerations: calibration.probeGenerations,
          probeWallClockMs: calibration.probeWallClockMs,
          seedNeurons: calibration.seedNeurons,
          seedSynapses: calibration.seedSynapses,
          finalNeurons: calibration.finalNeurons,
          finalSynapses: calibration.finalSynapses,
          timestamp: new Date().toISOString(),
        });
        console.log(
          `   Probe: ${calibration.probeGenerations} generation(s) in ` +
            `${format(calibration.probeWallClockMs, { ignoreZero: true })} ` +
            `(≈${(calibration.msPerGeneration / 1000).toFixed(2)} s/gen at 100% sample).`,
        );
        if (calibration.scale >= 1) {
          console.log("   Full data meets the target — using the 1%→15% sampler ladder.");
        } else {
          console.log(
            `   Scaled structure ladder by ${(calibration.scale * 100).toFixed(1)}% → ` +
              structureSampleRates.map((r) => `${(r * 100).toFixed(2)}%`).join(", "),
          );
        }
      } else {
        const saved = await loadExplorationCalibration(explorationRoot);
        if (saved) {
          structureSampleRates = saved.sampleRates;
          console.log(
            `📏 Reusing calibration: ≈${(saved.msPerGeneration / 1000).toFixed(2)} s/gen at 100% ` +
              `(structure ladder ${
                saved.sampleRates.map((r) => `${(r * 100).toFixed(2)}%`).join(", ")
              }).`,
          );
        }
      }
    }
    phases = buildExplorationLoopPhases({
      loopMinutes: options.loopMinutes,
      repeats: options.loopRepeats,
      structureSampleRates,
    });
  }

  if (options.singleSampleRate === undefined) {
    const repeatCount = phases.filter((p) => p.trainingSampleRate >= 1).length;
    const structureTimeout = phases.find((p) => p.trainingSampleRate < 1)?.timeoutMinutes;
    console.log(
      `\n📋 Sampler schedule: ${repeatCount} repeat(s) × ${SAMPLER_LOOP_COUNT} loops ` +
        `(${phases.length} total). Structure timeout ≈${structureTimeout}m each; loop 5 ` +
        `(100% data) capped at ${POLISH_MAX_GENERATIONS} generation(s).`,
    );
    console.log(
      `   Hidden pool: .synthetic-mnist/exploration/{.creatures,.sampler,experiments}/`,
    );
  }

  const phaseRecords: ExplorationPhaseRecord[] = [];
  let creature = Creature.fromJSON(championExport);
  const campaignFresh = options.fresh === true;

  for (const phase of phases) {
    const lineageExport = creature.exportJSON();
    const populationSeedExports = await loadPopulationPoolSeeds({
      phaseName: phase.name,
      currentTrainingSampleRate: phase.trainingSampleRate,
      lineageExport,
      explorationRoot,
    });

    if (populationSeedExports.length > 0) {
      const priorLoops = priorLoopPhaseNames(phase.name);
      console.log(
        `   📦 Seeding population with ${populationSeedExports.length} creature(s) ` +
          `from .creatures + sample-rate archives` +
          (priorLoops.length > 0 ? ` (prior loops: ${priorLoops.join(", ")})` : "") +
          `.`,
      );
    }

    const holdoutBefore = evaluateOnHoldout(creature, options.split);

    console.log(
      `\n🧬 Phase "${phase.name}": trainingSampleRate=${phase.trainingSampleRate}, ` +
        `costOfGrowth=${phase.costOfGrowth}, timeout=${phase.timeoutMinutes}m` +
        (phase.maxGenerations !== undefined ? `, maxGenerations=${phase.maxGenerations}` : "") +
        `, costName=${MNIST_EVOLVE_COST_NAME}`,
    );

    const evolveResult = await evolveMnistClassifier({
      dataDir: options.dataDir,
      timeoutMinutes: phase.timeoutMinutes,
      seedCreatureExport: lineageExport,
      trainingSampleRate: phase.trainingSampleRate,
      costOfGrowth: phase.costOfGrowth,
      populationSize: phase.populationSize,
      maxGenerations: phase.maxGenerations,
      generationLogPath: paths.generationLog,
      runIndex,
      populationSeedExports,
      elitism: elitismForArchivedChampions(populationSeedExports.length),
      verbose: true,
      ...options.evolveOverrides,
    });

    const phaseChampion = evolveResult.champion;
    const holdoutCandidate = evaluateOnHoldout(phaseChampion, options.split);

    const archiveUpdated = await maybeUpdateSampleRateChampion({
      trainingSampleRate: phase.trainingSampleRate,
      phaseName: phase.name,
      creatureExport: phaseChampion.exportJSON(),
      evolveScore: evolveResult.bestScore,
      testAccuracy: holdoutCandidate.testAccuracy,
      validationAccuracy: holdoutCandidate.validationAccuracy,
      explorationRoot,
    });
    if (archiveUpdated) {
      console.log(
        `   💾 Updated ${(phase.trainingSampleRate * 100).toFixed(2)}% sample-rate archive ` +
          `(score ${evolveResult.bestScore.toFixed(4)}).`,
      );
    }

    if (shouldAdvanceLineageChampion(holdoutBefore, holdoutCandidate)) {
      creature = phaseChampion;
    } else {
      console.log(
        `   ↩️  Hold-out test regressed ` +
          `${(holdoutBefore.testAccuracy * 100).toFixed(2)}% → ` +
          `${(holdoutCandidate.testAccuracy * 100).toFixed(2)}% — ` +
          `keeping prior lineage champion; ${(phase.trainingSampleRate * 100).toFixed(2)}% ` +
          `winner stays in the rate archive only.`,
      );
    }

    await saveExplorationChampion(creature, explorationRoot);

    const loopIndex = loopIndexFromPhaseName(phase.name);
    if (loopIndex !== undefined) {
      await saveSamplerLoopChampion(loopIndex, phaseChampion.exportJSON(), explorationRoot);
    }
    if (phase.name.startsWith("loop-")) {
      await savePhaseChampion(phase.name, phaseChampion.exportJSON(), explorationRoot);
    }

    const holdout = evaluateOnHoldout(creature, options.split);
    const campaign = await persistMnistRecordedPhase({
      evolveResult,
      holdout,
      split: options.split,
      phaseName: phase.name,
      runIndex,
      baseCumulativeGen,
      campaignFresh: campaignFresh && runIndex === multiState.nextRunIndex,
      trainingRecords: options.trainingRecords,
      baseDir,
    });

    baseCumulativeGen += evolveResult.generations;
    runIndex += 1;

    const record: ExplorationPhaseRecord = {
      phase: phase.name,
      trainingSampleRate: phase.trainingSampleRate,
      costOfGrowth: phase.costOfGrowth,
      generations: evolveResult.generations,
      evolveDirError: evolveResult.bestError,
      evolveDirScore: evolveResult.bestScore,
      validationAccuracy: holdout.validationAccuracy,
      testAccuracy: holdout.testAccuracy,
      neurons: creature.neurons.length,
      synapses: creature.synapses.length,
      wallClockMs: evolveResult.wallClockMs,
      timestamp: new Date().toISOString(),
    };
    phaseRecords.push(record);
    await appendPhaseRecord(record, explorationRoot);

    console.log(
      `   ✅ ${phase.name}: ${evolveResult.generations} generations in ` +
        `${format(evolveResult.wallClockMs, { ignoreZero: true })} — ` +
        `val=${(holdout.validationAccuracy * 100).toFixed(2)}% ` +
        `test=${(holdout.testAccuracy * 100).toFixed(2)}% ` +
        `(${creature.neurons.length}n / ${creature.synapses.length}s) · ` +
        `campaign total ${format(campaign.totalWallClockMs, { ignoreZero: true })}`,
    );
  }

  let squashImproved = false;
  if (options.squashScan) {
    const candidates = options.squashCandidates ?? DEFAULT_SQUASH_CANDIDATES;
    const idOutputDir = join(paths.experiments, "intelligent-design");
    let exportJson = creature.exportJSON();
    const baselineScore = Number.parseFloat(getTag(exportJson, "score") ?? "0") ||
      (phaseRecords.at(-1)?.evolveDirScore ?? 0);

    console.log("\n🧠 Intelligent design — scanning squash functions on full training data…");
    for (const squash of candidates) {
      console.log(`   Testing ${squash}…`);
      const pass = await runSquashImprovementPass(
        exportJson,
        options.dataDir,
        squash,
        baselineScore,
        join(idOutputDir, squash),
      );
      console.log(`   ${pass.message}`);
      if (pass.improved) {
        squashImproved = true;
        exportJson = pass.creatureExport;
        creature = Creature.fromJSON(exportJson);
        await saveExplorationChampion(creature, explorationRoot);
        const holdout = evaluateOnHoldout(creature, options.split);
        console.log(
          `   ♻️  After ${squash}: test=${(holdout.testAccuracy * 100).toFixed(2)}% ` +
            `val=${(holdout.validationAccuracy * 100).toFixed(2)}%`,
        );
      }
    }
  } else if (options.randomizedIntelligentDesign !== false) {
    const squash = randomWeightedSquash();
    console.log(
      `\n🧠 Intelligent design (randomised pass) — weighted-random squash: ${squash}…`,
    );
    const exportJson = creature.exportJSON();
    const baselineScore = Number.parseFloat(getTag(exportJson, "score") ?? "0") ||
      (phaseRecords.at(-1)?.evolveDirScore ?? 0);
    const pass = await runSquashImprovementPass(
      exportJson,
      options.dataDir,
      squash,
      baselineScore,
      intelligentDesignOutputDir(squash, explorationRoot),
    );
    console.log(`   ${pass.message}`);
    if (pass.improved) {
      squashImproved = true;
      creature = Creature.fromJSON(pass.creatureExport);
      await saveExplorationChampion(creature, explorationRoot);
      const holdout = evaluateOnHoldout(creature, options.split);
      console.log(
        `   ♻️  After ${squash}: test=${(holdout.testAccuracy * 100).toFixed(2)}% ` +
          `val=${(holdout.validationAccuracy * 100).toFixed(2)}%`,
      );
    }
  }

  const finalHoldout = evaluateOnHoldout(creature, options.split);
  await safeWriteJson(paths.summary, {
    validationAccuracy: finalHoldout.validationAccuracy,
    testAccuracy: finalHoldout.testAccuracy,
    phasesCompleted: phaseRecords.length,
    neurons: creature.neurons.length,
    synapses: creature.synapses.length,
    squashImproved,
    costName: MNIST_EVOLVE_COST_NAME,
    timestamp: new Date().toISOString(),
  });

  return {
    champion: creature,
    holdout: finalHoldout,
    phaseRecords,
    squashImproved,
  };
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["fresh", "squash-scan", "skip-calibrate", "skip-id"],
    string: ["squash", "loop-minutes", "repeats", "sample-rate"],
  });

  const loopMinutes = args["loop-minutes"] !== undefined
    ? Number.parseInt(args["loop-minutes"], 10)
    : DEFAULT_EXPLORATION_LOOP_MINUTES;
  const loopRepeats = args.repeats !== undefined
    ? Number.parseInt(args.repeats, 10)
    : DEFAULT_EXPLORATION_LOOP_REPEATS;
  const singleSampleRate = args["sample-rate"] !== undefined
    ? Number.parseFloat(args["sample-rate"])
    : undefined;
  if (!Number.isFinite(loopMinutes) || loopMinutes < 1) {
    throw new Error("--loop-minutes must be a positive integer.");
  }
  if (!Number.isFinite(loopRepeats) || loopRepeats < 1) {
    throw new Error("--repeats must be a positive integer.");
  }
  if (
    singleSampleRate !== undefined &&
    (!Number.isFinite(singleSampleRate) || singleSampleRate <= 0 || singleSampleRate > 1)
  ) {
    throw new Error("--sample-rate must be a number in (0, 1].");
  }

  console.log("🔬 MNIST recorded-evolution campaign");
  if (singleSampleRate !== undefined) {
    console.log(
      `   Single-sample run: ${(singleSampleRate * 100).toFixed(2)}% training data for ` +
        `${loopMinutes} minute(s).`,
    );
  } else {
    console.log(
      `   Loop target: ~${loopMinutes} min, ${loopRepeats} repeat(s) of structure-1…4 + polish.`,
    );
  }
  console.log("   Persists to docs/data/mnist_classification/ after every phase.");
  console.log("   Scratch log: .synthetic-mnist/exploration/ (gitignored)");
  console.log("");

  const { trainSamples, split } = await loadMnistDigitSplit();
  console.log(
    `📊 Split: train=${split.train.length} val=${split.validation.length} ` +
      `test=${split.test.length} (${FEATURE_COUNT} features, ${CLASS_COUNT} classes)`,
  );

  ensureDirSync(BIN_TRAIN_DIR);
  const binPath = join(BIN_TRAIN_DIR, "mnist_train.bin");
  writeMnistTrainingBin(trainSamples, binPath);
  console.log(`📦 Training binary: ${binPath}`);

  const squashCandidates = args.squash
    ? args.squash.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const result = await runExplorationCampaign({
    dataDir: BIN_TRAIN_DIR,
    split,
    trainingRecords: trainSamples.length,
    fresh: args.fresh === true,
    squashScan: args["squash-scan"] === true,
    squashCandidates,
    randomizedIntelligentDesign: args["skip-id"] !== true,
    loopMinutes,
    loopRepeats,
    singleSampleRate,
    skipCalibrate: args["skip-calibrate"] === true || singleSampleRate !== undefined,
  });

  console.log("\n== Campaign complete ==");
  console.log(
    `   Test accuracy: ${(result.holdout.testAccuracy * 100).toFixed(2)}%  ` +
      `(validation ${(result.holdout.validationAccuracy * 100).toFixed(2)}%)`,
  );
  console.log(
    `   Topology: ${result.champion.neurons.length} neurons, ` +
      `${result.champion.synapses.length} synapses`,
  );
  console.log(`   Phases this invocation: ${result.phaseRecords.length}`);
  console.log(
    "   Charts: docs/screenshots/mnist_classification/{milestones,complexity,timeline}.svg",
  );
  if (result.squashImproved) console.log("   Intelligent design: improvements applied");
}
