/**
 * Unit tests for the MNIST classification example.
 *
 * "What" tests only — each test calls a real function with
 * deterministic data (synthetic IDX bytes built in-memory or a tiny
 * hand-crafted DigitSample list) and asserts on the observable
 * outputs (parsed counts, network accuracy, SVG structure, byte-stable
 * binary file output).
 *
 * Under #327 the legacy single-run `EvolveDirSummary` SVG was replaced
 * with the multi-run persistence + chart pipeline shared with the other
 * in-scope examples. The retired tests were:
 *
 *   - `EVOLUTION_SUMMARY_SVG_PATH points at …` (constant removed)
 *   - `evolveDir milestone SVG contains each numeric callout …` (chart removed)
 *
 * The README-embed test now checks the new multi-run chart paths, and
 * the `MnistRunSummary` round-trip test now covers the two new fields
 * (`runIndex`, `resumed`) added by the multi-run wiring.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { Costs, Creature } from "@stsoftware/neat-ai";
import { dirname, join, normalize } from "@std/path";

import { asCreatureExport } from "../common/legacy_types.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  buildDigitSamples,
  CLASS_COUNT,
  type DigitSample,
  FEATURE_COUNT,
  IMAGE_SIZE,
  parseIdxImages,
  parseIdxLabels,
  readGzippedFile,
  splitDataset,
} from "./data.ts";
import {
  assertNoTargetErrorCliOverride,
  buildGridCells,
  buildMnistFactorySeed,
  classificationAccuracy,
  confusionMatrix,
  evolveResultToMultiRunSample,
  formatGenerationLogLine,
  inferStopCondition,
  MNIST_EVOLVE_COST_NAME,
  MNIST_FACTORY_COST,
  type MnistRunSummary,
  pickGridSamples,
  predict,
  readMnistTrainingRecords,
  shouldDisableDiscovery,
  TRAIN_BIN_FILENAME,
  writeMnistTrainingBin,
} from "./mnist_classification.ts";
import { GRID_COLS, GRID_ROWS, renderDigitGridSVG } from "./svg.ts";
import { fillForClass } from "../common/svg_test_utils.ts";

/**
 * Build a synthetic IDX-3 image buffer with `count` images of size
 * `IMAGE_SIZE × IMAGE_SIZE`. Each image's pixel block is a function of
 * its label so the resulting dataset has a strong, learnable signal —
 * pixels in the digit's own row are 220, all others are 20.
 */
function buildSyntheticIdx(
  seed: number,
  perClass: number,
): { images: Uint8Array; labels: Uint8Array } {
  const rng = createDeterministicRandom(seed);
  const total = CLASS_COUNT * perClass;
  const stride = IMAGE_SIZE * IMAGE_SIZE;

  const imageBuf = new Uint8Array(16 + total * stride);
  const imageView = new DataView(imageBuf.buffer);
  imageView.setUint32(0, 0x00000803);
  imageView.setUint32(4, total);
  imageView.setUint32(8, IMAGE_SIZE);
  imageView.setUint32(12, IMAGE_SIZE);

  const labelBuf = new Uint8Array(8 + total);
  const labelView = new DataView(labelBuf.buffer);
  labelView.setUint32(0, 0x00000801);
  labelView.setUint32(4, total);

  // Round-robin through labels so train/val/test slices each see a
  // mix of classes when the caller takes contiguous prefixes.
  for (let i = 0; i < total; i++) {
    const label = i % CLASS_COUNT;
    labelBuf[8 + i] = label;
    const offset = 16 + i * stride;
    const labelRow = label;
    for (let y = 0; y < IMAGE_SIZE; y++) {
      const blockY = Math.floor(y / (IMAGE_SIZE / CLASS_COUNT));
      const baseValue = blockY === labelRow ? 220 : 20;
      for (let x = 0; x < IMAGE_SIZE; x++) {
        const noise = Math.floor(rng() * 8);
        imageBuf[offset + y * IMAGE_SIZE + x] = Math.min(255, baseValue + noise);
      }
    }
  }
  return { images: imageBuf, labels: labelBuf };
}

