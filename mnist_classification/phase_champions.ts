/**
 * Per-phase and per-sample-rate champion archive for the MNIST exploration
 * campaign.
 *
 * Mirrors GRQ `sampler.sh` / `.sampler/loop-${i}.json`: each training
 * subsample level keeps its fittest creature so later phases can re-seed the
 * population with winners from other sample rates. The lineage champion only
 * advances when full hold-out test accuracy does not regress.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import type { CreatureExport } from "@stsoftware/neat-ai";

import { MNIST_ROOT } from "./mnist_classification.ts";

/** On-disk directory for per-phase and per-rate champion JSON exports. */
export const PHASE_CHAMPIONS_DIR = join(MNIST_ROOT, "exploration", "phase-champions");

/** Persisted champion for one training sample rate. */
export interface SampleRateChampionRecord {
  trainingSampleRate: number;
  /** Best NEAT score observed while training at this sample rate. */
  evolveScore: number;
  testAccuracy: number;
  validationAccuracy: number;
  export: CreatureExport;
  phaseName?: string;
  timestamp: string;
}

/** Repeat suffix parsed from a phase name (`""` or `"-r2"`). */
export function repeatSuffixFromPhaseName(phaseName: string): string {
  const match = phaseName.match(/-r(\d+)$/);
  return match ? `-r${match[1]}` : "";
}

/** Structure phase names for one repeat (`structure-1` … `structure-4`, with optional `-rN`). */
export function structurePhaseNamesForRepeat(repeatSuffix: string): readonly string[] {
  return [1, 2, 3, 4].map((n) => `structure-${n}${repeatSuffix}`);
}

/**
 * Structure phases whose archived champions should seed the population before
 * `phaseName` runs. Polish phases receive all four structure archives from
 * the same repeat; later structure phases receive earlier rungs only.
 */
export function priorStructurePhaseNames(phaseName: string): readonly string[] {
  const suffix = repeatSuffixFromPhaseName(phaseName);
  if (phaseName.startsWith("polish")) {
    return structurePhaseNamesForRepeat(suffix);
  }
  const match = phaseName.match(/^structure-(\d+)/);
  if (!match) return [];
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index) || index <= 1) return [];
  return structurePhaseNamesForRepeat(suffix).slice(0, index - 1);
}

/** Stable filename token for a training sample rate (e.g. `0.01`, `1`). */
export function sampleRateKey(trainingSampleRate: number): string {
  if (trainingSampleRate >= 1) return "1";
  const fixed = trainingSampleRate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return fixed.startsWith(".") ? `0${fixed}` : fixed;
}

/** Path to the archived champion for one completed phase. */
export function phaseChampionPath(phaseName: string): string {
  return join(PHASE_CHAMPIONS_DIR, `${phaseName}.json`);
}

/** Path to the best-known champion at one training sample rate. */
export function sampleRateChampionPath(trainingSampleRate: number): string {
  return join(PHASE_CHAMPIONS_DIR, `rate-${sampleRateKey(trainingSampleRate)}.json`);
}

/** True when two creature exports describe the same topology and weights. */
export function creatureExportsEqual(a: CreatureExport, b: CreatureExport): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge seed exports, dropping duplicates (first occurrence wins). */
export function mergePopulationSeedExports(
  ...groups: readonly (readonly CreatureExport[])[]
): CreatureExport[] {
  const merged: CreatureExport[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const creatureExport of group) {
      const key = JSON.stringify(creatureExport);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(creatureExport);
    }
  }
  return merged;
}

/**
 * Whether the evolving lineage champion should advance to `candidateHoldout`.
 * Subsample phases reject candidates that regress full hold-out test accuracy.
 */
export function shouldAdvanceLineageChampion(
  holdoutBefore: { testAccuracy: number },
  holdoutAfter: { testAccuracy: number },
): boolean {
  return holdoutAfter.testAccuracy >= holdoutBefore.testAccuracy;
}

