/**
 * Shared evolution-snapshot helper for NEAT-AI examples.
 *
 * Captures creature state (topology, score, optional sample outputs) at
 * configurable generation checkpoints — by default 1, 10, 100, 1000, and
 * 10000 — so every evolutionary example can produce consistent snapshot
 * data for the evolution-progression visualisation.
 *
 * Snapshots are written as deterministic JSON: stable property order, no
 * timestamps, no run-specific paths. Reruns with the same seed therefore
 * produce byte-identical files.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

/** Default checkpoint generations captured by examples. */
export const DEFAULT_CHECKPOINTS: readonly number[] = [1, 10, 100, 1000, 10000];

/** Configuration controlling which generations are captured and where. */
export interface SnapshotConfig {
  /** Generations at which to capture a snapshot. */
  checkpoints: number[];
  /** Output directory for snapshot files. Created if it does not exist. */
  outputDir: string;
}

/** A single captured snapshot — the on-disk shape of `snapshot-gen-N.json`. */
export interface Snapshot {
  /** Generation at which the snapshot was taken. */
  generation: number;
  /** Score of the captured creature at this generation. */
  score: number;
  /** Serialisable creature topology (typically `creature.exportJSON()`). */
  creature: unknown;
  /** Optional sample outputs recorded alongside the topology. */
  sampleOutputs?: unknown[];
}

function snapshotPath(outputDir: string, generation: number): string {
  return join(outputDir, `snapshot-gen-${generation}.json`);
}

/**
 * Serialise a snapshot to deterministic, pretty-printed JSON.
 *
 * Property order is fixed (generation, score, creature, sampleOutputs) so
 * two captures with identical inputs emit byte-identical bytes.
 */
function serialise(snapshot: Snapshot): string {
  const ordered: Record<string, unknown> = {
    generation: snapshot.generation,
    score: snapshot.score,
    creature: snapshot.creature,
  };
  if (snapshot.sampleOutputs !== undefined) {
    ordered.sampleOutputs = snapshot.sampleOutputs;
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

/**
 * Capture a snapshot when `generation` matches a configured checkpoint.
 *
 * No-op (returns `null`) when `generation` is not in `config.checkpoints`.
 * Otherwise serialises the creature, score, and any sample outputs to
 * `<outputDir>/snapshot-gen-<generation>.json` and returns the path written.
 */
export function captureSnapshot(
  config: SnapshotConfig,
  generation: number,
  creature: unknown,
  score: number,
  sampleOutputs?: unknown[],
): string | null {
  if (!config.checkpoints.includes(generation)) {
    return null;
  }
  ensureDirSync(config.outputDir);
  const path = snapshotPath(config.outputDir, generation);
  const snap: Snapshot = { generation, score, creature };
  if (sampleOutputs !== undefined) {
    snap.sampleOutputs = sampleOutputs;
  }
  Deno.writeTextFileSync(path, serialise(snap));
  return path;
}

/**
 * Read all snapshot files from `outputDir`, returned in ascending
 * generation order. Returns an empty array when the directory does not
 * exist or contains no snapshot files.
 */
export function loadSnapshots(outputDir: string): Snapshot[] {
  const out: Snapshot[] = [];
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(outputDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return out;
    }
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const match = entry.name.match(/^snapshot-gen-(\d+)\.json$/);
    if (!match) continue;
    const text = Deno.readTextFileSync(join(outputDir, entry.name));
    out.push(JSON.parse(text) as Snapshot);
  }
  out.sort((a, b) => a.generation - b.generation);
  return out;
}