Deno.test("formatGenerationLogLine writes one TSV row per generation", () => {
  const line = formatGenerationLogLine(3, {
    generation: 7,
    bestFitness: 0.142,
    averageFitness: 0.118,
    populationSize: 50,
    elapsedMs: 12_345,
  }, "2026-05-23T10:00:00.000Z");
  assertEquals(line, "2026-05-23T10:00:00.000Z\t3\t7\t0.142\t0.118\t50\t12345");
});

Deno.test("MNIST_EVOLVE_COST_NAME is registered in NEAT-AI", () => {
  // Issue #523: switched from CATEGORICAL_ERROR (non-differentiable
  // 1 − argmax accuracy) to CROSS_ENTROPY (softmax + cross-entropy), the
  // standard training cost for multi-class classification. Argmax
  // accuracy is still reported separately via classificationAccuracy /
  // confusionMatrix — it just no longer drives selection.
  assertEquals(MNIST_EVOLVE_COST_NAME, "CROSS_ENTROPY");
  assertEquals(Costs.getAvailableCosts().includes(MNIST_EVOLVE_COST_NAME), true);
  // Cross-entropy must discriminate: a near-correct softmax distribution
  // must score lower (better) than a uniform one for the same target.
  const target = new Float32Array([0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const uniform = new Float32Array(10).fill(0.1);
  const closeToTarget = Float32Array.from(
    [0.01, 0.01, 0.91, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
  );
  const cost = Costs.find(MNIST_EVOLVE_COST_NAME);
  const uniformLoss = cost.calculate(target, uniform);
  const closeLoss = cost.calculate(target, closeToTarget);
  assert(Number.isFinite(uniformLoss) && uniformLoss > 0);
  assert(Number.isFinite(closeLoss) && closeLoss >= 0);
  assert(closeLoss < uniformLoss, `expected close (${closeLoss}) < uniform (${uniformLoss})`);
});

Deno.test("FEATURE_COUNT is 784 (full 28×28)", () => {
  assertEquals(FEATURE_COUNT, 784);
  assertEquals(FEATURE_COUNT, IMAGE_SIZE * IMAGE_SIZE);
});

Deno.test("MNIST_FACTORY_COST matches the evolveDir cost name", () => {
  // Factory must scan with the same cost evolveDir later scores against
  // so the cost-derived output activation (SOFTMAX for CROSS_ENTROPY in
  // multi-class classification) is the one the run actually uses
  // (issues #518, #523).
  assertEquals(MNIST_FACTORY_COST, MNIST_EVOLVE_COST_NAME);
});

Deno.test("buildMnistFactorySeed produces a MNIST-shaped creature with SOFTMAX outputs", () => {
  // Issue #518: drop the hardcoded [128, 64] hidden seed and build the
  // initial creature via Creature.forDataset. The factory:
  //   - couples the output activation to the cost (SOFTMAX from
  //     CROSS_ENTROPY for multi-class classification — issue #523);
  //   - sizes a hidden layer from the (784, 10) shape — far smaller than
  //     the legacy [128, 64];
  //   - prunes synapses leaving constant-variance input pixels.
  // Build a tiny synthetic dataset (per-class distinct patterns) so the
  // scan can see real variance; the factory only needs `input.length` =
  // FEATURE_COUNT and `output.length` = CLASS_COUNT.
  const samples: DigitSample[] = [];
  for (let c = 0; c < CLASS_COUNT; c++) {
    const features = new Array<number>(FEATURE_COUNT).fill(0).map((_, j) =>
      ((j + c * 7) % 13) / 13
    );
    samples.push({ index: c, label: c, features, pixels: [] });
  }
  const tmp = Deno.makeTempDirSync({ prefix: "mnist-factory-" });
  try {
    const path = join(tmp, TRAIN_BIN_FILENAME);
    writeMnistTrainingBin(samples, path);
    const records = readMnistTrainingRecords(tmp);
    assertEquals(records.length, samples.length);
    assertEquals(records[0].input.length, FEATURE_COUNT);
    assertEquals(records[0].output.length, CLASS_COUNT);

    const seed = buildMnistFactorySeed(records);
    assertEquals(seed.input, FEATURE_COUNT);
    assertEquals(seed.output, CLASS_COUNT);
    // The factory must size hiddens from (784, 10), not the legacy
    // [128, 64] lookup. The geometric-mean rule picks ≈ √(784·10) ≈ 89,
    // so the hidden count is well under the legacy 128+64=192 floor.
    assertGreater(seed.neurons.length, FEATURE_COUNT + CLASS_COUNT);
    assert(
      seed.neurons.length < FEATURE_COUNT + 192 + CLASS_COUNT,
      `factory seed should be smaller than the legacy [128,64] (≤${
        FEATURE_COUNT + 192 + CLASS_COUNT
      }), got ${seed.neurons.length}`,
    );
    // Multi-class classification cost (CROSS_ENTROPY, ≥ 2 outputs) ⇒
    // SOFTMAX output activation (issue #523).
    const outputs = seed.neurons.filter((n) => n.type === "output");
    assertEquals(outputs.length, CLASS_COUNT);
    for (const o of outputs) {
      assertEquals(o.squash, "SOFTMAX");
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("buildMnistFactorySeed rejects an empty record list", () => {
  assertThrows(
    () => buildMnistFactorySeed([]),
    Error,
    "must not be empty",
  );
});

Deno.test("readMnistTrainingRecords rejects an empty file", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "mnist-empty-" });
  try {
    Deno.writeFileSync(join(tmp, TRAIN_BIN_FILENAME), new Uint8Array(0));
    assertThrows(
      () => readMnistTrainingRecords(tmp),
      Error,
      "no records found",
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test(
  "evolveResultToMultiRunSample maps evolve result fields onto the milestone shape",
  () => {
    const champion = new Creature(FEATURE_COUNT, CLASS_COUNT);
    const result = {
      champion,
      bestError: 0.75,
      bestScore: 0.25,
      generations: 2,
      wallClockMs: 1234,
      seedNeurons: champion.neurons.length,
      seedSynapses: champion.synapses.length,
    };
    const sample = evolveResultToMultiRunSample(result);
    assertEquals(sample.runGen, result.generations);
    assertEquals(sample.error, 0.75);
    assertEquals(sample.bestScore, result.bestScore);
    assertEquals(sample.neurons, result.champion.neurons.length);
    assertEquals(sample.synapses, result.champion.synapses.length);
    assertEquals(sample.generationWallClockMs, result.wallClockMs);
  },
);

Deno.test("evolveResultToMultiRunSample floors error at 0 but preserves cross-entropy values > 1", () => {
  // Issue #523: under CROSS_ENTROPY the error is the mean cross-entropy
  // in nats — non-negative but unbounded above (a uniform-prediction
  // 10-class baseline is ≈ ln(10) ≈ 2.30). The legacy [0, 1] cap suited
  // CATEGORICAL_ERROR (a misclassification rate); under cross-entropy
  // it would silently flatten the early-evolution part of the curve, so
  // we keep the lower floor at 0 (to swallow scorer noise) and let
  // larger values through.
  const champion = new Creature(FEATURE_COUNT, CLASS_COUNT);
  const base = {
    champion,
    bestScore: 0.25,
    generations: 1,
    wallClockMs: 1,
    seedNeurons: champion.neurons.length,
    seedSynapses: champion.synapses.length,
  };
  assertEquals(evolveResultToMultiRunSample({ ...base, bestError: -0.2 }).error, 0);
  assertEquals(evolveResultToMultiRunSample({ ...base, bestError: 2.3 }).error, 2.3);
});

Deno.test("parseIdxImages parses synthetic header and body", () => {
  const { images } = buildSyntheticIdx(1, 2);
  const parsed = parseIdxImages(images);
  assertEquals(parsed.count, 2 * CLASS_COUNT);
  assertEquals(parsed.rows, IMAGE_SIZE);
  assertEquals(parsed.cols, IMAGE_SIZE);
  assertEquals(parsed.data.length, parsed.count * IMAGE_SIZE * IMAGE_SIZE);
});

Deno.test("parseIdxLabels parses synthetic labels", () => {
  const { labels } = buildSyntheticIdx(1, 3);
  const parsed = parseIdxLabels(labels);
  assertEquals(parsed.count, 3 * CLASS_COUNT);
  for (let i = 0; i < CLASS_COUNT; i++) {
    assertEquals(parsed.data[i], i);
  }
});

Deno.test("parseIdxImages rejects bad magic numbers", () => {
  const buf = new Uint8Array(16);
  assertThrows(() => parseIdxImages(buf), Error, "bad magic");
});

Deno.test("parseIdxLabels rejects truncated buffers", () => {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, 0x00000801);
  view.setUint32(4, 100);
  assertThrows(() => parseIdxLabels(new Uint8Array(view.buffer)), Error, "truncated");
});

Deno.test("buildDigitSamples produces one 784-feature sample per (image, label) pair", () => {
  const { images, labels } = buildSyntheticIdx(2, 2);
  const samples = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
  assertEquals(samples.length, 2 * CLASS_COUNT);
  assertEquals(samples[0].label, 0);
  assertEquals(samples[0].features.length, FEATURE_COUNT);
  assertEquals(samples[0].pixels.length, IMAGE_SIZE * IMAGE_SIZE);
  for (const v of samples[0].features) {
    assert(v >= 0 && v <= 1, `expected feature in [0,1], got ${v}`);
  }
});

Deno.test("buildDigitSamples normalises features to pixel/255", () => {
  const { images, labels } = buildSyntheticIdx(8, 1);
  const samples = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
  for (const sample of samples) {
    assertEquals(sample.features.length, FEATURE_COUNT);
    for (let j = 0; j < FEATURE_COUNT; j++) {
      assertAlmostEquals(sample.features[j], sample.pixels[j] / 255, 1e-9);
    }
  }
});

Deno.test("splitDataset slices contiguously and validates counts", () => {
  const { images, labels } = buildSyntheticIdx(3, 4);
  const samples = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
  const split = splitDataset(samples, { trainCount: 20, validationCount: 10, testCount: 10 });
  assertEquals(split.train.length, 20);
  assertEquals(split.validation.length, 10);
  assertEquals(split.test.length, 10);
  assertEquals(split.train[0].index, 0);
  assertEquals(split.validation[0].index, 20);
  assertEquals(split.test[0].index, 30);
});

Deno.test("splitDataset — edge case: empty dataset raises a clear error", () => {
  assertThrows(
    () => splitDataset([], { trainCount: 1, validationCount: 1, testCount: 1 }),
    Error,
    "samples must not be empty",
  );
});

Deno.test("splitDataset rejects splits that exceed available samples", () => {
  const { images, labels } = buildSyntheticIdx(4, 2);
  const samples = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
  assertThrows(
    () => splitDataset(samples, { trainCount: 100, validationCount: 100, testCount: 100 }),
    Error,
    "need at least",
  );
});

Deno.test("predict returns the argmax index", () => {
  // Hand-build a tiny creature whose third output dominates.
  const json = {
    neurons: [
      { type: "input" as const, squash: "LOGISTIC", index: 0, uuid: "input-0" },
      {
        type: "output" as const,
        squash: "LOGISTIC",
        index: 1,
        bias: 0,
        uuid: "output-0",
      },
      {
        type: "output" as const,
        squash: "LOGISTIC",
        index: 2,
        bias: 0,
        uuid: "output-1",
      },
      {
        type: "output" as const,
        squash: "LOGISTIC",
        index: 3,
        bias: 0,
        uuid: "output-2",
      },
    ],
    synapses: [
      { from: 0, to: 1, weight: -5 },
      { from: 0, to: 2, weight: -5 },
      { from: 0, to: 3, weight: 5 },
    ],
    input: 1,
    output: 3,
  };
  const creature = Creature.fromJSON(asCreatureExport(json));
  assertEquals(predict(creature, [1]), 2);
});

Deno.test("classificationAccuracy returns the correct fraction", () => {
  // Two-output diagonal classifier: output 0 fires on x=1, output 1 on y=1.
  const json = {
    neurons: [
      { type: "input" as const, squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input" as const, squash: "LOGISTIC", index: 1, uuid: "input-1" },
      {
        type: "output" as const,
        squash: "LOGISTIC",
        index: 2,
        bias: 0,
        uuid: "output-0",
      },
      {
        type: "output" as const,
        squash: "LOGISTIC",
        index: 3,
        bias: 0,
        uuid: "output-1",
      },
    ],
    synapses: [
      { from: 0, to: 2, weight: 10 },
      { from: 1, to: 2, weight: 0 },
      { from: 0, to: 3, weight: 0 },
      { from: 1, to: 3, weight: 10 },
    ],
    input: 2,
    output: 2,
  };
  const creature = Creature.fromJSON(asCreatureExport(json));
  const samples: DigitSample[] = [
    { index: 0, label: 0, features: [1, 0], pixels: [] },
    { index: 1, label: 1, features: [0, 1], pixels: [] },
    { index: 2, label: 0, features: [0, 1], pixels: [] }, // wrong
  ];
  assertAlmostEquals(classificationAccuracy(creature, samples), 2 / 3, 1e-9);
});

Deno.test("classificationAccuracy returns 0 on an empty list", () => {
  const creature = new Creature(FEATURE_COUNT, CLASS_COUNT);
  assertEquals(classificationAccuracy(creature, []), 0);
});

Deno.test("confusionMatrix is square and counts true vs predicted", () => {
  const json = {
    neurons: [
      { type: "input" as const, squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input" as const, squash: "LOGISTIC", index: 1, uuid: "input-1" },
      {
        type: "output" as const,
        squash: "LOGISTIC",
        index: 2,
        bias: 0,
        uuid: "output-0",
      },
      {
        type: "output" as const,
        squash: "LOGISTIC",
        index: 3,
        bias: 0,
        uuid: "output-1",
      },
    ],
    synapses: [
      { from: 0, to: 2, weight: 10 },
      { from: 1, to: 2, weight: 0 },
      { from: 0, to: 3, weight: 0 },
      { from: 1, to: 3, weight: 10 },
    ],
    input: 2,
    output: 2,
  };
  const creature = Creature.fromJSON(asCreatureExport(json));
  const samples: DigitSample[] = [
    { index: 0, label: 0, features: [1, 0], pixels: [] },
    { index: 1, label: 0, features: [0, 1], pixels: [] }, // misclassified as 1
    { index: 2, label: 1, features: [0, 1], pixels: [] },
  ];
  const m = confusionMatrix(creature, samples, 2);
  assertEquals(m.length, 2);
  assertEquals(m[0][0], 1);
  assertEquals(m[0][1], 1);
  assertEquals(m[1][1], 1);
});

Deno.test("pickGridSamples spreads picks across classes when possible", () => {
  const samples: DigitSample[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push({
      index: i,
      label: i % CLASS_COUNT,
      features: new Array(FEATURE_COUNT).fill(0),
      pixels: new Array(IMAGE_SIZE * IMAGE_SIZE).fill(0),
    });
  }
  const picks = pickGridSamples(samples, 10);
  const labels = new Set(picks.map((s) => s.label));
  assertEquals(labels.size, CLASS_COUNT);
});

Deno.test("buildGridCells emits at most GRID_ROWS*GRID_COLS cells with frames", () => {
  const samples: DigitSample[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push({
      index: i,
      label: i % CLASS_COUNT,
      features: new Array(FEATURE_COUNT).fill(0),
      pixels: new Array(IMAGE_SIZE * IMAGE_SIZE).fill(0),
    });
  }
  const creature = new Creature(FEATURE_COUNT, CLASS_COUNT);
  const cells = buildGridCells(creature, samples, 2);
  assertGreaterOrEqual(cells.length, 1);
  assert(cells.length <= GRID_ROWS * GRID_COLS);
  for (const cell of cells) {
    assert(cell.frames.length > 0);
    for (const frame of cell.frames) {
      assertEquals(frame.pixels.length, IMAGE_SIZE * IMAGE_SIZE);
      assert(frame.label >= 0 && frame.label < CLASS_COUNT);
      assert(frame.prediction >= 0 && frame.prediction < CLASS_COUNT);
    }
  }
});

Deno.test("renderDigitGridSVG emits an animated SVG with distinctly coloured hit/miss labels for the 784-feature flow", () => {
  const cells = [
    {
      frames: [
        {
          pixels: new Array(IMAGE_SIZE * IMAGE_SIZE).fill(180),
          label: 3,
          prediction: 3, // correct
        },
        {
          pixels: new Array(IMAGE_SIZE * IMAGE_SIZE).fill(180),
          label: 7,
          prediction: 4, // wrong
        },
      ],
    },
  ];
  const svg = renderDigitGridSVG({ cells, accuracy: 0.6, validationAccuracy: 0.55 });
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assertGreater(svg.length, 0);
  assert(svg.match(/<animate /), "expected at least one <animate> element");
  // A correct prediction and a wrong one must be told apart by colour. The
  // contract is "different", not any particular hex — a restyle must not
  // fail this test.
  const correctFill = fillForClass(svg, "cell-label-correct");
  const wrongFill = fillForClass(svg, "cell-label-wrong");
  assert(correctFill, "correct-prediction label must carry a fill");
  assert(wrongFill, "wrong-prediction label must carry a fill");
  assertNotEquals(
    correctFill,
    wrongFill,
    "correct and wrong prediction labels need distinct colours",
  );
  assert(svg.includes("Validation accuracy"));
  assert(svg.includes("Test accuracy"));
});

Deno.test("renderDigitGridSVG throws on an empty cell list", () => {
  assertThrows(
    () => renderDigitGridSVG({ cells: [], accuracy: 0, validationAccuracy: 0 }),
    Error,
    "at least one cell",
  );
});

Deno.test("writeMnistTrainingBin writes the documented binary record stride (784 + 10)", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "mnist-bin-" });
  try {
    const samples: DigitSample[] = [
      {
        index: 0,
        label: 3,
        features: new Array<number>(FEATURE_COUNT).fill(0).map((_, i) => (i % 5) / 10),
        pixels: [],
      },
      {
        index: 1,
        label: 7,
        features: new Array<number>(FEATURE_COUNT).fill(0).map((_, i) => 1 - (i % 4) / 5),
        pixels: [],
      },
    ];
    const path = join(tmp, "mnist_train.bin");
    writeMnistTrainingBin(samples, path);
    const bytes = Deno.readFileSync(path);
    // 2 records × (784 features + 10 outputs) × 4 bytes = 6 352 bytes.
    assertEquals(bytes.byteLength, samples.length * (FEATURE_COUNT + CLASS_COUNT) * 4);

    const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    // Record 0: features[0..783] then one-hot label-3 (output_3 = 1).
    assertAlmostEquals(view[0], samples[0].features[0], 1e-6);
    for (let c = 0; c < CLASS_COUNT; c++) {
      assertAlmostEquals(view[FEATURE_COUNT + c], c === 3 ? 1 : 0, 1e-6);
    }
    // Record 1: features[0..783] then one-hot label-7 (output_7 = 1).
    const stride = FEATURE_COUNT + CLASS_COUNT;
    for (let c = 0; c < CLASS_COUNT; c++) {
      assertAlmostEquals(view[stride + FEATURE_COUNT + c], c === 7 ? 1 : 0, 1e-6);
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeMnistTrainingBin round-trips synthetic samples", () => {
  // Round-trip: write a small synthetic batch then read every Float32
  // back and confirm features and one-hot labels match exactly.
  const tmp = Deno.makeTempDirSync({ prefix: "mnist-bin-rt-" });
  try {
    const samples: DigitSample[] = [];
    for (let i = 0; i < 4; i++) {
      const features = new Array<number>(FEATURE_COUNT).fill(0).map((_, j) => ((i + j) % 7) / 13);
      samples.push({
        index: i,
        label: i % CLASS_COUNT,
        features,
        pixels: [],
      });
    }
    const path = join(tmp, "rt.bin");
    writeMnistTrainingBin(samples, path);
    const bytes = Deno.readFileSync(path);
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const stride = FEATURE_COUNT + CLASS_COUNT;
    assertEquals(view.length, samples.length * stride);
    for (let i = 0; i < samples.length; i++) {
      const base = i * stride;
      for (let j = 0; j < FEATURE_COUNT; j++) {
        assertAlmostEquals(view[base + j], samples[i].features[j], 1e-6);
      }
      for (let c = 0; c < CLASS_COUNT; c++) {
        assertAlmostEquals(view[base + FEATURE_COUNT + c], c === samples[i].label ? 1 : 0, 1e-6);
      }
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeMnistTrainingBin rejects an empty sample list", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "mnist-bin-" });
  try {
    assertThrows(
      () => writeMnistTrainingBin([], join(tmp, "out.bin")),
      Error,
      "must not be empty",
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeMnistTrainingBin rejects out-of-range labels", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "mnist-bin-" });
  try {
    const sample: DigitSample = {
      index: 0,
      label: 99,
      features: new Array<number>(FEATURE_COUNT).fill(0),
      pixels: [],
    };
    assertThrows(
      () => writeMnistTrainingBin([sample], join(tmp, "out.bin")),
      Error,
      "out of range",
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeMnistTrainingBin rejects feature vectors of the wrong length", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "mnist-bin-" });
  try {
    const sample: DigitSample = {
      index: 0,
      label: 0,
      features: new Array<number>(196).fill(0),
      pixels: [],
    };
    assertThrows(
      () => writeMnistTrainingBin([sample], join(tmp, "out.bin")),
      Error,
      `expected ${FEATURE_COUNT} features`,
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("shouldDisableDiscovery keeps Discovery ON for a normal run regardless of timeout", () => {
  // Regression for #516: a real run with no wall-clock backstop
  // (timeoutMinutes: 0) must NOT disable structural Discovery.
  assertEquals(shouldDisableDiscovery({ dataDir: ".", timeoutMinutes: 0 }), false);
  // A real run with a positive timeout also keeps Discovery on.
  assertEquals(shouldDisableDiscovery({ dataDir: ".", timeoutMinutes: 5 }), false);
});

Deno.test("shouldDisableDiscovery disables Discovery only on the unit-test path", () => {
  // testCaps marks the FFI-sanitiser-constrained unit-test path: the only
  // place Discovery is legitimately switched off.
  assertEquals(
    shouldDisableDiscovery({ dataDir: ".", timeoutMinutes: 0, testCaps: {} }),
    true,
  );
  assertEquals(
    shouldDisableDiscovery({ dataDir: ".", timeoutMinutes: 5, testCaps: { populationSize: 4 } }),
    true,
  );
});

Deno.test("inferStopCondition reports timeoutMinutes when wall-clock fills the budget", () => {
  // 10-minute budget, used 9 m 35 s ≈ 95 % of the budget → timeoutMinutes.
  assertEquals(inferStopCondition(575_000, 10), "timeoutMinutes");
  // 10-minute budget exactly used.
  assertEquals(inferStopCondition(600_000, 10), "timeoutMinutes");
});

Deno.test("inferStopCondition reports targetError when the run finishes well inside the budget", () => {
  // 10-minute budget, used 1 minute → targetError fired first.
  assertEquals(inferStopCondition(60_000, 10), "targetError");
  // 1-minute budget, used 30 s → targetError.
  assertEquals(inferStopCondition(30_000, 1), "targetError");
});

Deno.test("MnistRunSummary round-trips the multi-run + evolveDir milestone fields", () => {
  const summary: MnistRunSummary = {
    trainingRecords: 60_000,
    evolveWallClockMs: 305_000,
    targetError: 0.0001,
    timeoutMinutes: 5,
    seedNeurons: 794,
    seedSynapses: 7840,
    finalNeurons: 794,
    finalSynapses: 7841,
    validationAccuracy: 0.109,
    testAccuracy: 0.1037,
    stopCondition: "timeoutMinutes",
    evolveDirError: 0.087,
    evolveDirScore: 0.913,
    evolveDirGenerations: 42,
    runIndex: 1,
    resumed: false,
  };
  const round = JSON.parse(JSON.stringify(summary)) as MnistRunSummary;
  assertEquals(round.evolveDirError, summary.evolveDirError);
  assertEquals(round.evolveDirScore, summary.evolveDirScore);
  assertEquals(round.evolveDirGenerations, summary.evolveDirGenerations);
  assertEquals(round.runIndex, summary.runIndex);
  assertEquals(round.resumed, summary.resumed);
  // Existing fields still survive the round-trip.
  assertEquals(round.trainingRecords, summary.trainingRecords);
  assertEquals(round.stopCondition, summary.stopCondition);
});

Deno.test("assertNoTargetErrorCliOverride rejects --target-error flags", () => {
  assertThrows(
    () => assertNoTargetErrorCliOverride(["--target-error=0.1"]),
    Error,
    "does not accept --target-error",
  );
  assertThrows(
    () => assertNoTargetErrorCliOverride(["--timeout=5", "--target-error"]),
    Error,
    "does not accept --target-error",
  );
  assertNoTargetErrorCliOverride(["--timeout=15"]);
});

// The former source-text grep test "mnist run.sh grants --allow-ffi …"
// was removed under issue #530. It was a "how" test (anti-pattern #2):
// it asserted the literal `--allow-ffi` substring appears in run.sh, and
// since the flag moved into the shared preamble (NEAT_EXAMPLE_DENO_FLAGS)
// it only ever matched the *comment* that mentions the flag — passing on
// doc text, not on any granted permission. The behaviour it stood proxy
// for (every Discovery runner is granted FFI via the shared preamble) is
// already covered behaviourally in `common/run_sh_permissions_test.ts`
// ("example runner preamble grants required Deno flags" and "every run.sh
// that loads Discovery uses shared Deno flags with --allow-ffi").

Deno.test("every chart embedded in the mnist README resolves to a non-empty asset", async () => {
  // WHAT-test (replaces the former source-text substring/absence greps,
  // issue #530). The behaviour the old test stood proxy for is that the
  // charts the README embeds actually exist and render. Parse the
  // embedded image targets and assert each local asset is a non-empty
  // file. This is robust to restructuring the docs tree (move the embed
  // and the asset together) and catches the real regression — a broken
  // chart link — instead of failing on a harmless path reformat.
  const readmePath = "mnist_classification/README.md";
  const readme = await Deno.readTextFile(readmePath);
  const readmeDir = dirname(readmePath);

  // Markdown image embeds: ![alt](target). Keep only local asset
  // references (skip absolute URLs and in-page anchors).
  const embeds = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((target) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !target.startsWith("#"));
  assert(embeds.length > 0, "mnist README must embed at least one chart asset");

  for (const ref of embeds) {
    const path = normalize(join(readmeDir, ref));
    const stat = await Deno.stat(path).catch(() => null);
    assert(
      stat?.isFile && stat.size > 0,
      `mnist README embeds ${ref} but ${path} is missing or empty`,
    );
  }

  // The multi-run charts are the headline artefacts of this example, so
  // both must remain embedded. Couple only to the chart pipeline's
  // output filenames (a stable contract), not to the brittle relative
  // doc path the old test asserted.
  const basenames = embeds.map((ref) => ref.split("/").pop());
  for (const chart of ["milestones.svg", "complexity.svg"]) {
    assert(
      basenames.includes(chart),
      `mnist README must embed the multi-run ${chart} chart`,
    );
  }
});

Deno.test("top-level README MNIST entries match the real 784 / 28×28 code (Issue #515)", () => {
  const readme = Deno.readTextFileSync("README.md");
  // Stale wording from when MNIST used a 14×14 down-sample must be gone.
  assert(
    !readme.includes("196 → 10"),
    "top-level README must not describe MNIST as a 196 → 10 classifier",
  );
  assert(
    !readme.includes("14×14 down-sample"),
    "top-level README must not describe MNIST as a 14×14 down-sample",
  );
  // The corrected wording must reflect the real 784 / 28×28 full-resolution input.
  assert(
    readme.includes("784"),
    "top-level README MNIST entry must reference the real 784 input features",
  );
  assert(
    readme.includes("28×28"),
    "top-level README MNIST entry must reference the native 28×28 input",
  );
});

Deno.test("readGzippedFile rejects a missing file", async () => {
  await assertRejects(() => readGzippedFile("/no/such/path/data.gz"), Error);
});

Deno.test("readGzippedFile round-trips bytes via DecompressionStream", async () => {
  const original = new TextEncoder().encode("hello mnist!");
  // deno-lint-ignore no-explicit-any
  const blob = new Blob([original as any]);
  const compressed = blob.stream().pipeThrough(new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of compressed as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }

  const tmp = await Deno.makeTempFile({ suffix: ".gz" });
  try {
    await Deno.writeFile(tmp, buf);
    const round = await readGzippedFile(tmp);
    assertEquals(new TextDecoder().decode(round), "hello mnist!");
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});
