/**
 * Local population pool — sampled-exploration parity for a single machine.
 *
 * Layout:
 *   `.creatures/`  — seeds injected into each Learn/evolveDir population
 *   `.sampler/loop-N.json` — fittest creature after sampler loop N
 *   `experiments/intelligent-design/` — Intelligent Design scratch output
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import type { CreatureExport } from "@stsoftware/neat-ai";

import { MNIST_ROOT } from "./mnist_classification.ts";
import {
  creatureExportsEqual,
  loadOtherSampleRateChampions,
  sampleRateChampionPath,
} from "./phase_champions.ts";

const EXPLORATION_ROOT = join(MNIST_ROOT, "exploration");
const PHASE_CHAMPIONS_DIR = join(EXPLORATION_ROOT, "phase-champions");

/** `.creatures` — population injected before each evolve phase. */
export const CREATURES_DIR = join(EXPLORATION_ROOT, ".creatures");

/** `.sampler/loop-N.json` archives. */
export const SAMPLER_DIR = join(EXPLORATION_ROOT, ".sampler");

/** Intelligent Design experiment output (one subdir per squash pass). */
export const EXPERIMENTS_DIR = join(EXPLORATION_ROOT, "experiments");

/** Trace scratch (`.trace` — reserved for future use). */
export const TRACE_DIR = join(EXPLORATION_ROOT, ".trace");

/** Path to one sampler-loop champion file. */
export function samplerLoopPath(loopIndex: number): string {
  return join(SAMPLER_DIR, `loop-${loopIndex}.json`);
}

/** Parse `loop-3` / `loop-3-r2` → loop index (1-based). */
export function loopIndexFromPhaseName(phaseName: string): number | undefined {
  const match = phaseName.match(/^loop-(\d+)/);
  if (!match) return undefined;
  const index = Number.parseInt(match[1]!, 10);
  return Number.isFinite(index) && index >= 1 ? index : undefined;
}

/** Earlier loop phase names in the same repeat (`loop-1` … `loop-(n-1)`). */
export function priorLoopPhaseNames(phaseName: string): readonly string[] {
  const index = loopIndexFromPhaseName(phaseName);
  if (index === undefined || index <= 1) return [];
  const suffix = phaseName.replace(/^loop-\d+/, "");
  return Array.from({ length: index - 1 }, (_, i) => `loop-${i + 1}${suffix}`);
}

/** Persist the fittest creature from sampler loop `loopIndex`. */
export async function saveSamplerLoopChampion(
  loopIndex: number,
  creatureExport: CreatureExport,
): Promise<void> {
  ensureDirSync(SAMPLER_DIR);
  await Deno.writeTextFile(samplerLoopPath(loopIndex), JSON.stringify(creatureExport));
}

/** Load a prior sampler-loop champion, if present. */
export async function loadSamplerLoopChampion(
  loopIndex: number,
): Promise<CreatureExport | undefined> {
  try {
    const text = await Deno.readTextFile(samplerLoopPath(loopIndex));
    return JSON.parse(text) as CreatureExport;
  } catch {
    return undefined;
  }
}

/** Load archived champions from earlier loops in the same repeat. */
export async function loadPriorLoopChampions(phaseName: string): Promise<CreatureExport[]> {
  const exports: CreatureExport[] = [];
  for (const name of priorLoopPhaseNames(phaseName)) {
    const index = loopIndexFromPhaseName(name);
    if (index === undefined) continue;
    const creatureExport = await loadSamplerLoopChampion(index);
    if (creatureExport !== undefined) {
      exports.push(creatureExport);
    }
  }
  return exports;
}

/**
 * Refresh `.creatures/` from sampler loops, sample-rate archives, and the
 * current lineage champion.
 */
export async function refreshCreaturesDirectory(options: {
  phaseName: string;
  lineageExport: CreatureExport;
}): Promise<void> {
  ensureDirSync(CREATURES_DIR);

  const priorLoops = priorLoopPhaseNames(options.phaseName);
  for (const name of priorLoops) {
    const index = loopIndexFromPhaseName(name);
    if (index === undefined) continue;
    const creatureExport = await loadSamplerLoopChampion(index);
    if (creatureExport === undefined) continue;
    await Deno.writeTextFile(
      join(CREATURES_DIR, `sampler-${index}.json`),
      JSON.stringify(creatureExport),
    );
  }

  await Deno.writeTextFile(
    join(CREATURES_DIR, "lineage.json"),
    JSON.stringify(options.lineageExport),
  );

  try {
    for await (const entry of Deno.readDir(join(EXPLORATION_ROOT, "phase-champions"))) {
      if (!entry.isFile || !entry.name.startsWith("rate-") || !entry.name.endsWith(".json")) {
        continue;
      }
      const text = await Deno.readTextFile(
        join(PHASE_CHAMPIONS_DIR, entry.name),
      );
      const record = JSON.parse(text) as { export: CreatureExport };
      await Deno.writeTextFile(
        join(CREATURES_DIR, entry.name.replace(".json", ".creature.json")),
        JSON.stringify(record.export),
      );
    }
  } catch {
    // phase-champions may not exist yet on a fresh run.
  }
}

/** Load every creature JSON from `.creatures/` for population seeding. */
export async function loadCreaturesDirectorySeeds(
  excludeExport?: CreatureExport,
): Promise<CreatureExport[]> {
  const exports: CreatureExport[] = [];
  try {
    for await (const entry of Deno.readDir(CREATURES_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const text = await Deno.readTextFile(join(CREATURES_DIR, entry.name));
      const creatureExport = JSON.parse(text) as CreatureExport;
      if (excludeExport !== undefined && creatureExportsEqual(creatureExport, excludeExport)) {
        continue;
      }
      exports.push(creatureExport);
    }
  } catch {
    // Directory may not exist yet.
  }
  return exports;
}

/**
 * Build the full population seed list for one phase: `.creatures` pool,
 * other sample-rate archives, and earlier loops — excluding the lineage seed.
 */
export async function loadPopulationPoolSeeds(options: {
  phaseName: string;
  currentTrainingSampleRate: number;
  lineageExport: CreatureExport;
}): Promise<CreatureExport[]> {
  await refreshCreaturesDirectory({
    phaseName: options.phaseName,
    lineageExport: options.lineageExport,
  });

  const fromCreatures = await loadCreaturesDirectorySeeds(options.lineageExport);
  const fromRates = await loadOtherSampleRateChampions(options.currentTrainingSampleRate);
  const fromLoops = await loadPriorLoopChampions(options.phaseName);

  const merged: CreatureExport[] = [];
  const seen = new Set<string>();
  for (const creatureExport of [...fromCreatures, ...fromRates, ...fromLoops]) {
    if (creatureExportsEqual(creatureExport, options.lineageExport)) continue;
    const key = JSON.stringify(creatureExport);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(creatureExport);
  }
  return merged;
}

/** Wipe local pool directories (used by `--fresh`). */
export async function wipePopulationPool(): Promise<void> {
  for (const dir of [CREATURES_DIR, SAMPLER_DIR, EXPERIMENTS_DIR, TRACE_DIR]) {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // Best-effort — directory may not exist.
    }
  }
}

/** Ensure Intelligent Design output directory exists for one squash pass. */
export function intelligentDesignOutputDir(squash: string): string {
  const dir = join(EXPERIMENTS_DIR, "intelligent-design", squash);
  ensureDirSync(dir);
  return dir;
}

/** Export path helper for tests. */
export { sampleRateChampionPath };