/** Persist the fittest creature from a completed exploration phase. */
export async function savePhaseChampion(
  phaseName: string,
  creatureExport: CreatureExport,
): Promise<void> {
  ensureDirSync(PHASE_CHAMPIONS_DIR);
  await Deno.writeTextFile(phaseChampionPath(phaseName), JSON.stringify(creatureExport));
}

/** Load a previously archived phase champion, if present. */
export async function loadPhaseChampion(
  phaseName: string,
): Promise<CreatureExport | undefined> {
  try {
    const text = await Deno.readTextFile(phaseChampionPath(phaseName));
    return JSON.parse(text) as CreatureExport;
  } catch {
    return undefined;
  }
}

/**
 * Load archived champions for all prior structure phases in the same repeat.
 * Missing files are skipped (e.g. first structure phase of a fresh campaign).
 */
export async function loadPriorStructureChampions(
  phaseName: string,
): Promise<CreatureExport[]> {
  const exports: CreatureExport[] = [];
  for (const name of priorStructurePhaseNames(phaseName)) {
    const creatureExport = await loadPhaseChampion(name);
    if (creatureExport !== undefined) {
      exports.push(creatureExport);
    }
  }
  return exports;
}

/** Load the archived champion for one training sample rate, if present. */
export async function loadSampleRateChampion(
  trainingSampleRate: number,
): Promise<SampleRateChampionRecord | undefined> {
  try {
    const text = await Deno.readTextFile(sampleRateChampionPath(trainingSampleRate));
    return JSON.parse(text) as SampleRateChampionRecord;
  } catch {
    return undefined;
  }
}

/**
 * Keep the best creature for `trainingSampleRate` (by NEAT score at that rate).
 * Returns whether the archive was updated.
 */
export async function maybeUpdateSampleRateChampion(options: {
  trainingSampleRate: number;
  phaseName: string;
  creatureExport: CreatureExport;
  evolveScore: number;
  testAccuracy: number;
  validationAccuracy: number;
}): Promise<boolean> {
  const existing = await loadSampleRateChampion(options.trainingSampleRate);
  if (existing !== undefined && options.evolveScore <= existing.evolveScore) {
    return false;
  }

  ensureDirSync(PHASE_CHAMPIONS_DIR);
  const record: SampleRateChampionRecord = {
    trainingSampleRate: options.trainingSampleRate,
    evolveScore: options.evolveScore,
    testAccuracy: options.testAccuracy,
    validationAccuracy: options.validationAccuracy,
    export: options.creatureExport,
    phaseName: options.phaseName,
    timestamp: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    sampleRateChampionPath(options.trainingSampleRate),
    JSON.stringify(record),
  );
  return true;
}

/**
 * Load archived champions from every other training sample rate so the
 * population carries diversity without overwriting the lineage seed.
 */
export async function loadOtherSampleRateChampions(
  currentTrainingSampleRate: number,
): Promise<CreatureExport[]> {
  const exports: CreatureExport[] = [];
  const currentKey = sampleRateKey(currentTrainingSampleRate);

  try {
    for await (const entry of Deno.readDir(PHASE_CHAMPIONS_DIR)) {
      if (!entry.isFile || !entry.name.startsWith("rate-") || !entry.name.endsWith(".json")) {
        continue;
      }
      const key = entry.name.slice("rate-".length, -".json".length);
      if (key === currentKey) continue;

      const text = await Deno.readTextFile(join(PHASE_CHAMPIONS_DIR, entry.name));
      const record = JSON.parse(text) as SampleRateChampionRecord;
      exports.push(record.export);
    }
  } catch {
    // Directory may not exist yet.
  }

  return exports;
}

/**
 * Elitism count when seeding with archived sample-level champions.
 * Keeps at least one slot per archive plus the evolving seed lineage.
 */
export function elitismForArchivedChampions(archiveCount: number): number {
  if (archiveCount <= 0) return 1;
  return Math.min(10, Math.max(2, archiveCount + 1));
}
