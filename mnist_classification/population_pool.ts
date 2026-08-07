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

import { MNIST_EXPLORATION_ROOT } from "./mnist_classification.ts";
import {
  creatureExportsEqual,
  loadOtherSampleRateChampions,
  phaseChampionsDir,
  sampleRateChampionPath,
} from "./phase_champions.ts";

/** Pool sub-directories under one exploration root. */
export function populationPoolDirs(explorationRoot = MNIST_EXPLORATION_ROOT): {
  creatures: string;
  sampler: string;
  experiments: string;
  trace: string;
} {
  return {
    creatures: join(explorationRoot, ".creatures"),
    sampler: join(explorationRoot, ".sampler"),
    experiments: join(explorationRoot, "experiments"),
    trace: join(explorationRoot, ".trace"),
  };
}

/** `.creatures` — population injected before each evolve phase. */
export const CREATURES_DIR = populationPoolDirs().creatures;

/** `.sampler/loop-N.json` archives. */
export const SAMPLER_DIR = populationPoolDirs().sampler;

/** Trace scratch (`.trace` — reserved for future use). */
export const TRACE_DIR = populationPoolDirs().trace;

/** Path to one sampler-loop champion file. */
export function samplerLoopPath(
  loopIndex: number,
  explorationRoot = MNIST_EXPLORATION_ROOT,
): string {
  return join(populationPoolDirs(explorationRoot).sampler, `loop-${loopIndex}.json`);
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
  explorationRoot = MNIST_EXPLORATION_ROOT,
): Promise<void> {
  ensureDirSync(populationPoolDirs(explorationRoot).sampler);
  await Deno.writeTextFile(
    samplerLoopPath(loopIndex, explorationRoot),
    JSON.stringify(creatureExport),
  );
}

/** Load a prior sampler-loop champion, if present. */
export async function loadSamplerLoopChampion(
  loopIndex: number,
  explorationRoot = MNIST_EXPLORATION_ROOT,
): Promise<CreatureExport | undefined> {
  try {
    const text = await Deno.readTextFile(samplerLoopPath(loopIndex, explorationRoot));
    return JSON.parse(text) as CreatureExport;
  } catch {
    return undefined;
  }
}

/** Load archived champions from earlier loops in the same repeat. */
export async function loadPriorLoopChampions(
  phaseName: string,
  explorationRoot = MNIST_EXPLORATION_ROOT,
): Promise<CreatureExport[]> {
  const exports: CreatureExport[] = [];
  for (const name of priorLoopPhaseNames(phaseName)) {
    const index = loopIndexFromPhaseName(name);
    if (index === undefined) continue;
    const creatureExport = await loadSamplerLoopChampion(index, explorationRoot);
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
  explorationRoot?: string;
}): Promise<void> {
  const explorationRoot = options.explorationRoot ?? MNIST_EXPLORATION_ROOT;
  const creaturesDir = populationPoolDirs(explorationRoot).creatures;
  const championsDir = phaseChampionsDir(explorationRoot);
  ensureDirSync(creaturesDir);

  const priorLoops = priorLoopPhaseNames(options.phaseName);
  for (const name of priorLoops) {
    const index = loopIndexFromPhaseName(name);
    if (index === undefined) continue;
    const creatureExport = await loadSamplerLoopChampion(index, explorationRoot);
    if (creatureExport === undefined) continue;
    await Deno.writeTextFile(
      join(creaturesDir, `sampler-${index}.json`),
      JSON.stringify(creatureExport),
    );
  }

  await Deno.writeTextFile(
    join(creaturesDir, "lineage.json"),
    JSON.stringify(options.lineageExport),
  );

  try {
    for await (const entry of Deno.readDir(championsDir)) {
      if (!entry.isFile || !entry.name.startsWith("rate-") || !entry.name.endsWith(".json")) {
        continue;
      }
      const text = await Deno.readTextFile(join(championsDir, entry.name));
      const record = JSON.parse(text) as { export: CreatureExport };
      await Deno.writeTextFile(
        join(creaturesDir, entry.name.replace(".json", ".creature.json")),
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
  explorationRoot = MNIST_EXPLORATION_ROOT,
): Promise<CreatureExport[]> {
  const exports: CreatureExport[] = [];
  const creaturesDir = populationPoolDirs(explorationRoot).creatures;
  try {
    for await (const entry of Deno.readDir(creaturesDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const text = await Deno.readTextFile(join(creaturesDir, entry.name));
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
  explorationRoot?: string;
}): Promise<CreatureExport[]> {
  const explorationRoot = options.explorationRoot ?? MNIST_EXPLORATION_ROOT;
  await refreshCreaturesDirectory({
    phaseName: options.phaseName,
    lineageExport: options.lineageExport,
    explorationRoot,
  });

  const fromCreatures = await loadCreaturesDirectorySeeds(options.lineageExport, explorationRoot);
  const fromRates = await loadOtherSampleRateChampions(
    options.currentTrainingSampleRate,
    explorationRoot,
  );
  const fromLoops = await loadPriorLoopChampions(options.phaseName, explorationRoot);

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
export async function wipePopulationPool(
  explorationRoot = MNIST_EXPLORATION_ROOT,
): Promise<void> {
  const dirs = populationPoolDirs(explorationRoot);
  for (const dir of [dirs.creatures, dirs.sampler, dirs.experiments, dirs.trace]) {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // Best-effort — directory may not exist.
    }
  }
}

/** Ensure Intelligent Design output directory exists for one squash pass. */
export function intelligentDesignOutputDir(
  squash: string,
  explorationRoot = MNIST_EXPLORATION_ROOT,
): string {
  const dir = join(populationPoolDirs(explorationRoot).experiments, "intelligent-design", squash);
  ensureDirSync(dir);
  return dir;
}

/** Export path helper for tests. */
export { sampleRateChampionPath };
