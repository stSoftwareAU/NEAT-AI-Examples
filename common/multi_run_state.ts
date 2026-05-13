/**
 * Multi-run persistence helper for cross-run NEAT-AI evolution.
 *
 * Lets an example resume evolution from a previous run by reloading the
 * latest champion and appending new milestones to a merged history. Each
 * milestone carries both a per-run generation number and a cumulative
 * generation across all runs, so charts can plot the true x-axis.
 *
 * Artefact layout (relative to a configurable base directory, defaulting
 * to `docs`):
 *
 * - `data/<exampleSlug>/creature.json`        — latest champion (overwritten)
 * - `data/<exampleSlug>/milestones.json`      — merged milestone history
 * - `screenshots/<exampleSlug>/milestones.svg` — chart artefact (wiped on --fresh)
 * - `screenshots/<exampleSlug>/complexity.svg` — chart artefact (wiped on --fresh)
 *
 * The base directory can be overridden via the optional second argument
 * (used by tests) or the `NEAT_MULTI_RUN_BASE_DIR` environment variable.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import { type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

/** Per-sample schema for a single milestone, across all runs. */
export interface MultiRunMilestone {
  /** 1-based run index — 1 for the first run, increases each subsequent resume. */
  runIndex: number;
  /** Generation number within this run (1, 10, 100, ...). */
  runGen: number;
  /** Cumulative generation across all runs combined (true x-axis). */
  cumulativeGen: number;
  /** Normalised error (0 = perfect, 1 = chance). */
  error: number;
  /** Raw best score reported by the library, kept for readability. */
  bestScore: number;
  /** Neuron count of the best creature at this milestone. */
  neurons: number;
  /** Synapse count of the best creature at this milestone. */
  synapses: number;
  /** Optional mean episode steps (RL examples only). */
  meanEpisodeSteps?: number;
  /** Wall-clock duration of the generation that produced this milestone (ms). */
  generationWallClockMs: number;
}

/** Loaded multi-run state. */
export interface MultiRunState {
  /** Latest champion creature export, or `undefined` if no prior run exists. */
  creatureExport?: CreatureExport;
  /** Merged milestone history across all prior runs (in order). */
  milestones: MultiRunMilestone[];
  /** 1-based index to assign to the next run (1 for the first run). */
  nextRunIndex: number;
  /** Highest `cumulativeGen` seen so far (0 if no prior runs). */
  lastCumulativeGen: number;
}

/** Subset of {@link MultiRunMilestone} supplied by callers — the helper
 * fills in `runIndex` and `cumulativeGen`. */
export type NewMultiRunSample = Omit<MultiRunMilestone, "runIndex" | "cumulativeGen">;

/** Arguments for {@link appendMultiRunRun}. */
export interface AppendMultiRunRunArgs {
  /** Champion creature to persist (overwrites any prior champion). */
  creatureExport: CreatureExport;
  /** New milestone samples produced by this run, in generation order. */
  newSamples: readonly NewMultiRunSample[];
  /** 1-based index for this run (use {@link MultiRunState.nextRunIndex}). */
  runIndex: number;
  /** Cumulative generation total before this run started
   * (use {@link MultiRunState.lastCumulativeGen}). */
  baseCumulativeGen: number;
}

/** Flags parsed from a CLI invocation. */
export interface MultiRunFlags {
  /** `--fresh` — wipe prior state before running. */
  fresh: boolean;
  /** `--timeout=<minutes>` — wall-clock budget in minutes. */
  timeoutMinutes?: number;
  /** `--target-error=<value>` — early-stop normalised error threshold. */
  targetError?: number;
}

/** Resolve the base directory used for artefact paths. */
function resolveBaseDir(baseDir?: string): string {
  if (baseDir !== undefined) return baseDir;
  const fromEnv = Deno.env.get("NEAT_MULTI_RUN_BASE_DIR");
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return "docs";
}

function creaturePath(slug: string, baseDir: string): string {
  return join(baseDir, "data", slug, "creature.json");
}

function milestonesPath(slug: string, baseDir: string): string {
  return join(baseDir, "data", slug, "milestones.json");
}

function milestoneSvgPath(slug: string, baseDir: string): string {
  return join(baseDir, "screenshots", slug, "milestones.svg");
}

