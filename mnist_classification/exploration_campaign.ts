/**
 * MNIST recorded-evolution campaign — GRQ-style sampled exploration, full-data
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
  buildMnistHiddenReluSeed,
  classificationAccuracy,
  confusionMatrix,
  evolveMnistClassifier,
  MNIST_EVOLVE_COST_NAME,
  MNIST_ROOT,
  resolveMnistHiddenLayerSizes,
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

/** Hidden working directory for exploration state (never checked in). */
export const EXPLORATION_ROOT = join(MNIST_ROOT, "exploration");

/** Persisted champion between exploration phases. */
export const EXPLORATION_CHAMPION_PATH = join(EXPLORATION_ROOT, "champion.json");

/** Append-only JSONL log — one record per completed phase. */
export const EXPLORATION_PHASE_LOG_PATH = join(EXPLORATION_ROOT, "phases.jsonl");

/** Latest campaign summary (test accuracy, topology, phase count). */
export const EXPLORATION_SUMMARY_PATH = join(EXPLORATION_ROOT, "campaign_summary.json");

/** Persisted sampler calibration from the last `--fresh` probe. */
export const EXPLORATION_CALIBRATION_PATH = join(EXPLORATION_ROOT, "calibration.json");

/**
 * One exploration loop — mirrors the GRQ `sampler.sh` cadence: early loops
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

/** Generations used when probing full-data speed during calibration. */
export const CALIBRATION_PROBE_GENERATIONS = 2;

/** Wall-clock budget for the calibration probe (minutes). */
export const CALIBRATION_PROBE_MINUTES = 2;

/** Relative structure subsample ladder (structure-4 uses the calibrated cap). */
const STRUCTURE_SAMPLE_LADDER = [0.05, 0.10, 0.15, 0.15] as const;

