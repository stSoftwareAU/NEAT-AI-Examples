/**
 * Shared synthetic data generation utilities for NEAT-AI examples.
 *
 * Provides deterministic binary training data generation and creature scoring
 * functions used across multiple example modules (discovery, intelligent design,
 * crossover). Each example defines its own SyntheticConfig with a unique seed
 * to ensure independent, reproducible data sets.
 *
 * {@link writeBinaryDataset} states the `evolveDir` binary-record contract
 * once (issue #777): a `training.bin` of consecutive Float32 values, each
 * record laid out as `inputCount` inputs followed by `outputCount` targets.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";
import { createDeterministicRandom } from "./deterministic_random.ts";
import { type FeedForwardNetwork, forward, type ScoredRecord } from "./feed_forward_network.ts";

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
export async function scoreCreature(
  creature: Creature,
  dataDir: string,
): Promise<number> {
  const result = await creature.scoreDir(dataDir, {});
  return result.score;
}

/** Name of the binary training file `Creature.evolveDir(dir, ...)` consumes. */
export const TRAINING_FILE_NAME = "training.bin";

/**
 * Write `dataset` as the Float32 binary training file the NEAT-AI library
 * consumes via `Creature.evolveDir(dir, ...)`.
 *
 * The record contract lives here and nowhere else: each record is
 * `inputCount` input floats followed by `outputCount` target floats, packed
 * back to back with no header, into `<dataDir>/training.bin`. Every record
 * must match that arity exactly — a short or long record would silently
 * shift every later record, so a mismatch throws instead.
 *
 * @returns The path of the file written.
 */
export function writeBinaryDataset(
  dataset: readonly ScoredRecord[],
  dataDir: string,
  inputCount: number,
  outputCount: number,
): string {
  assertPositiveInteger(inputCount, "inputCount");
  assertPositiveInteger(outputCount, "outputCount");

  const stride = inputCount + outputCount;
  const buffer = new Float32Array(dataset.length * stride);
  for (let i = 0; i < dataset.length; i++) {
    const { inputs, targets } = dataset[i];
    if (inputs.length !== inputCount) {
      throw new Error(
        `record ${i}: expected ${inputCount} inputs, got ${inputs.length}`,
      );
    }
    if (targets.length !== outputCount) {
      throw new Error(
        `record ${i}: expected ${outputCount} targets, got ${targets.length}`,
      );
    }
    const base = i * stride;
    for (let k = 0; k < inputCount; k++) buffer[base + k] = inputs[k];
    for (let o = 0; o < outputCount; o++) buffer[base + inputCount + o] = targets[o];
  }

  ensureDirSync(dataDir);
  const path = join(dataDir, TRAINING_FILE_NAME);
  Deno.writeFileSync(path, new Uint8Array(buffer.buffer));
  return path;
}

/** Throw unless `value` is a positive integer. */
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
}

/** One generated record: the sampled inputs and the target network's labels. */
export interface NetworkDataPoint {
  inputs: Float32Array;
  targets: Float32Array;
}

/**
 * Generate a deterministic dataset by feeding `size` random inputs through
 * `targetNetwork`. Inputs are drawn uniformly from `[-1, 1]`; the labels are
 * the network's own output activations, so the dataset is exactly learnable.
 */
export function generateNetworkDataset(
  targetNetwork: FeedForwardNetwork,
  size: number,
  seed: number,
): NetworkDataPoint[] {
  if (size <= 0) {
    throw new Error(`dataset size must be positive, got ${size}`);
  }
  const rng = createDeterministicRandom(seed);
  const outStart = targetNetwork.neurons.length - targetNetwork.outputCount;
  const dataset: NetworkDataPoint[] = [];
  for (let i = 0; i < size; i++) {
    const inputs = new Float32Array(targetNetwork.inputCount);
    for (let k = 0; k < targetNetwork.inputCount; k++) {
      inputs[k] = rng() * 2 - 1;
    }
    const acts = forward(targetNetwork, inputs);
    const targets = new Float32Array(targetNetwork.outputCount);
    for (let o = 0; o < targetNetwork.outputCount; o++) {
      targets[o] = acts[outStart + o];
    }
    dataset.push({ inputs, targets });
  }
  return dataset;
}
