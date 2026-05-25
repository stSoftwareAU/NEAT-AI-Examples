/**
 * Per-phase champion archive for the MNIST exploration campaign.
 *
 * Mirrors GRQ `sampler.sh` / `.sampler/loop-${i}.json`: each structure
 * subsample level keeps its fittest creature so a later full-data (100%)
 * polish pass can re-seed the population with winners from earlier sample
 * rates — a creature that looked great at 5% may regress at 100%, but the
 * population still carries the best from each level.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import type { CreatureExport } from "@stsoftware/neat-ai";

import { MNIST_ROOT } from "./mnist_classification.ts";

/** On-disk directory for per-phase champion JSON exports. */
export const PHASE_CHAMPIONS_DIR = join(MNIST_ROOT, "exploration", "phase-champions");

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

/** Path to the archived champion for one completed phase. */
export function phaseChampionPath(phaseName: string): string {
  return join(PHASE_CHAMPIONS_DIR, `${phaseName}.json`);
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

/**
 * Elitism count when seeding with archived sample-level champions.
 * Keeps at least one slot per archive plus the evolving seed lineage.
 */
export function elitismForArchivedChampions(archiveCount: number): number {
  if (archiveCount <= 0) return 1;
  return Math.min(10, Math.max(2, archiveCount + 1));
}