function complexitySvgPath(slug: string, baseDir: string): string {
  return join(baseDir, "screenshots", slug, "complexity.svg");
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
  // Malformed JSON: let SyntaxError propagate (acceptance: "Throws on malformed JSON").
  return JSON.parse(text) as T;
}

/**
 * Loads multi-run state for an example. Returns documented defaults when
 * no prior artefacts exist. Throws if either JSON file is malformed.
 */
export async function loadMultiRunState(
  exampleSlug: string,
  baseDir?: string,
): Promise<MultiRunState> {
  const base = resolveBaseDir(baseDir);
  const creatureExport = await readJsonIfPresent<CreatureExport>(
    creaturePath(exampleSlug, base),
  );
  const milestones = await readJsonIfPresent<MultiRunMilestone[]>(
    milestonesPath(exampleSlug, base),
  ) ?? [];

  let nextRunIndex = 1;
  let lastCumulativeGen = 0;
  for (const m of milestones) {
    if (m.runIndex >= nextRunIndex) nextRunIndex = m.runIndex + 1;
    if (m.cumulativeGen > lastCumulativeGen) lastCumulativeGen = m.cumulativeGen;
  }

  return { creatureExport, milestones, nextRunIndex, lastCumulativeGen };
}

/**
 * Appends a run's milestones to the merged history and overwrites the
 * champion artefact. Each new sample is stamped with the supplied
 * `runIndex` and a computed `cumulativeGen = baseCumulativeGen + runGen`.
 *
 * Uses {@link safeWriteJson} for atomic temp + rename writes.
 */
export async function appendMultiRunRun(
  exampleSlug: string,
  args: AppendMultiRunRunArgs,
  baseDir?: string,
): Promise<void> {
  const base = resolveBaseDir(baseDir);
  const { creatureExport, newSamples, runIndex, baseCumulativeGen } = args;

  const dir = join(base, "data", exampleSlug);
  ensureDirSync(dir);

  const existing = await readJsonIfPresent<MultiRunMilestone[]>(
    milestonesPath(exampleSlug, base),
  ) ?? [];

  const appended: MultiRunMilestone[] = newSamples.map((s) => ({
    ...s,
    runIndex,
    cumulativeGen: baseCumulativeGen + s.runGen,
  }));

  const merged = [...existing, ...appended];

  await safeWriteJson(creaturePath(exampleSlug, base), creatureExport);
  await safeWriteJson(milestonesPath(exampleSlug, base), merged);
}

/** Remove a path if it exists; missing files are not an error. */
async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

/**
 * Wipe every multi-run artefact for an example: champion JSON, merged
 * milestones JSON, and the two chart SVGs. Missing files are silently
 * skipped — used by `--fresh` to start over.
 */
export async function wipeMultiRunState(
  exampleSlug: string,
  baseDir?: string,
): Promise<void> {
  const base = resolveBaseDir(baseDir);
  await removeIfExists(creaturePath(exampleSlug, base));
  await removeIfExists(milestonesPath(exampleSlug, base));
  await removeIfExists(milestoneSvgPath(exampleSlug, base));
  await removeIfExists(complexitySvgPath(exampleSlug, base));
}

/** Parse a numeric `--name=value` argument; returns `undefined` if missing,
 * malformed, or `NaN`. */
function parseNumericFlag(args: readonly string[], name: string): number | undefined {
  const prefix = `--${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      const raw = arg.slice(prefix.length);
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
      return undefined;
    }
  }
  return undefined;
}

/**
 * Extract the three multi-run CLI flags from an argv-style array.
 *
 * Recognised:
 * - `--fresh`                  → `fresh: true`
 * - `--timeout=<minutes>`      → `timeoutMinutes: number`
 * - `--target-error=<value>`   → `targetError: number`
 *
 * Unknown flags are passed through unchanged — callers strip them as needed.
 * Invalid numeric values (non-finite / NaN / malformed) yield `undefined`.
 */
export function parseMultiRunFlags(args: readonly string[]): MultiRunFlags {
  const fresh = args.includes("--fresh");
  const timeoutMinutes = parseNumericFlag(args, "timeout");
  const targetError = parseNumericFlag(args, "target-error");
  return { fresh, timeoutMinutes, targetError };
}
