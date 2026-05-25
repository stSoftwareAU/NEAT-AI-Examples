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
  assertRejects,
  assertThrows,
} from "@std/assert";
import { Costs, Creature } from "@stsoftware/neat-ai";
import { join } from "@std/path";

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
  buildMnistHiddenReluSeed,
  classificationAccuracy,
  confusionMatrix,
  formatGenerationLogLine,
  inferStopCondition,
  MNIST_EVOLVE_COST_NAME,
  type MnistRunSummary,
  pickGridSamples,
  predict,
  writeMnistTrainingBin,
} from "./mnist_classification.ts";
import { GRID_COLS, GRID_ROWS, renderDigitGridSVG } from "./svg.ts";

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
  assertEquals(MNIST_EVOLVE_COST_NAME, "CATEGORICAL_ERROR");
  assertEquals(Costs.getAvailableCosts().includes(MNIST_EVOLVE_COST_NAME), true);
  const target = new Float32Array([0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const zeros = new Float32Array(10);
  const cost = Costs.find(MNIST_EVOLVE_COST_NAME);
  assertEquals(cost.calculate(target, zeros), 1);
});

Deno.test("FEATURE_COUNT is 784 (full 28×28)", () => {
  assertEquals(FEATURE_COUNT, 784);
  assertEquals(FEATURE_COUNT, IMAGE_SIZE * IMAGE_SIZE);
});

Deno.test("buildMnistHiddenReluSeed uses NEAT-AI layered Creature init", () => {
  const creature = buildMnistHiddenReluSeed();
  assertEquals(creature.neurons.length, FEATURE_COUNT + 128 + 64 + CLASS_COUNT);
  const hidden = creature.neurons.slice(FEATURE_COUNT, -CLASS_COUNT);
  assertGreater(hidden.length, 0);
  for (const neuron of hidden) {
    assertEquals(neuron.squash, "ReLU");
  }
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

Deno.test("renderDigitGridSVG emits an animated SVG with green/red labels for the 784-feature flow", () => {
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
  assert(svg.includes("#2ecc71"));
  assert(svg.includes("#e74c3c"));
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

Deno.test("mnist run.sh grants --allow-ffi for Discovery and evolveDir training", async () => {
  const script = await Deno.readTextFile("mnist_classification/run.sh");
  assert(
    script.includes("--allow-ffi"),
    "mnist_classification/run.sh must pass --allow-ffi so NEAT-AI can load Discovery",
  );
});

Deno.test("README embeds the multi-run charts and drops the legacy evolution_summary path", () => {
  const readme = Deno.readTextFileSync("mnist_classification/README.md");
  assert(
    readme.includes("../docs/screenshots/mnist_classification/milestones.svg"),
    "README must embed the multi-run error-curve chart (milestones.svg)",
  );
  assert(
    readme.includes("../docs/screenshots/mnist_classification/complexity.svg"),
    "README must embed the multi-run complexity chart (complexity.svg)",
  );
  // The legacy single-run evolution_summary chart is retired under #327.
  assert(
    !readme.includes("evolution_summary.svg"),
    "README must no longer reference the retired evolution_summary.svg",
  );
  // The historical #273 deferred placeholder must stay gone.
  assert(
    !readme.includes("Per-generation telemetry — deferred"),
    "README must no longer contain the deferred placeholder line",
  );
  assert(
    !readme.includes("tracked in #273"),
    'README must no longer reference the "tracked in #273" deferred placeholder',
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
