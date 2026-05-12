/**
 * Adaptive Mutation — Classification Task Primitives (issue #262).
 *
 * Self-contained data + scoring primitives for a concrete binary
 * classification problem the adaptive-mutation demo solves from scratch.
 * Wiring these into the evolution loop is deferred to the follow-up
 * sub-issue — this module is currently unused by `adaptive_mutation.ts`.
 *
 * ## Task chosen — 4-bit even parity
 *
 * The classic XOR generalisation: given four binary inputs
 * `(b0, b1, b2, b3) ∈ {0, 1}⁴`, return label `1` when the number of `1`
 * bits is **even** (count of 1s ∈ {0, 2, 4}), else label `0`. The full
 * 16-row truth table is perfectly class-balanced (8 even, 8 odd).
 *
 * ### Why hidden neurons are required
 *
 * Parity is not linearly separable — for any choice of weights and
 * bias, a single direct input → output synapse layer (no hidden
 * neurons) cannot fit the 4-bit truth table. The adaptive-mutation
 * policy is exactly what is being demonstrated: the minimal NEAT seed
 * `new Creature(4, 1)` has zero hidden neurons, so NEAT-AI must
 * **invent** at least one hidden neuron (and therefore new
 * inter-layer synapses) before the network can score above chance.
 * That structural growth is the visible signal of the policy at work.
 *
 * ### Why parity over the other candidates
 *
 *   - 6-bit multiplexer (64 rows): richer but slower — overkill for a
 *     demo whose narrative point is *growth from a tiny seed*.
 *   - Symmetry/palindrome: variable input width is more flexible but
 *     less canonical. Parity is the textbook XOR generalisation.
 *
 * Picking 4-bit parity keeps the truth table small enough to converge
 * inside the 5-minute backstop and clearly differs from
 * `xor_classification` (4 rows) and `mnist_classification` (real
 * 14×14 images) — the chosen problem fills a useful middle ground.
 */
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import type { Creature } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";

/** Number of input features (the four parity bits). */
export const INPUT_COUNT = 4;

/** Number of outputs — single scalar, classification via `>= 0.5` threshold. */
export const OUTPUT_COUNT = 1;

/** Human-readable task identifier, embedded in README and CSV captions. */
export const TASK_NAME = "4-bit even parity";

/** Size of the complete truth table (`2 ** INPUT_COUNT`). */
export const TRUTH_TABLE_SIZE = 1 << INPUT_COUNT;

/** A single (input, target) classification record. */
export interface DataPoint {
  inputs: Float32Array;
  targets: Float32Array;
}

/** Decode a truth-table row index into its 4 bits, little-endian (bit 0 = i[0]). */
function bitsForRow(rowIndex: number): number[] {
  const bits: number[] = [];
  for (let j = 0; j < INPUT_COUNT; j++) {
    bits.push((rowIndex >> j) & 1);
  }
  return bits;
}

/**
 * Truth function: returns `1` if `bits` has an **even** number of `1`s
 * (count ∈ {0, 2, 4}), else `0`. The chosen labelling is "is this input
 * even-parity?" — the complement of XOR, and the standard textbook
 * "even-parity detector".
 */
export function evenParityLabel(bits: readonly number[]): 0 | 1 {
  if (bits.length !== INPUT_COUNT) {
    throw new Error(
      `evenParityLabel expects ${INPUT_COUNT} bits, got ${bits.length}`,
    );
  }
  let count = 0;
  for (const b of bits) {
    if (b !== 0 && b !== 1) {
      throw new Error(`evenParityLabel expects binary bits, got ${b}`);
    }
    count += b;
  }
  return count % 2 === 0 ? 1 : 0;
}

/**
 * Encode a binary class label as a Float32 target vector for the binary
 * `.bin` file. Single-output formulation: a single scalar `0` or `1`.
 */
export function targetVectorFor(label: number): Float32Array {
  if (label !== 0 && label !== 1) {
    throw new Error(`label must be 0 or 1, got ${label}`);
  }
  return new Float32Array([label]);
}

/**
 * Generate a deterministic classification dataset for the chosen task.
 *
 *   - When `size` is at most the truth-table cardinality (16 for 4-bit
 *     parity), the returned dataset is a deterministically-shuffled
 *     subset of the **unique** truth-table rows (no repeats). With
 *     `size === TRUTH_TABLE_SIZE` (the default) every row appears
 *     exactly once, so class balance is perfect (8 / 8).
 *   - When `size` exceeds the truth-table cardinality, the function
 *     draws balanced samples by alternating the requested label and
 *     picking a uniform-random row that satisfies it. Class balance is
 *     then exact (`size / 2` of each label) regardless of seed.
 *
 * Determinism: the same `(seed, size)` pair yields byte-identical
 * datasets across runs and platforms — verified by the test suite.
 */
