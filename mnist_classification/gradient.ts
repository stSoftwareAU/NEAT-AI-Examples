/**
 * Mini-batch gradient-descent trainer for the MNIST MLP classifier.
 *
 * The original MNIST example used pure mutation evolution on a linear
 * `196 → 10` LOGISTIC classifier and capped at ~70 % accuracy because
 *
 *   1. A linear classifier on 14 × 14 mean-pooled MNIST features
 *      mathematically tops out around 88 %.
 *   2. Pure mutation needs astronomical generation counts to refine
 *      ~2 000 weights with any precision.
 *
 * To reach the 95 % accuracy target requested by issue #138 this
 * module introduces:
 *
 *   - A small **multi-layer perceptron** (`196 → hidden → 10`) with a
 *     LOGISTIC squash on every layer, so the classifier is non-linear.
 *   - **Mini-batch stochastic gradient descent with momentum**, using
 *     the per-output binary-cross-entropy loss that pairs naturally
 *     with sigmoid outputs (the `(y − t)` derivative is identical to
 *     the softmax-cross-entropy gradient on a one-hot target).
 *
 * The trainer is deliberately small and dependency-free — a few hundred
 * lines of TypeScript, no WASM, no external math libraries. That keeps
 * the example readable as a teaching tool while being fast enough to
 * cross 95 % validation accuracy inside the CI quality-check budget.
 *
 * Every public function takes a deterministic random source so the
 * resulting champion is byte-identical for identical inputs and seeds.
 */

import type { DigitSample } from "./data.ts";

/**
 * Genome of a 2-layer LOGISTIC MLP.
 *
 * - `W1` is `[hidden][input]`, `b1` is `[hidden]` — the first layer.
 * - `W2` is `[output][hidden]`, `b2` is `[output]` — the second layer.
 *
 * Every layer applies a per-neuron sigmoid (LOGISTIC) activation so the
 * network can be lifted directly into a NEAT-AI `Creature` with the same
 * squash on every neuron — see `buildMLPCreatureJSON` in
 * `mnist_classification.ts`.
 */
export interface MLPGenes {
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
}

