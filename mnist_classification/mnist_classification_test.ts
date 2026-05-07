/**
 * Unit tests for the MNIST classification example.
 *
 * "What" tests only — each test calls a real function with
 * deterministic data (synthetic IDX bytes built in-memory or a tiny
 * hand-crafted DigitSample list) and asserts on the observable
 * outputs (parsed counts, network accuracy, SVG structure, byte-stable
 * champion serialisation).
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
import { Creature } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  buildDigitSamples,
  CLASS_COUNT,
  type DigitSample,
  DOWNSAMPLED_SIZE,
  downsamplePixels,
  FEATURE_COUNT,
  IMAGE_SIZE,
  parseIdxImages,
  parseIdxLabels,
  readGzippedFile,
  splitDataset,
} from "./data.ts";
import {
  buildGridCells,
  buildInitialCreatureJSON,
  classificationAccuracy,
  classMeanFeatures,
  confusionMatrix,
  evolveClassifier,
  genesFromCreatureJSON,
  mutateCreatureJSON,
  pickGridSamples,
  predict,
  templateCreatureJSON,
} from "./mnist_classification.ts";
import { GRID_COLS, GRID_ROWS, renderDigitGridSVG } from "./svg.ts";

/**
 * Build a synthetic IDX-3 image buffer with `count` images of size
 * `IMAGE_SIZE × IMAGE_SIZE`. Each image's pixel block is a function of
 * its label so the resulting dataset has a strong, learnable signal —
 * pixels in the digit's own row are 220, all others are 20. That gives
 * mutation evolution something concrete to discover within the CI
 * 5-minute budget.
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
    // Label-specific stripe pattern: rows in [labelRow*2, labelRow*2 + 1]
    // are bright; everything else is dim plus tiny noise.
    const labelRow = label;
    for (let y = 0; y < IMAGE_SIZE; y++) {
      const blockY = Math.floor(y / (IMAGE_SIZE / CLASS_COUNT));
      const baseValue = blockY === labelRow ? 220 : 20;
      for (let x = 0; x < IMAGE_SIZE; x++) {
        const noise = Math.floor(rng() * 8); // [0..7]
        imageBuf[offset + y * IMAGE_SIZE + x] = Math.min(255, baseValue + noise);
      }
    }
  }
  return { images: imageBuf, labels: labelBuf };
}

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
  // Labels are round-robin so the first 10 are 0..9.
  for (let i = 0; i < CLASS_COUNT; i++) {
    assertEquals(parsed.data[i], i);
  }
});

Deno.test("parseIdxImages rejects bad magic numbers", () => {
  const buf = new Uint8Array(16);
  // Magic 0 is not the IDX-3 sentinel.
  assertThrows(() => parseIdxImages(buf), Error, "bad magic");
});

Deno.test("parseIdxLabels rejects truncated buffers", () => {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, 0x00000801);
  view.setUint32(4, 100); // claims 100 labels but no body
  assertThrows(() => parseIdxLabels(new Uint8Array(view.buffer)), Error, "truncated");
});

Deno.test("downsamplePixels mean-pools 28×28 to 14×14 with values in [0,1]", () => {
  const pixels = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE).fill(128);
  const down = downsamplePixels(pixels, IMAGE_SIZE, DOWNSAMPLED_SIZE);
  assertEquals(down.length, FEATURE_COUNT);
  for (const v of down) assertAlmostEquals(v, 128 / 255, 1e-9);
});

Deno.test("downsamplePixels rejects mismatched sizes", () => {
  const pixels = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE).fill(0);
  assertThrows(
    () => downsamplePixels(pixels, IMAGE_SIZE, 13),
    Error,
    "must be an integer multiple",
  );
});

Deno.test("buildDigitSamples produces one sample per (image, label) pair", () => {
  const { images, labels } = buildSyntheticIdx(2, 2);
  const samples = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
  assertEquals(samples.length, 2 * CLASS_COUNT);
  assertEquals(samples[0].label, 0);
  assertEquals(samples[0].features.length, FEATURE_COUNT);
  assertEquals(samples[0].pixels.length, IMAGE_SIZE * IMAGE_SIZE);
});

Deno.test("splitDataset slices contiguously and validates counts", () => {
  const { images, labels } = buildSyntheticIdx(3, 4);
  const samples = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
  const split = splitDataset(samples, { trainCount: 20, validationCount: 10, testCount: 10 });
  assertEquals(split.train.length, 20);
  assertEquals(split.validation.length, 10);
  assertEquals(split.test.length, 10);
  // No overlap, contiguous order preserved.
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

Deno.test("buildInitialCreatureJSON has expected counts and validates", () => {
  const W = Array.from({ length: 3 }, () => new Array(4).fill(0));
  const b = [0, 0, 0];
  const json = buildInitialCreatureJSON(W, b);
  assertEquals(json.input, 4);
  assertEquals(json.output, 3);
  assertEquals(json.synapses.length, 3 * 4);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
  const out = creature.activate(Float32Array.from([0, 0, 0, 0]));
  assertEquals(out.length, 3);
});

Deno.test("buildInitialCreatureJSON rejects mismatched bias count", () => {
  const W = [[0.1, 0.2]];
  assertThrows(() => buildInitialCreatureJSON(W, [0, 0]), Error, "biases length");
});

Deno.test("genesFromCreatureJSON round-trips weights and biases", () => {
  const W = [[0.1, 0.2, -0.3], [-0.4, 0.5, 0.6]];
  const b = [0.7, -0.8];
  const json = buildInitialCreatureJSON(W, b);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights, W);
  assertEquals(genes.biases, b);
});

Deno.test("mutateCreatureJSON preserves shape and still validates", () => {
  const W = Array.from({ length: 5 }, () => new Array(6).fill(0));
  const json = buildInitialCreatureJSON(W, new Array(5).fill(0));
  const random = createDeterministicRandom(7);
  const child = mutateCreatureJSON(json, random, 1.0, 0.2);
  assertEquals(child.input, 6);
  assertEquals(child.output, 5);
  Creature.fromJSON(asCreatureExport(child)).validate();
  // With mutationRate=1.0 the genes should change.
  const childGenes = genesFromCreatureJSON(child);
  let anyChanged = false;
  for (let c = 0; c < 5; c++) {
    for (let i = 0; i < 6; i++) {
      if (childGenes.weights[c][i] !== 0) anyChanged = true;
    }
  }
  assert(anyChanged, "mutation with rate=1.0 must perturb at least one gene");
});

Deno.test("classMeanFeatures averages per-class feature vectors", () => {
  const samples: DigitSample[] = [
    { index: 0, label: 0, features: [1, 0], pixels: [] },
    { index: 1, label: 0, features: [3, 0], pixels: [] },
    { index: 2, label: 1, features: [0, 2], pixels: [] },
  ];
  const means = classMeanFeatures(samples, 2, 2);
  assertEquals(means[0], [2, 0]);
  assertEquals(means[1], [0, 2]);
});

Deno.test("templateCreatureJSON produces a usable creature seeded from class means", () => {
  const samples: DigitSample[] = [
    { index: 0, label: 0, features: [1, 0, 0], pixels: [] },
    { index: 1, label: 1, features: [0, 1, 0], pixels: [] },
    { index: 2, label: 2, features: [0, 0, 1], pixels: [] },
  ];
  const random = createDeterministicRandom(11);
  const json = templateCreatureJSON(random, samples, 3, 3, 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
  // With noise=0 the prediction for sample[i] should be class i — the
  // template aligns each output's weights with that class's features.
  for (const s of samples) {
    assertEquals(predict(creature, s.features), s.label);
  }
});

Deno.test("templateCreatureJSON throws on empty samples", () => {
  const random = createDeterministicRandom(1);
  assertThrows(() => templateCreatureJSON(random, [], 4, 4, 0), Error, "must not be empty");
});

Deno.test("predict returns the argmax index", () => {
  // Force argmax to class 2 via a strongly biased single-input network.
  const W = [[-5], [-5], [5]];
  const json = buildInitialCreatureJSON(W, [0, 0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  assertEquals(predict(creature, [1]), 2);
});

Deno.test("classificationAccuracy returns the correct fraction", () => {
  const W = [[10, 0], [0, 10]];
  const json = buildInitialCreatureJSON(W, [0, 0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const samples: DigitSample[] = [
    { index: 0, label: 0, features: [1, 0], pixels: [] },
    { index: 1, label: 1, features: [0, 1], pixels: [] },
    { index: 2, label: 0, features: [0, 1], pixels: [] }, // wrong
  ];
  assertAlmostEquals(classificationAccuracy(creature, samples), 2 / 3, 1e-9);
});

Deno.test("classificationAccuracy returns 0 on an empty list", () => {
  const json = buildInitialCreatureJSON([[0, 0]], [0]);
  const creature = Creature.fromJSON(asCreatureExport(json));
  assertEquals(classificationAccuracy(creature, []), 0);
});

Deno.test("confusionMatrix is square and counts true vs predicted", () => {
  const W = [[10, 0], [0, 10]];
  const json = buildInitialCreatureJSON(W, [0, 0]);
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

Deno.test(
  "evolveClassifier — happy path: champion accuracy beats a documented floor on a synthetic fold",
  () => {
    const { images, labels } = buildSyntheticIdx(7, 4);
    const all = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
    const split = splitDataset(all, { trainCount: 20, validationCount: 10, testCount: 10 });
    const result = evolveClassifier(split, {
      seed: 12345,
      populationSize: 8,
      maxGenerations: 5,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      inputCount: FEATURE_COUNT,
      classCount: CLASS_COUNT,
      accuracyThreshold: 1.0, // disable early-stop
      initNoise: 0.005,
    });
    // Floor: comfortably beats 10% random baseline. The synthetic dataset
    // has a strong per-class signal, so the template warm-start alone
    // typically reaches 100% — anything above 0.5 demonstrates the
    // pipeline is wired up correctly.
    assertGreater(
      result.validationAccuracy,
      0.5,
      `validation accuracy should beat 0.5 floor, got ${result.validationAccuracy}`,
    );
    // Champion serialises and re-loads cleanly.
    const exportJson = result.champion.exportJSON();
    Creature.fromJSON(exportJson).validate();
  },
);

Deno.test("evolveClassifier — empty validation slice raises a clear error", () => {
  const samples: DigitSample[] = [
    { index: 0, label: 0, features: new Array(FEATURE_COUNT).fill(0.5), pixels: [] },
  ];
  assertThrows(
    () =>
      evolveClassifier(
        { train: samples, validation: [], test: [] },
        {
          seed: 1,
          populationSize: 2,
          maxGenerations: 1,
          mutationStrength: 0.1,
          mutationRate: 0.1,
          inputCount: FEATURE_COUNT,
          classCount: CLASS_COUNT,
          accuracyThreshold: 0.5,
          initNoise: 0.01,
        },
      ),
    Error,
    "validation set must not be empty",
  );
});

Deno.test("evolveClassifier — empty training slice raises a clear error", () => {
  const samples: DigitSample[] = [
    { index: 0, label: 0, features: new Array(FEATURE_COUNT).fill(0.5), pixels: [] },
  ];
  assertThrows(
    () =>
      evolveClassifier(
        { train: [], validation: samples, test: [] },
        {
          seed: 1,
          populationSize: 2,
          maxGenerations: 1,
          mutationStrength: 0.1,
          mutationRate: 0.1,
          inputCount: FEATURE_COUNT,
          classCount: CLASS_COUNT,
          accuracyThreshold: 0.5,
          initNoise: 0.01,
        },
      ),
    Error,
    "training set must not be empty",
  );
});

Deno.test(
  "evolveClassifier — reproducibility: two runs with the same seed produce byte-identical champions",
  () => {
    const { images, labels } = buildSyntheticIdx(11, 4);
    const all = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
    const opts = {
      seed: 9999,
      populationSize: 6,
      maxGenerations: 4,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      inputCount: FEATURE_COUNT,
      classCount: CLASS_COUNT,
      accuracyThreshold: 1.0,
      initNoise: 0.01,
    };
    const split1 = splitDataset(all, { trainCount: 20, validationCount: 10, testCount: 10 });
    const split2 = splitDataset(all, { trainCount: 20, validationCount: 10, testCount: 10 });
    const r1 = evolveClassifier(split1, opts);
    const r2 = evolveClassifier(split2, opts);
    const j1 = JSON.stringify(r1.champion.exportJSON());
    const j2 = JSON.stringify(r2.champion.exportJSON());
    assertEquals(j1, j2);
  },
);

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
  // First sweep should hit every class.
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
  const W = Array.from({ length: CLASS_COUNT }, () => new Array(FEATURE_COUNT).fill(0));
  const json = buildInitialCreatureJSON(W, new Array(CLASS_COUNT).fill(0));
  const creature = Creature.fromJSON(asCreatureExport(json));
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

Deno.test("renderDigitGridSVG emits an animated SVG with green/red labels", () => {
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
  // SMIL animation present (animation only emitted when frames > 1).
  assert(svg.match(/<animate /), "expected at least one <animate> element");
  // Both colour codes should appear: green for correct, red for wrong.
  assert(svg.includes("#2ecc71"));
  assert(svg.includes("#e74c3c"));
  // Caption mentions the metrics.
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

Deno.test("readGzippedFile rejects a missing file", async () => {
  await assertRejects(() => readGzippedFile("/no/such/path/data.gz"), Error);
});

Deno.test("readGzippedFile round-trips bytes via DecompressionStream", async () => {
  // Compress a tiny payload, write it to disk, then read it back.
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
