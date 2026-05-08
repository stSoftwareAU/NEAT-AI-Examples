/**
 * Unit tests for the MLP gradient-descent trainer used by the
 * MNIST classification example.
 *
 * "What" tests only — every test calls a real function with
 * deterministic data and asserts on observable outputs (forward-pass
 * shape, predicted argmax, validation accuracy after training, etc.).
 */

import { assert, assertAlmostEquals, assertEquals, assertGreater, assertThrows } from "@std/assert";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { CLASS_COUNT, type DigitSample, FEATURE_COUNT } from "./data.ts";
import {
  cloneGenes,
  forwardMLP,
  initMLPGenes,
  mlpAccuracy,
  predictMLPClass,
  trainMLP,
  trainStep,
} from "./gradient.ts";

/**
 * Build a tiny synthetic dataset where the label perfectly determines
 * a single hot feature. With FEATURE_COUNT > CLASS_COUNT the network
 * has plenty of capacity to memorise the mapping.
 */
function buildSyntheticSamples(count: number): DigitSample[] {
  const out: DigitSample[] = [];
  for (let i = 0; i < count; i++) {
    const label = i % CLASS_COUNT;
    const features = new Array<number>(FEATURE_COUNT).fill(0);
    features[label] = 1;
    out.push({
      index: i,
      label,
      features,
      pixels: new Array<number>(28 * 28).fill(0),
    });
  }
  return out;
}

Deno.test("initMLPGenes — produces shape-correct weight matrices and zero biases", () => {
  const random = createDeterministicRandom(7);
  const genes = initMLPGenes(random, 8, 4, 3);
  assertEquals(genes.W1.length, 4);
  for (const row of genes.W1) assertEquals(row.length, 8);
  assertEquals(genes.W2.length, 3);
  for (const row of genes.W2) assertEquals(row.length, 4);
  assertEquals(genes.b1, [0, 0, 0, 0]);
  assertEquals(genes.b2, [0, 0, 0]);
});

Deno.test("initMLPGenes — rejects non-positive layer sizes", () => {
  const random = createDeterministicRandom(1);
  assertThrows(() => initMLPGenes(random, 0, 4, 3), Error, "layer sizes must be positive");
  assertThrows(() => initMLPGenes(random, 4, 0, 3), Error, "layer sizes must be positive");
});

Deno.test("forwardMLP — emits hidden and output activations of the expected shape", () => {
  const random = createDeterministicRandom(11);
  const genes = initMLPGenes(random, 5, 3, 2);
  const acts = forwardMLP(genes, [0.1, 0.2, 0.3, 0.4, 0.5]);
  assertEquals(acts.hidden.length, 3);
  assertEquals(acts.output.length, 2);
  // Sigmoid range is `(0, 1)`.
  for (const v of acts.hidden) assert(v > 0 && v < 1);
  for (const v of acts.output) assert(v > 0 && v < 1);
});

Deno.test("forwardMLP — rejects feature vectors of the wrong length", () => {
  const random = createDeterministicRandom(13);
  const genes = initMLPGenes(random, 3, 2, 2);
  assertThrows(() => forwardMLP(genes, [0.1, 0.2]), Error, "expected 3 features");
});

Deno.test("predictMLPClass — returns the argmax of the output layer", () => {
  // Hand-build a tiny network whose second output is dominant.
  const genes = {
    W1: [[1, 0]],
    b1: [0],
    W2: [[-5], [5]],
    b2: [0, 0],
  };
  assertEquals(predictMLPClass(genes, [1, 0]), 1);
});

Deno.test("trainStep — moves weights toward the gradient (loss decreases for one batch)", () => {
  const random = createDeterministicRandom(17);
  const genes = initMLPGenes(random, 4, 3, 2);
  const sample = { features: [1, 0, 0, 0], label: 1 };
  const before = forwardMLP(genes, sample.features).output[1];
  const vW1 = genes.W1.map((r) => new Array<number>(r.length).fill(0));
  const vb1 = new Array<number>(genes.b1.length).fill(0);
  const vW2 = genes.W2.map((r) => new Array<number>(r.length).fill(0));
  const vb2 = new Array<number>(genes.b2.length).fill(0);
  // Repeat the same single-sample batch many times — the network
  // should move y[label] strictly upward.
  for (let i = 0; i < 80; i++) {
    trainStep(genes, [sample], 2, 1.0, 0, vW1, vb1, vW2, vb2);
  }
  const after = forwardMLP(genes, sample.features).output[1];
  assertGreater(after, before);
});