/** Sigmoid activation. */
function sigmoid(x: number): number {
  // Clamp to avoid `Math.exp` blowing up to Infinity for very large
  // magnitudes — keeps the gradient finite during early training when
  // weights are still arbitrary.
  if (x >= 36) return 1;
  if (x <= -36) return 0;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Sample a `[-range, range]` value from the supplied PRNG. Used for
 * uniform weight initialisation.
 */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/**
 * Initialise a fresh MLP genome with Xavier-style uniform weights —
 * each weight in `[-sqrt(6 / (fan_in + fan_out)), +sqrt(6 / ...)]` —
 * and zero biases. The Xavier scale keeps the LOGISTIC pre-activations
 * close to zero on the first forward pass, where the sigmoid gradient
 * is largest, so SGD converges promptly.
 */
export function initMLPGenes(
  random: () => number,
  inputCount: number,
  hiddenCount: number,
  classCount: number,
): MLPGenes {
  if (inputCount <= 0 || hiddenCount <= 0 || classCount <= 0) {
    throw new Error(
      `initMLPGenes: layer sizes must be positive (got ${inputCount}/${hiddenCount}/${classCount})`,
    );
  }
  const r1 = Math.sqrt(6 / (inputCount + hiddenCount));
  const r2 = Math.sqrt(6 / (hiddenCount + classCount));
  const W1: number[][] = Array.from(
    { length: hiddenCount },
    () => Array.from({ length: inputCount }, () => uniformSigned(random, r1)),
  );
  const W2: number[][] = Array.from(
    { length: classCount },
    () => Array.from({ length: hiddenCount }, () => uniformSigned(random, r2)),
  );
  const b1 = new Array<number>(hiddenCount).fill(0);
  const b2 = new Array<number>(classCount).fill(0);
  return { W1, b1, W2, b2 };
}

/** Forward-pass activations needed by the SGD backward pass. */
export interface MLPActivations {
  /** Hidden-layer post-sigmoid output, length `hidden`. */
  hidden: number[];
  /** Output-layer post-sigmoid output, length `output`. */
  output: number[];
}

/**
 * Run a forward pass for a single input feature vector. Returns both
 * the hidden and output activations because the backward pass needs
 * the hidden activations to compute the input-layer gradients.
 */
export function forwardMLP(genes: MLPGenes, features: ArrayLike<number>): MLPActivations {
  const hiddenCount = genes.W1.length;
  const inputCount = genes.W1[0]?.length ?? 0;
  const classCount = genes.W2.length;
  if (features.length !== inputCount) {
    throw new Error(
      `forwardMLP: expected ${inputCount} features, got ${features.length}`,
    );
  }
  const hidden = new Array<number>(hiddenCount);
  for (let h = 0; h < hiddenCount; h++) {
    let z = genes.b1[h];
    const row = genes.W1[h];
    for (let i = 0; i < inputCount; i++) z += row[i] * features[i];
    hidden[h] = sigmoid(z);
  }
  const output = new Array<number>(classCount);
  for (let c = 0; c < classCount; c++) {
    let z = genes.b2[c];
    const row = genes.W2[c];
    for (let h = 0; h < hiddenCount; h++) z += row[h] * hidden[h];
    output[c] = sigmoid(z);
  }
  return { hidden, output };
}

/**
 * Argmax of the MLP output vector — the predicted digit class for the
 * supplied feature vector.
 */
export function predictMLPClass(genes: MLPGenes, features: ArrayLike<number>): number {
  const { output } = forwardMLP(genes, features);
  let argmax = 0;
  let max = output[0];
  for (let c = 1; c < output.length; c++) {
    if (output[c] > max) {
      max = output[c];
      argmax = c;
    }
  }
  return argmax;
}

/** Held-out classification accuracy of the MLP on a sample list. */
export function mlpAccuracy(genes: MLPGenes, samples: readonly DigitSample[]): number {
  if (samples.length === 0) return 0;
  let correct = 0;
  for (const s of samples) {
    if (predictMLPClass(genes, s.features) === s.label) correct++;
  }
  return correct / samples.length;
}

/**
 * Hyper-parameters for {@link trainMLP}. The defaults are tuned for the
 * `196 → 32 → 10` MNIST configuration and reach ≥ 95 % validation
 * accuracy on a 6 000 / 1 000 / 1 000 split inside the CI budget.
 */
export interface TrainOptions {
  /** Random seed for weight init and per-epoch shuffle. */
  seed: number;
  /** Number of hidden units in the single hidden layer. */
  hiddenCount: number;
  /** Maximum number of full epochs through `samples.train`. */
  maxEpochs: number;
  /** Mini-batch size used by SGD. */
  batchSize: number;
  /** Initial learning rate. */
  learningRate: number;
  /** SGD momentum coefficient (`0` disables momentum). */
  momentum: number;
  /**
   * Optional learning-rate decay per epoch. The effective learning
   * rate at epoch `e` is `learningRate * decay**e`. Default `1` — no
   * decay.
   */
  learningRateDecay?: number;
  /**
   * Stop training as soon as validation accuracy reaches this value.
   * Defaults to `1.0` (never early-stop).
   */
  accuracyThreshold?: number;
  /** Optional progress callback fired after each epoch. */
  onEpoch?: (info: EpochInfo) => void;
}

/** Per-epoch statistics emitted by {@link trainMLP}. */
export interface EpochInfo {
  /** Zero-based epoch index. */
  epoch: number;
  /** Best validation accuracy observed up to and including this epoch. */
  bestValidationAccuracy: number;
  /** Validation accuracy of the current epoch's weights. */
  validationAccuracy: number;
  /** Training-set accuracy of the current epoch's weights. */
  trainAccuracy: number;
}

/** Result of {@link trainMLP}. */
export interface TrainResult {
  /** Champion genome — the genes with the best validation accuracy. */
  genes: MLPGenes;
  /** Held-out validation accuracy of the champion. */
  validationAccuracy: number;
  /** Number of epochs actually executed (1-based). */
  epochs: number;
  /** True when validation accuracy crossed `accuracyThreshold`. */
  solved: boolean;
  /** Per-epoch history captured for the evolution chart. */
  history: EpochInfo[];
}

/** A `(features, label)` training pair sliced into a mini-batch. */
interface Pair {
  features: number[];
  label: number;
}

/**
 * Deterministic Fisher–Yates shuffle. `random` is the supplied
 * `createDeterministicRandom` PRNG; in-place mutation matches the
 * convention used elsewhere in the repo.
 */
function shuffleInPlace<T>(arr: T[], random: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Apply one mini-batch SGD step in place on `genes`.
 *
 * The loss is per-output binary cross-entropy with one-hot targets.
 * That gives the clean derivative `dL/dz_out = (y - t)` — identical
 * to softmax-cross-entropy on a one-hot label — so the implementation
 * stays simple while training stably.
 *
 * Velocity buffers (`vW1`, `vb1`, `vW2`, `vb2`) hold the SGD-with-
 * momentum state across batches. Pass empty buffers for vanilla SGD
 * (`momentum = 0`).
 */
export function trainStep(
  genes: MLPGenes,
  batch: readonly Pair[],
  classCount: number,
  learningRate: number,
  momentum: number,
  vW1: number[][],
  vb1: number[],
  vW2: number[][],
  vb2: number[],
): void {
  const hiddenCount = genes.W1.length;
  const inputCount = genes.W1[0]?.length ?? 0;
  // Accumulate gradients across the batch, then apply once.
  const gW1 = Array.from({ length: hiddenCount }, () => new Array<number>(inputCount).fill(0));
  const gb1 = new Array<number>(hiddenCount).fill(0);
  const gW2 = Array.from({ length: classCount }, () => new Array<number>(hiddenCount).fill(0));
  const gb2 = new Array<number>(classCount).fill(0);
  for (const pair of batch) {
    const { hidden, output } = forwardMLP(genes, pair.features);
    // Output-layer error term: dL/dz2 = y - t for sigmoid + BCE.
    const dz2 = new Array<number>(classCount);
    for (let c = 0; c < classCount; c++) {
      const target = c === pair.label ? 1 : 0;
      dz2[c] = output[c] - target;
    }
    // Hidden-layer error term: dL/dz1 = (W2^T · dz2) ⊙ σ'(z1).
    // Using post-activation `hidden` directly: σ'(z) = h * (1 - h).
    const dz1 = new Array<number>(hiddenCount).fill(0);
    for (let c = 0; c < classCount; c++) {
      const w2c = genes.W2[c];
      const e = dz2[c];
      for (let h = 0; h < hiddenCount; h++) dz1[h] += w2c[h] * e;
    }
    for (let h = 0; h < hiddenCount; h++) dz1[h] *= hidden[h] * (1 - hidden[h]);
    // Accumulate weight & bias gradients.
    for (let c = 0; c < classCount; c++) {
      const e = dz2[c];
      const row = gW2[c];
      for (let h = 0; h < hiddenCount; h++) row[h] += e * hidden[h];
      gb2[c] += e;
    }
    for (let h = 0; h < hiddenCount; h++) {
      const e = dz1[h];
      const row = gW1[h];
      for (let i = 0; i < inputCount; i++) row[i] += e * pair.features[i];
      gb1[h] += e;
    }
  }
  // Average gradients over the batch and apply with momentum.
  const inv = 1 / batch.length;
  for (let h = 0; h < hiddenCount; h++) {
    const w1 = genes.W1[h];
    const v1 = vW1[h];
    const g1 = gW1[h];
    for (let i = 0; i < inputCount; i++) {
      v1[i] = momentum * v1[i] - learningRate * g1[i] * inv;
      w1[i] += v1[i];
    }
    vb1[h] = momentum * vb1[h] - learningRate * gb1[h] * inv;
    genes.b1[h] += vb1[h];
  }
  for (let c = 0; c < classCount; c++) {
    const w2 = genes.W2[c];
    const v2 = vW2[c];
    const g2 = gW2[c];
    for (let h = 0; h < hiddenCount; h++) {
      v2[h] = momentum * v2[h] - learningRate * g2[h] * inv;
      w2[h] += v2[h];
    }
    vb2[c] = momentum * vb2[c] - learningRate * gb2[c] * inv;
    genes.b2[c] += vb2[c];
  }
}

/** Make zero-filled velocity buffers matching `genes`. */
function makeVelocity(genes: MLPGenes): {
  vW1: number[][];
  vb1: number[];
  vW2: number[][];
  vb2: number[];
} {
  const vW1 = genes.W1.map((row) => new Array<number>(row.length).fill(0));
  const vb1 = new Array<number>(genes.b1.length).fill(0);
  const vW2 = genes.W2.map((row) => new Array<number>(row.length).fill(0));
  const vb2 = new Array<number>(genes.b2.length).fill(0);
  return { vW1, vb1, vW2, vb2 };
}

/** Deep clone a genome — used to snapshot the champion across epochs. */
export function cloneGenes(genes: MLPGenes): MLPGenes {
  return {
    W1: genes.W1.map((r) => r.slice()),
    b1: genes.b1.slice(),
    W2: genes.W2.map((r) => r.slice()),
    b2: genes.b2.slice(),
  };
}

/**
 * Train a fresh MLP on the supplied train / validation slices.
 *
 * Throws on empty inputs — both slices are required to drive SGD and
 * to score the champion respectively.
 */
export function trainMLP(
  random: () => number,
  train: readonly DigitSample[],
  validation: readonly DigitSample[],
  inputCount: number,
  classCount: number,
  options: TrainOptions,
): TrainResult {
  if (train.length === 0) throw new Error("trainMLP: training set must not be empty");
  if (validation.length === 0) throw new Error("trainMLP: validation set must not be empty");
  if (options.batchSize <= 0) {
    throw new Error(`trainMLP: batchSize must be positive (got ${options.batchSize})`);
  }
  if (options.maxEpochs <= 0) {
    throw new Error(`trainMLP: maxEpochs must be positive (got ${options.maxEpochs})`);
  }
  const decay = options.learningRateDecay ?? 1;
  const threshold = options.accuracyThreshold ?? 1.0;

  const genes = initMLPGenes(random, inputCount, options.hiddenCount, classCount);
  const { vW1, vb1, vW2, vb2 } = makeVelocity(genes);

  const pairs: Pair[] = train.map((s) => ({ features: s.features, label: s.label }));

  let champion = cloneGenes(genes);
  let bestVal = mlpAccuracy(genes, validation);
  let solvedAt = -1;
  const history: EpochInfo[] = [];

  for (let epoch = 0; epoch < options.maxEpochs; epoch++) {
    shuffleInPlace(pairs, random);
    const lr = options.learningRate * decay ** epoch;
    for (let start = 0; start < pairs.length; start += options.batchSize) {
      const end = Math.min(start + options.batchSize, pairs.length);
      const batch = pairs.slice(start, end);
      trainStep(genes, batch, classCount, lr, options.momentum, vW1, vb1, vW2, vb2);
    }
    const valAcc = mlpAccuracy(genes, validation);
    const trainAcc = mlpAccuracy(genes, train);
    if (valAcc > bestVal) {
      bestVal = valAcc;
      champion = cloneGenes(genes);
    }
    const info: EpochInfo = {
      epoch,
      bestValidationAccuracy: bestVal,
      validationAccuracy: valAcc,
      trainAccuracy: trainAcc,
    };
    history.push(info);
    options.onEpoch?.(info);
    if (bestVal >= threshold) {
      solvedAt = epoch;
      break;
    }
  }

  return {
    genes: champion,
    validationAccuracy: bestVal,
    epochs: solvedAt >= 0 ? solvedAt + 1 : options.maxEpochs,
    solved: bestVal >= threshold,
    history,
  };
}