/** One pass of the GRQ-style cadence (structure subsampling → full-data polish). */
const EXPLORATION_PHASE_TEMPLATE = [
  {
    name: "structure-1",
    ladderIndex: 0,
    costOfGrowth: 5e-10,
    populationSize: 50,
  },
  {
    name: "structure-2",
    ladderIndex: 1,
    costOfGrowth: 1e-9,
    populationSize: 40,
  },
  {
    name: "structure-3",
    ladderIndex: 2,
    costOfGrowth: 1e-8,
    populationSize: 40,
  },
  {
    name: "structure-4",
    ladderIndex: 3,
    costOfGrowth: 1e-7,
    populationSize: 40,
  },
  {
    name: "polish",
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
export async function loadExplorationCalibration(): Promise<
  {
    sampleRates: readonly [number, number, number, number];
    msPerGeneration: number;
    scale: number;
  } | undefined
> {
  try {
    const text = await Deno.readTextFile(EXPLORATION_CALIBRATION_PATH);
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
      if (template.name === "polish") {
        phases.push({
          name: `polish${suffix}`,
          trainingSampleRate: 1,
          costOfGrowth: template.costOfGrowth,
          populationSize: template.populationSize,
          timeoutMinutes: POLISH_TIMEOUT_MINUTES,
          maxGenerations: POLISH_MAX_GENERATIONS,
        });
      } else {
        const idx = template.ladderIndex;
        phases.push({
          name: `${template.name}${suffix}`,
          trainingSampleRate: structureRates[idx],
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
 * Default schedule: two repeats of the five-phase cadence targeting ~60 minutes.
 * Training fitness uses subsamples during structure phases;
 * {@link evaluateOnHoldout} always scores the full validation + test sets.
 */
export const DEFAULT_EXPLORATION_PHASES: readonly ExplorationPhase[] = buildExplorationLoopPhases();

/** Squash candidates for the intelligent-design pass (one scan each). */
export const DEFAULT_SQUASH_CANDIDATES = ["GELU", "Swish", "LeakyReLU", "Mish"] as const;

/** One line in {@link EXPLORATION_PHASE_LOG_PATH}. */
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
  /** Starting champion export (tests only). */
  seedCreatureExport?: CreatureExport;
  /**
   * When true, wipe every checked-in artefact (`docs/data/`, charts,
   * `campaign_record.json`) and restart the campaign clock.
   */
  fresh?: boolean;
  /** With `--fresh`, seed via layered ReLU MLP instead of resuming. */
  hiddenSeed?: boolean;
  /** Run intelligent-design squash scans after the polish phase. */
  squashScan?: boolean;
  /** Squash names to try when `squashScan` is true. */
  squashCandidates?: readonly string[];
  /** Total training records in the `.bin` file. */
  trainingRecords: number;
  /** Skip the full-data calibration probe (tests / explicit schedules). */
  skipCalibrate?: boolean;
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
export async function appendPhaseRecord(record: ExplorationPhaseRecord): Promise<void> {
  ensureDirSync(EXPLORATION_ROOT);
  await Deno.writeTextFile(
    EXPLORATION_PHASE_LOG_PATH,
    `${JSON.stringify(record)}\n`,
    { append: true, create: true },
  );
}

/** Load the exploration champion, or `undefined` when none exists. */
export async function loadExplorationChampion(): Promise<CreatureExport | undefined> {
  try {
    const text = await Deno.readTextFile(EXPLORATION_CHAMPION_PATH);
    return JSON.parse(text) as CreatureExport;
  } catch {
    return undefined;
  }
}

/** Persist the exploration champion (working copy only). */
export async function saveExplorationChampion(creature: Creature): Promise<void> {
  ensureDirSync(EXPLORATION_ROOT);
  await safeWriteJson(EXPLORATION_CHAMPION_PATH, creature.exportJSON());
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
export async function wipeExplorationState(): Promise<void> {
  try {
    await Deno.remove(EXPLORATION_ROOT, { recursive: true });
  } catch {
    // Directory may not exist yet.
  }
}

/**
 * Run the full exploration campaign. Each phase is persisted under `docs/`
 * immediately so an overnight run can be interrupted and resumed.
 */
export async function runExplorationCampaign(
  options: RunExplorationCampaignOptions,
): Promise<ExplorationCampaignResult> {
  if (options.fresh) {
    console.log("🧹 --fresh: wiping creature, milestones, charts, and campaign record.");
    await wipeRecordedEvolution();
    await wipeExplorationState();
  }

  ensureDirSync(EXPLORATION_ROOT);

  const multiState = await loadMultiRunState("mnist_classification");
  let runIndex = multiState.nextRunIndex;
  let baseCumulativeGen = multiState.lastCumulativeGen;

  let championExport = options.seedCreatureExport ?? multiState.creatureExport;
  if (championExport === undefined) {
    if (options.fresh && options.hiddenSeed) {
      championExport = buildMnistHiddenReluSeed(resolveMnistHiddenLayerSizes()).exportJSON();
      console.log("🌱 Fresh hidden-seed campaign — layered ReLU MLP seed.");
    } else if (options.fresh) {
      championExport = new Creature(FEATURE_COUNT, CLASS_COUNT).exportJSON();
      console.log(
        `🌱 Fresh minimal seed — new Creature(${FEATURE_COUNT}, ${CLASS_COUNT}) ` +
          `(inputs + outputs only, uniform-random weights).`,
      );
    } else {
      throw new Error(
        "No saved champion — pass --fresh (optionally with --hidden-seed) to begin recording.",
      );
    }
  }

  let phases = options.phases;
  if (phases === undefined) {
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
        });
        championExport = calibration.championExport;
        structureSampleRates = calibration.sampleRates;
        await safeWriteJson(EXPLORATION_CALIBRATION_PATH, {
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
          console.log("   Full data meets the target — using the 5%→15% structure ladder.");
        } else {
          console.log(
            `   Scaled structure ladder by ${(calibration.scale * 100).toFixed(1)}% → ` +
              structureSampleRates.map((r) => `${(r * 100).toFixed(2)}%`).join(", "),
          );
        }
      } else {
        const saved = await loadExplorationCalibration();
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

  const repeatCount = phases.filter((p) => p.name.startsWith("polish")).length;
  const structureTimeout = phases.find((p) => p.name.startsWith("structure"))?.timeoutMinutes;
  console.log(
    `\n📋 Loop schedule: ${repeatCount} repeat(s) × 5 phases (${phases.length} total). ` +
      `Structure timeout ≈${structureTimeout}m each; polish capped at ` +
      `${POLISH_MAX_GENERATIONS} generation(s).`,
  );

  const phaseRecords: ExplorationPhaseRecord[] = [];
  let creature = Creature.fromJSON(championExport);
  const campaignFresh = options.fresh === true;

  for (const phase of phases) {
    console.log(
      `\n🧬 Phase "${phase.name}": trainingSampleRate=${phase.trainingSampleRate}, ` +
        `costOfGrowth=${phase.costOfGrowth}, timeout=${phase.timeoutMinutes}m` +
        (phase.maxGenerations !== undefined ? `, maxGenerations=${phase.maxGenerations}` : "") +
        `, costName=${MNIST_EVOLVE_COST_NAME}`,
    );

    const evolveResult = await evolveMnistClassifier({
      dataDir: options.dataDir,
      timeoutMinutes: phase.timeoutMinutes,
      seedCreatureExport: creature.exportJSON(),
      trainingSampleRate: phase.trainingSampleRate,
      costOfGrowth: phase.costOfGrowth,
      populationSize: phase.populationSize,
      maxGenerations: phase.maxGenerations,
      generationLogPath: join(EXPLORATION_ROOT, "generations.tsv"),
      runIndex,
    });

    creature = evolveResult.champion;
    await saveExplorationChampion(creature);

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
    await appendPhaseRecord(record);

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
    const idOutputDir = join(EXPLORATION_ROOT, "intelligent-design");
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
        await saveExplorationChampion(creature);
        const holdout = evaluateOnHoldout(creature, options.split);
        console.log(
          `   ♻️  After ${squash}: test=${(holdout.testAccuracy * 100).toFixed(2)}% ` +
            `val=${(holdout.validationAccuracy * 100).toFixed(2)}%`,
        );
      }
    }
  }

  const finalHoldout = evaluateOnHoldout(creature, options.split);
  await safeWriteJson(EXPLORATION_SUMMARY_PATH, {
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
    boolean: ["fresh", "squash-scan", "hidden-seed", "skip-calibrate"],
    string: ["squash", "loop-minutes", "repeats"],
  });

  const loopMinutes = args["loop-minutes"] !== undefined
    ? Number.parseInt(args["loop-minutes"], 10)
    : DEFAULT_EXPLORATION_LOOP_MINUTES;
  const loopRepeats = args.repeats !== undefined
    ? Number.parseInt(args.repeats, 10)
    : DEFAULT_EXPLORATION_LOOP_REPEATS;
  if (!Number.isFinite(loopMinutes) || loopMinutes < 1) {
    throw new Error("--loop-minutes must be a positive integer.");
  }
  if (!Number.isFinite(loopRepeats) || loopRepeats < 1) {
    throw new Error("--repeats must be a positive integer.");
  }

  console.log("🔬 MNIST recorded-evolution campaign");
  console.log(
    `   Loop target: ~${loopMinutes} min, ${loopRepeats} repeat(s) of structure-1…4 + polish.`,
  );
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
    hiddenSeed: args["hidden-seed"] === true,
    squashScan: args["squash-scan"] === true,
    squashCandidates,
    loopMinutes,
    loopRepeats,
    skipCalibrate: args["skip-calibrate"] === true,
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