export function generateClassificationDataset(
  seed: number,
  size: number = TRUTH_TABLE_SIZE,
): DataPoint[] {
  if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(size)) {
    throw new Error(`size must be a positive integer, got ${size}`);
  }

  const rng = createDeterministicRandom(seed);
  const dataset: DataPoint[] = [];

  if (size <= TRUTH_TABLE_SIZE) {
    // Subset of the truth table, Fisher–Yates-shuffled by `seed`. With
    // size === TRUTH_TABLE_SIZE this returns every row exactly once.
    const indices: number[] = [];
    for (let i = 0; i < TRUTH_TABLE_SIZE; i++) indices.push(i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = indices[i];
      indices[i] = indices[j];
      indices[j] = tmp;
    }
    for (let k = 0; k < size; k++) {
      const bits = bitsForRow(indices[k]);
      const label = evenParityLabel(bits);
      dataset.push({
        inputs: Float32Array.from(bits),
        targets: targetVectorFor(label),
      });
    }
    return dataset;
  }

  // Larger than the truth table: alternate labels and pick a uniform
  // random row of that label. Pre-compute the row index pools per label
  // so picking is O(1) per sample.
  const rowsByLabel: { 0: number[]; 1: number[] } = { 0: [], 1: [] };
  for (let i = 0; i < TRUTH_TABLE_SIZE; i++) {
    const label = evenParityLabel(bitsForRow(i));
    rowsByLabel[label].push(i);
  }
  for (let i = 0; i < size; i++) {
    const desiredLabel: 0 | 1 = (i % 2) === 0 ? 1 : 0;
    const pool = rowsByLabel[desiredLabel];
    const pick = pool[Math.floor(rng() * pool.length)];
    const bits = bitsForRow(pick);
    dataset.push({
      inputs: Float32Array.from(bits),
      targets: targetVectorFor(desiredLabel),
    });
  }
  return dataset;
}

/**
 * Write `dataset` as a Float32 little-endian binary file consumable by
 * `Creature.evolveDir(dir, ...)`. Each record is laid out as
 * `INPUT_COUNT + OUTPUT_COUNT` floats — matching the convention used
 * by the rest of the example suite.
 *
 * Returns the absolute path of the written file.
 */
export function writeBinaryClassificationDataset(
  dataset: readonly DataPoint[],
  dataDir: string,
): string {
  if (dataset.length === 0) {
    throw new Error("dataset must contain at least one record");
  }
  ensureDirSync(dataDir);
  const stride = INPUT_COUNT + OUTPUT_COUNT;
  const buffer = new Float32Array(dataset.length * stride);
  for (let i = 0; i < dataset.length; i++) {
    if (dataset[i].inputs.length !== INPUT_COUNT) {
      throw new Error(
        `record ${i} has ${dataset[i].inputs.length} inputs, expected ${INPUT_COUNT}`,
      );
    }
    if (dataset[i].targets.length !== OUTPUT_COUNT) {
      throw new Error(
        `record ${i} has ${dataset[i].targets.length} targets, expected ${OUTPUT_COUNT}`,
      );
    }
    for (let k = 0; k < INPUT_COUNT; k++) {
      buffer[i * stride + k] = dataset[i].inputs[k];
    }
    for (let o = 0; o < OUTPUT_COUNT; o++) {
      buffer[i * stride + INPUT_COUNT + o] = dataset[i].targets[o];
    }
  }
  const path = join(dataDir, "training.bin");
  Deno.writeFileSync(path, new Uint8Array(buffer.buffer));
  return path;
}

/**
 * Fraction in `[0, 1]` of records in `dataset` that `creature`
 * classifies correctly. For the single-output binary formulation the
 * prediction rule is `output[0] >= 0.5 ⇒ class 1`; for a hypothetical
 * multi-output extension argmax is used. The expected class is decoded
 * the same way from `point.targets`.
 *
 * The creature's `clearState()` is called before each activation so
 * recurrent state from a previous sample does not bleed in.
 */
export function classifierAccuracy(
  creature: Creature,
  dataset: readonly DataPoint[],
): number {
  if (dataset.length === 0) return 0;
  let correct = 0;
  for (const point of dataset) {
    creature.clearState();
    const out = creature.activate(point.inputs);
    let predicted: number;
    if (OUTPUT_COUNT === 1) {
      predicted = out[0] >= 0.5 ? 1 : 0;
    } else {
      let maxIdx = 0;
      for (let i = 1; i < out.length; i++) {
        if (out[i] > out[maxIdx]) maxIdx = i;
      }
      predicted = maxIdx;
    }
    const expected = OUTPUT_COUNT === 1 ? (point.targets[0] >= 0.5 ? 1 : 0) : argmax(point.targets);
    if (predicted === expected) correct++;
  }
  return correct / dataset.length;
}

/** Argmax of a Float32Array — used by the multi-output branch. */
function argmax(values: ArrayLike<number>): number {
  let maxIdx = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[maxIdx]) maxIdx = i;
  }
  return maxIdx;
}
