/**
 * Persist MNIST recorded-evolution artefacts under `docs/`.
 *
 * Shared by the exploration campaign and the standard multi-run runner.
 * Every phase/run appends a milestone (with wall-clock + hold-out score),
 * refreshes the three multi-run charts (error, complexity, timeline),
 * and updates `run_summary.json` + `campaign_record.json`.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { safeWriteJson } from "@stsoftware/neat-ai";

import {
  appendCampaignPhase,
  type CampaignRecord,
  loadCampaignRecord,
  startCampaignRecord,
  wipeCampaignRecord,
} from "../common/campaign_record.ts";
import { renderMultiRunComplexityChartSVG } from "../common/multi_run_complexity_chart.ts";
import { renderMultiRunErrorChartSVG } from "../common/multi_run_error_chart.ts";
import { renderMultiRunTimelineChartSVG } from "../common/multi_run_timeline_chart.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  type NewMultiRunSample,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import {
  buildGridCells,
  EXAMPLE_SLUG,
  type MnistEvolveResult,
  RUN_SUMMARY_DOCS_PATH,
  SCREENSHOT_PATH,
} from "./mnist_classification.ts";
import { type DigitSplit } from "./data.ts";
import { renderDigitGridSVG } from "./svg.ts";

/** Result of scoring a creature on held-out data (full sets — not subsampled). */
export interface HoldoutScores {
  validationAccuracy: number;
  testAccuracy: number;
}

/** Timeline chart path — hold-out score vs cumulative wall-clock. */
export const MULTI_RUN_TIMELINE_SVG_PATH = "docs/screenshots/mnist_classification/timeline.svg";

/** Build a multi-run milestone from one exploration phase. */
export function phaseResultToMultiRunSample(
  evolveResult: MnistEvolveResult,
  holdout: HoldoutScores,
  _phaseName: string,
): NewMultiRunSample {
  const testError = 1 - holdout.testAccuracy;
  return {
    runGen: evolveResult.generations,
    error: testError,
    bestScore: holdout.testAccuracy,
    holdoutScore: holdout.testAccuracy,
    neurons: evolveResult.champion.neurons.length,
    synapses: evolveResult.champion.synapses.length,
    generationWallClockMs: evolveResult.wallClockMs,
    // Tag the phase name via meanEpisodeSteps reuse? No — keep schema clean.
    // Phase name lives in exploration phases.jsonl only.
  };
}

/** Wipe every checked-in artefact for a `--fresh` campaign restart. */
export async function wipeRecordedEvolution(baseDir = "docs"): Promise<void> {
  await wipeMultiRunState(EXAMPLE_SLUG, baseDir);
  await wipeCampaignRecord(EXAMPLE_SLUG, baseDir);
  for (
    const path of [
      RUN_SUMMARY_DOCS_PATH,
      SCREENSHOT_PATH,
      join(baseDir, "data", EXAMPLE_SLUG, "run_summary.json"),
    ]
  ) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
}

/** Render all multi-run charts from the merged milestone history. */
export async function renderMnistRecordedCharts(baseDir = "docs"): Promise<void> {
  const state = await loadMultiRunState(EXAMPLE_SLUG, baseDir);
  if (state.milestones.length === 0) return;

  const screenshotsDir = join(baseDir, "screenshots", EXAMPLE_SLUG);
  ensureDirSync(screenshotsDir);

  const errorSvg = renderMultiRunErrorChartSVG(state.milestones, {
    title: "MNIST — training error vs cumulative generations",
    caption: true,
  });
  await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), errorSvg);

  const complexitySvg = renderMultiRunComplexityChartSVG(state.milestones, {
    title: "MNIST — creature complexity vs cumulative generations",
    caption: true,
  });
  await Deno.writeTextFile(join(screenshotsDir, "complexity.svg"), complexitySvg);

  const timelineSvg = renderMultiRunTimelineChartSVG(state.milestones, {
    title: "MNIST — test accuracy vs wall-clock time",
    caption: true,
  });
  await Deno.writeTextFile(join(screenshotsDir, "timeline.svg"), timelineSvg);
}

/** Write champion, summary, grid SVG, and refresh charts after one phase. */
export async function persistMnistRecordedPhase(options: {
  evolveResult: MnistEvolveResult;
  holdout: HoldoutScores;
  split: DigitSplit;
  phaseName: string;
  runIndex: number;
  baseCumulativeGen: number;
  campaignFresh: boolean;
  trainingRecords: number;
  baseDir?: string;
}): Promise<CampaignRecord> {
  const base = options.baseDir ?? "docs";
  const sample = phaseResultToMultiRunSample(
    options.evolveResult,
    options.holdout,
    options.phaseName,
  );

  await appendMultiRunRun(EXAMPLE_SLUG, {
    creatureExport: options.evolveResult.champion.exportJSON(),
    newSamples: [sample],
    runIndex: options.runIndex,
    baseCumulativeGen: options.baseCumulativeGen,
  }, base);

  const campaign = options.campaignFresh && options.runIndex === 1
    ? await startCampaignRecord(EXAMPLE_SLUG, base)
    : await loadCampaignRecordForAppend(EXAMPLE_SLUG, base);

  await appendCampaignPhase(EXAMPLE_SLUG, {
    wallClockMs: options.evolveResult.wallClockMs,
    testAccuracy: options.holdout.testAccuracy,
    validationAccuracy: options.holdout.validationAccuracy,
  }, base);

  const updated = await loadCampaignRecord(EXAMPLE_SLUG, base);
  const campaignRecord = updated ?? campaign;

  await renderMnistRecordedCharts(base);

  const creature = options.evolveResult.champion;
  const cells = buildGridCells(creature, options.split.test, 3);
  const gridSvg = renderDigitGridSVG({
    cells,
    accuracy: options.holdout.testAccuracy,
    validationAccuracy: options.holdout.validationAccuracy,
  });
  ensureDirSync(join(base, "screenshots"));
  await Deno.writeTextFile(SCREENSHOT_PATH, gridSvg);

  await safeWriteJson(RUN_SUMMARY_DOCS_PATH, {
    trainingRecords: options.trainingRecords,
    evolveWallClockMs: options.evolveResult.wallClockMs,
    targetError: 0.0001,
    timeoutMinutes: 0,
    seedNeurons: options.evolveResult.seedNeurons,
    seedSynapses: options.evolveResult.seedSynapses,
    finalNeurons: creature.neurons.length,
    finalSynapses: creature.synapses.length,
    validationAccuracy: options.holdout.validationAccuracy,
    testAccuracy: options.holdout.testAccuracy,
    stopCondition: "recordedEvolution",
    evolveDirError: options.evolveResult.bestError,
    evolveDirScore: options.evolveResult.bestScore,
    evolveDirGenerations: options.evolveResult.generations,
    runIndex: options.runIndex,
    resumed: !options.campaignFresh && options.runIndex > 1,
    campaignStartedAt: campaignRecord.campaignStartedAt,
    totalCampaignWallClockMs: campaignRecord.totalWallClockMs,
    campaignPhaseCount: campaignRecord.phaseCount,
    lastPhaseName: options.phaseName,
  });

  return updated ?? campaign;
}

async function loadCampaignRecordForAppend(
  exampleSlug: string,
  baseDir?: string,
): Promise<CampaignRecord> {
  const existing = await loadCampaignRecord(exampleSlug, baseDir);
  if (existing) return existing;
  return startCampaignRecord(exampleSlug, baseDir);
}
