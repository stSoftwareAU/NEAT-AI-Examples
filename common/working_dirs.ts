/**
 * Shared working directory setup for NEAT-AI examples.
 *
 * Each example stores its artefacts (training data, creatures, output) in a
 * hidden directory under the project root. This module provides a consistent
 * setup pattern: ensure the data and creatures directories exist, and empty
 * the output directory so each run starts fresh.
 */

import { emptyDirSync, ensureDirSync } from "@std/fs";
import { join } from "@std/path";

/** Paths returned by setupWorkingDirs. */
export interface WorkingDirs {
  /** Root directory for all artefacts (e.g. ".synthetic-discovery"). */
  root: string;
  /** Subdirectory for binary training data files. */
  dataDir: string;
  /** Subdirectory for creature JSON files. */
  creaturesDir: string;
  /** Subdirectory for output artefacts (emptied on each run). */
  outputDir: string;
}

/**
 * Creates the standard working directory structure for an example.
 *
 * - `<root>/data/` is created if it does not exist.
 * - `<root>/creatures/` is created if it does not exist.
 * - `<root>/output/` is emptied (or created) so each run starts clean.
 */
export function setupWorkingDirs(root: string): WorkingDirs {
  const dataDir = join(root, "data");
  const creaturesDir = join(root, "creatures");
  const outputDir = join(root, "output");

  ensureDirSync(dataDir);
  ensureDirSync(creaturesDir);
  emptyDirSync(outputDir);

  return { root, dataDir, creaturesDir, outputDir };
}
