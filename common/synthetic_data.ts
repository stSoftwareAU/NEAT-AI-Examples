/**
 * Shared synthetic data generation utilities for NEAT-AI examples.
 *
 * Provides deterministic binary training data generation and creature scoring
 * functions used across multiple example modules (discovery, intelligent design,
 * crossover). Each example defines its own SyntheticConfig with a unique seed
 * to ensure independent, reproducible data sets.
 */

import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";
import { createDeterministicRandom } from "./deterministic_random.ts";

/** Configuration for synthetic data generation. */
export interface SyntheticConfig {
  /** Total number of training records to generate. */
  totalRecords: number;
  /** Maximum number of records per binary file. */
  recordsPerFile: number;
  /** Seed for the deterministic PRNG. */
  seed: number;
}

/**
 * Generates deterministic synthetic training data using the creature's activation.
 *
 * Uses a seeded PRNG for reproducible input generation and derives
 * input/output sizes from the creature rather than hardcoding them.
 * Target outputs come from the creature's own activate() method,
 * producing self-consistent training data.
 *
 * Binary files are written as sequences of Float32 values: for each record,
 * `creature.input` input floats followed by `creature.output` output floats.
 */
export function generateSyntheticData(
  creature: Creature,
  dataDir: string,
  config: SyntheticConfig,
): void {
  const random = createDeterministicRandom(config.seed);
  const bytesPerRecord = (creature.input + creature.output) * 4;

  let remaining = config.totalRecords;
  let fileIndex = 0;

  while (remaining > 0) {
    const batchSize = Math.min(config.recordsPerFile, remaining);
    const filePath = join(
      dataDir,
      `synthetic_${String(fileIndex).padStart(4, "0")}.bin`,
    );

    const buffer = new Uint8Array(bytesPerRecord * batchSize);
    const view = new Float32Array(buffer.buffer);

    let offset = 0;
    for (let record = 0; record < batchSize; record++) {
      // Generate deterministic random input in range [-1, 1]
      for (let i = 0; i < creature.input; i++) {
        view[offset + i] = random() * 2 - 1;
      }

      // Get creature's output for this input
      const input = view.subarray(offset, offset + creature.input);
      creature.clearState();
      const output = creature.activate(Float32Array.from(input));

      // Store output
      for (let j = 0; j < creature.output; j++) {
        view[offset + creature.input + j] = output[j] ?? 0;
      }

      offset += creature.input + creature.output;
    }

    Deno.writeFileSync(filePath, buffer);
    console.log(`   Generated ${batchSize} records to ${filePath}`);

    remaining -= batchSize;
    fileIndex++;
  }
}

/**
 * Scores a creature against a directory of training data.
 *
 * Returns the numeric score (higher is better; scores are typically negative).
 */
export function scoreCreature(creature: Creature, dataDir: string): number {
  const result = creature.scoreDir(dataDir, {});
  return result.score;
}
