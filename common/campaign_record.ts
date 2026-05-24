/**
 * Campaign metadata for long-form recorded evolution runs.
 *
 * Tracks when a `--fresh` campaign started, cumulative wall-clock spent,
 * and the best hold-out score seen so far. Written next to the merged
 * milestone history under `docs/data/<slug>/campaign_record.json` and
 * wiped together with {@link wipeMultiRunState} via {@link wipeCampaignRecord}.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import { safeWriteJson } from "@stsoftware/neat-ai";

/** Persisted campaign metadata for an example slug. */
export interface CampaignRecord {
  /** Example identifier (e.g. `mnist_classification`). */
  exampleSlug: string;
  /** ISO-8601 timestamp when the current campaign began (`--fresh`). */
  campaignStartedAt: string;
  /** ISO-8601 timestamp of the most recent phase/run append. */
  lastUpdatedAt: string;
  /** Sum of `generationWallClockMs` across every recorded milestone. */
  totalWallClockMs: number;
  /** Number of multi-run invocations / exploration phases recorded. */
  phaseCount: number;
  /** Best test / hold-out score in `[0, 1]` seen this campaign. */
  bestHoldoutScore: number;
  /** Matching validation score at the time `bestHoldoutScore` was set. */
  bestValidationScore: number;
}

function resolveBaseDir(baseDir?: string): string {
  if (baseDir !== undefined) return baseDir;
  const fromEnv = Deno.env.get("NEAT_MULTI_RUN_BASE_DIR");
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return "docs";
}

/** Path to the campaign record JSON for an example. */
export function campaignRecordPath(exampleSlug: string, baseDir?: string): string {
  return join(resolveBaseDir(baseDir), "data", exampleSlug, "campaign_record.json");
}

/** Load an existing record, or `undefined` when none exists. */
export async function loadCampaignRecord(
  exampleSlug: string,
  baseDir?: string,
): Promise<CampaignRecord | undefined> {
  try {
    const text = await Deno.readTextFile(campaignRecordPath(exampleSlug, baseDir));
    return JSON.parse(text) as CampaignRecord;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/**
 * Begin a new campaign clock after `--fresh`. Overwrites any prior record.
 */
export async function startCampaignRecord(
  exampleSlug: string,
  baseDir?: string,
): Promise<CampaignRecord> {
  const now = new Date().toISOString();
  const record: CampaignRecord = {
    exampleSlug,
    campaignStartedAt: now,
    lastUpdatedAt: now,
    totalWallClockMs: 0,
    phaseCount: 0,
    bestHoldoutScore: 0,
    bestValidationScore: 0,
  };
  await writeCampaignRecord(record, baseDir);
  return record;
}

/** Persist a campaign record. */
export async function writeCampaignRecord(
  record: CampaignRecord,
  baseDir?: string,
): Promise<void> {
  const path = campaignRecordPath(record.exampleSlug, baseDir);
  ensureDirSync(join(path, ".."));
  await safeWriteJson(path, record);
}

/**
 * Merge one completed phase into the campaign record. Creates a fresh
 * record when none exists (resume without `--fresh`).
 */
export async function appendCampaignPhase(
  exampleSlug: string,
  phase: {
    wallClockMs: number;
    testAccuracy: number;
    validationAccuracy: number;
  },
  baseDir?: string,
): Promise<CampaignRecord> {
  const now = new Date().toISOString();
  const existing = await loadCampaignRecord(exampleSlug, baseDir);
  const record: CampaignRecord = existing ?? {
    exampleSlug,
    campaignStartedAt: now,
    lastUpdatedAt: now,
    totalWallClockMs: 0,
    phaseCount: 0,
    bestHoldoutScore: 0,
    bestValidationScore: 0,
  };

  record.lastUpdatedAt = now;
  record.totalWallClockMs += Math.max(0, phase.wallClockMs);
  record.phaseCount += 1;
  if (phase.testAccuracy >= record.bestHoldoutScore) {
    record.bestHoldoutScore = phase.testAccuracy;
    record.bestValidationScore = phase.validationAccuracy;
  }

  await writeCampaignRecord(record, baseDir);
  return record;
}

/** Remove the campaign record (part of a `--fresh` wipe). */
export async function wipeCampaignRecord(
  exampleSlug: string,
  baseDir?: string,
): Promise<void> {
  try {
    await Deno.remove(campaignRecordPath(exampleSlug, baseDir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}