Deno.test("trainMLP — reaches high accuracy on a separable synthetic dataset", () => {
  const random = createDeterministicRandom(23);
  const train = buildSyntheticSamples(200);
  const validation = buildSyntheticSamples(50);
  const result = trainMLP(random, train, validation, FEATURE_COUNT, CLASS_COUNT, {
    seed: 23,
    hiddenCount: 16,
    maxEpochs: 30,
    batchSize: 16,
    learningRate: 0.5,
    momentum: 0.9,
    accuracyThreshold: 1.0,
  });
  // The synthetic dataset is trivially separable; well above 0.9.
  assertGreater(result.validationAccuracy, 0.9);
  assertEquals(result.history.length, result.epochs);
});

Deno.test("trainMLP — rejects empty training and validation slices", () => {
  const random = createDeterministicRandom(29);
  const samples = buildSyntheticSamples(5);
  assertThrows(
    () =>
      trainMLP(random, [], samples, FEATURE_COUNT, CLASS_COUNT, {
        seed: 1,
        hiddenCount: 4,
        maxEpochs: 1,
        batchSize: 2,
        learningRate: 0.1,
        momentum: 0,
      }),
    Error,
    "training set must not be empty",
  );
  assertThrows(
    () =>
      trainMLP(random, samples, [], FEATURE_COUNT, CLASS_COUNT, {
        seed: 1,
        hiddenCount: 4,
        maxEpochs: 1,
        batchSize: 2,
        learningRate: 0.1,
        momentum: 0,
      }),
    Error,
    "validation set must not be empty",
  );
});

Deno.test("trainMLP — reproducibility: same seed produces byte-identical genomes", () => {
  const train = buildSyntheticSamples(60);
  const validation = buildSyntheticSamples(20);
  const opts = {
    seed: 4242,
    hiddenCount: 8,
    maxEpochs: 5,
    batchSize: 8,
    learningRate: 0.3,
    momentum: 0.5,
    accuracyThreshold: 1.0,
  };
  const r1 = trainMLP(
    createDeterministicRandom(4242),
    train,
    validation,
    FEATURE_COUNT,
    CLASS_COUNT,
    opts,
  );
  const r2 = trainMLP(
    createDeterministicRandom(4242),
    train,
    validation,
    FEATURE_COUNT,
    CLASS_COUNT,
    opts,
  );
  assertEquals(JSON.stringify(r1.genes), JSON.stringify(r2.genes));
});

Deno.test("cloneGenes — produces an independent deep copy", () => {
  const random = createDeterministicRandom(31);
  const genes = initMLPGenes(random, 3, 2, 2);
  const clone = cloneGenes(genes);
  clone.W1[0][0] = 99;
  clone.b1[0] = -42;
  assert(genes.W1[0][0] !== 99);
  assert(genes.b1[0] !== -42);
});

Deno.test("mlpAccuracy — returns 0 on an empty list", () => {
  const random = createDeterministicRandom(37);
  const genes = initMLPGenes(random, 4, 2, 3);
  assertEquals(mlpAccuracy(genes, []), 0);
});

Deno.test("forwardMLP — sigmoid clamps stay finite for huge inputs", () => {
  const genes = {
    W1: [[1e3]],
    b1: [0],
    W2: [[1e3], [-1e3]],
    b2: [0, 0],
  };
  const acts = forwardMLP(genes, [1]);
  // Sigmoid of `1e3` should be ~1, not Infinity or NaN.
  assertAlmostEquals(acts.hidden[0], 1, 1e-12);
  assertAlmostEquals(acts.output[0], 1, 1e-12);
  assertAlmostEquals(acts.output[1], 0, 1e-12);
});
