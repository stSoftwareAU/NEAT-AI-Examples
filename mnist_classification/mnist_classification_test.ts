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
  assertLess,
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
  buildGridCellsFromGenes,
  buildMLPCreatureJSON,
  buildRandomPopulation,
  classificationAccuracy,
  confusionMatrix,
  confusionMatrixGenes,
  DEFAULT_EVOLVE_OPTIONS,
  evolveClassifier,
  evolveMLPClassifier,
  mutateCreatureExport,
  pickGridSamples,
  predict,
  predictWithGenes,
} from "./mnist_classification.ts";
import { initMLPGenes } from "./gradient.ts";
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

Deno.test("buildRandomPopulation produces uniform-random NEAT genomes", () => {
  // Topology must NOT be hand-specified — the library decides shape.
  // We assert only that the population has the requested size and that
  // every member is a valid Creature with the right input/output counts
  // and LOGISTIC outputs.
  const pop = buildRandomPopulation(42, 5, FEATURE_COUNT, CLASS_COUNT);
  assertEquals(pop.length, 5);
  for (const json of pop) {
    assertEquals(json.input, FEATURE_COUNT);
    assertEquals(json.output, CLASS_COUNT);
    const creature = Creature.fromJSON(json);
    creature.validate();
    creature.clearState();
    const out = creature.activate(Float32Array.from(new Array(FEATURE_COUNT).fill(0.5)));
    assertEquals(out.length, CLASS_COUNT);
    for (const v of out) {
      assert(Number.isFinite(v), `expected finite output, got ${v}`);
    }
    // Every output neuron must be LOGISTIC — the only topology
    // constraint set by the example. Hidden neurons must NOT be
    // hand-specified at gen 1.
    const outputNeurons = json.neurons.filter((n) => n.type === "output");
    assertEquals(outputNeurons.length, CLASS_COUNT);
    for (const n of outputNeurons) {
      assertEquals(n.squash, "LOGISTIC");
    }
    const hiddenNeurons = json.neurons.filter((n) => n.type === "hidden");
    assertEquals(
      hiddenNeurons.length,
      0,
      "no hidden neurons should be hand-specified in the initial population",
    );
  }
});

Deno.test("buildRandomPopulation is deterministic for the same seed", () => {
  const a = buildRandomPopulation(99, 4, FEATURE_COUNT, CLASS_COUNT);
  const b = buildRandomPopulation(99, 4, FEATURE_COUNT, CLASS_COUNT);
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEquals(JSON.stringify(a[i]), JSON.stringify(b[i]));
  }
});

Deno.test("mutateCreatureExport yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const pop = buildRandomPopulation(1, 1, FEATURE_COUNT, CLASS_COUNT);
  const child = mutateCreatureExport(pop[0], random, 1.0, 0.3);
  Creature.fromJSON(child).validate();
});

Deno.test("mutateCreatureExport with addNeuronRate=1 grows topology", () => {
  // Forcing addNeuronRate=1 must split exactly one synapse, adding
  // one hidden neuron and replacing one synapse with two.
  const pop = buildRandomPopulation(3, 1, FEATURE_COUNT, CLASS_COUNT);
  const parent = pop[0];
  const random = createDeterministicRandom(13);
  const child = mutateCreatureExport(parent, random, 0, 0, {
    addNeuronRate: 1,
    hiddenCounter: { value: 0 },
  });
  const parentHidden = parent.neurons.filter((n) => n.type === "hidden").length;
  const childHidden = child.neurons.filter((n) => n.type === "hidden").length;
  assertEquals(childHidden - parentHidden, 1, "expected exactly one new hidden neuron");
  assertEquals(
    child.synapses.length - parent.synapses.length,
    1,
    "splitting one synapse adds one net synapse (-1 + 2)",
  );
  Creature.fromJSON(child).validate();
});

Deno.test("predict returns the argmax index", () => {
  // Hand-build a tiny LOGISTIC creature whose third output dominates.
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
  const pop = buildRandomPopulation(1, 1, FEATURE_COUNT, CLASS_COUNT);
  const creature = Creature.fromJSON(pop[0]);
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

Deno.test(
  "evolveClassifier — happy path: champion accuracy crosses a reduced threshold on a tiny fold",
  () => {
    // In-CI variant: a small `inputCount × classCount` problem with a
    // strong per-class signal so mutation-from-noise evolution can
    // converge inside a few hundred milliseconds. The headline
    // 95 %-on-real-MNIST run is the developer screenshot one-off and
    // is intentionally NOT exercised here.
    const inputCount = 8;
    const classCount = 3;
    const samplesPerClass = 12;
    const samples: DigitSample[] = [];
    let idx = 0;
    for (let pass = 0; pass < samplesPerClass; pass++) {
      for (let label = 0; label < classCount; label++) {
        const features = new Array<number>(inputCount).fill(0);
        // One-hot-ish signal: feature `label` and `label + classCount`
        // both fire for class `label`; the other features are zeros.
        features[label] = 1;
        features[label + classCount] = 1;
        samples.push({
          index: idx++,
          label,
          features,
          pixels: new Array(IMAGE_SIZE * IMAGE_SIZE).fill(0),
        });
      }
    }
    const trainCount = 24;
    const valCount = 6;
    const split = {
      train: samples.slice(0, trainCount),
      validation: samples.slice(trainCount, trainCount + valCount),
      test: samples.slice(trainCount + valCount),
    };
    const REDUCED_THRESHOLD = 0.6;
    const result = evolveClassifier(split, {
      seed: 12345,
      populationSize: 16,
      maxGenerations: 50,
      mutationStrength: 0.6,
      mutationRate: 0.3,
      addNeuronRate: 0,
      inputCount,
      classCount,
      accuracyThreshold: REDUCED_THRESHOLD,
    });
    assertGreaterOrEqual(
      result.validationAccuracy,
      REDUCED_THRESHOLD,
      `validation accuracy should reach the reduced ${
        (REDUCED_THRESHOLD * 100).toFixed(0)
      }% in-CI threshold, got ${result.validationAccuracy}`,
    );
    assertEquals(result.solved, true);
    Creature.fromJSON(result.champion.exportJSON()).validate();
  },
);

Deno.test(
  "evolveClassifier — gen-1 population is noise (mean accuracy near chance)",
  () => {
    // Generation 1 must be uniform-random noise: the population's mean
    // accuracy must sit near 1/CLASS_COUNT (10%), confirming no
    // warm-start is being applied. We use the canonical synthetic
    // signal-bearing dataset to keep the test fast.
    const { images, labels } = buildSyntheticIdx(13, 5);
    const all = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
    const split = splitDataset(all, { trainCount: 30, validationCount: 10, testCount: 10 });
    let firstGenMean = -Infinity;
    let firstGenBest = -Infinity;
    evolveClassifier(split, {
      seed: 24681,
      populationSize: 32,
      maxGenerations: 1,
      mutationStrength: 0.1,
      mutationRate: 0.1,
      addNeuronRate: 0,
      inputCount: FEATURE_COUNT,
      classCount: CLASS_COUNT,
      accuracyThreshold: 1.0,
      onGeneration: (info) => {
        if (info.generation === 0) {
          firstGenMean = info.meanAccuracy;
          firstGenBest = info.bestAccuracy;
        }
      },
    });
    // The mean across a 32-strong uniform-random NEAT population must
    // sit far below half-way between chance and a competent classifier.
    // A warm-started population would post a mean well above this bar.
    const chance = 1 / CLASS_COUNT;
    assertLess(
      firstGenMean,
      chance + 0.25,
      `expected gen-1 mean accuracy near chance (${chance}), got ${firstGenMean}`,
    );
    // Sanity: the best of a random population can occasionally beat
    // chance by luck, but it should be well below "solved" — we check
    // it is not absurdly high (≥ 80 %), proving no warm-start.
    assertLess(
      firstGenBest,
      0.8,
      `gen-1 best should not look pre-trained, got ${firstGenBest}`,
    );
  },
);

Deno.test(
  "evolveClassifier — honours the hard generation cap",
  () => {
    // With a vanishing mutation strength + zero structural mutation the
    // search cannot solve the task within the cap. The result must
    // therefore stop at the cap and report `solved=false`.
    const { images, labels } = buildSyntheticIdx(17, 3);
    const all = buildDigitSamples(parseIdxImages(images), parseIdxLabels(labels));
    const split = splitDataset(all, { trainCount: 18, validationCount: 6, testCount: 6 });
    const cap = 3;
    const result = evolveClassifier(split, {
      seed: 555,
      populationSize: 4,
      maxGenerations: cap,
      mutationStrength: 0.0001,
      mutationRate: 0.0001,
      addNeuronRate: 0,
      inputCount: FEATURE_COUNT,
      classCount: CLASS_COUNT,
      accuracyThreshold: 0.999,
    });
    assertEquals(
      result.generations,
      cap,
      `expected evolution to run to the hard cap of ${cap} generations, got ${result.generations}`,
    );
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not cross the threshold within the cap",
    );
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
          ...DEFAULT_EVOLVE_OPTIONS,
          populationSize: 2,
          maxGenerations: 1,
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
          ...DEFAULT_EVOLVE_OPTIONS,
          populationSize: 2,
          maxGenerations: 1,
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
      mutationStrength: 0.2,
      mutationRate: 0.2,
      addNeuronRate: 0,
      inputCount: FEATURE_COUNT,
      classCount: CLASS_COUNT,
      accuracyThreshold: 1.0,
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
  const pop = buildRandomPopulation(101, 1, FEATURE_COUNT, CLASS_COUNT);
  const creature = Creature.fromJSON(pop[0]);
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

Deno.test("buildMLPCreatureJSON — produces a creature that round-trips through Creature.fromJSON", () => {
  const random = createDeterministicRandom(101);
  const genes = initMLPGenes(random, 4, 3, 2);
  const json = buildMLPCreatureJSON(genes);
  assertEquals(json.input, 4);
  assertEquals(json.output, 2);
  // 4 inputs × 3 hidden + 3 hidden × 2 outputs = 18 synapses.
  assertEquals(json.synapses.length, 4 * 3 + 3 * 2);
  // 4 inputs + 3 hidden + 2 outputs = 9 neurons.
  assertEquals(json.neurons.length, 4 + 3 + 2);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
  const out = creature.activate(Float32Array.from([0.1, 0.2, 0.3, 0.4]));
  assertEquals(out.length, 2);
});

Deno.test("buildMLPCreatureJSON — rejects mismatched layer sizes", () => {
  // W2 row length must equal hiddenCount = W1.length.
  assertThrows(
    () =>
      buildMLPCreatureJSON({
        W1: [[0, 0]],
        b1: [0],
        W2: [[0, 0]],
        b2: [0],
      }),
    Error,
    "W2 row 0 has 2 weights",
  );
});

Deno.test(
  "evolveMLPClassifier — reaches high validation accuracy on a trivially separable synthetic split",
  () => {
    // Build a synthetic dataset where each class has a unique hot
    // feature — a simple MLP should master this in a handful of
    // epochs even with a tiny hidden layer.
    const samples: DigitSample[] = [];
    for (let i = 0; i < 300; i++) {
      const label = i % CLASS_COUNT;
      const features = new Array<number>(FEATURE_COUNT).fill(0);
      features[label] = 1;
      samples.push({
        index: i,
        label,
        features,
        pixels: new Array<number>(IMAGE_SIZE * IMAGE_SIZE).fill(0),
      });
    }
    const split = {
      train: samples.slice(0, 200),
      validation: samples.slice(200, 250),
      test: samples.slice(250, 300),
    };
    const result = evolveMLPClassifier(split, {
      seed: 13579,
      inputCount: FEATURE_COUNT,
      classCount: CLASS_COUNT,
      hiddenCount: 16,
      maxEpochs: 30,
      batchSize: 16,
      learningRate: 0.5,
      momentum: 0.9,
      accuracyThreshold: 0.99,
    });
    assertGreater(result.validationAccuracy, 0.9);
    // History captures one entry per executed epoch.
    assertEquals(result.history.length, result.epochs);
    // The lifted creature serialises and re-loads cleanly.
    Creature.fromJSON(result.champion.exportJSON()).validate();
  },
);

Deno.test("evolveMLPClassifier — empty validation slice raises a clear error", () => {
  const sample: DigitSample = {
    index: 0,
    label: 0,
    features: new Array<number>(FEATURE_COUNT).fill(0.5),
    pixels: [],
  };
  assertThrows(
    () =>
      evolveMLPClassifier(
        { train: [sample], validation: [], test: [] },
        {
          seed: 1,
          inputCount: FEATURE_COUNT,
          classCount: CLASS_COUNT,
          hiddenCount: 4,
          maxEpochs: 1,
          batchSize: 1,
          learningRate: 0.1,
          momentum: 0,
        },
      ),
    Error,
    "validation set must not be empty",
  );
});

Deno.test(
  "predictWithGenes / confusionMatrixGenes — agree with the lifted creature on a small set",
  () => {
    const random = createDeterministicRandom(71);
    const genes = initMLPGenes(random, FEATURE_COUNT, 8, CLASS_COUNT);
    const json = buildMLPCreatureJSON(genes);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const samples: DigitSample[] = [];
    for (let i = 0; i < 5; i++) {
      const features = new Array<number>(FEATURE_COUNT).fill(0).map((_, k) => (k % (i + 2)) / 10);
      samples.push({
        index: i,
        label: i % CLASS_COUNT,
        features,
        pixels: new Array<number>(IMAGE_SIZE * IMAGE_SIZE).fill(0),
      });
    }
    for (const s of samples) {
      assertEquals(predictWithGenes(genes, s.features), predict(creature, s.features));
    }
    const m1 = confusionMatrixGenes(genes, samples);
    const m2 = confusionMatrix(creature, samples);
    assertEquals(m1, m2);
  },
);

Deno.test("buildGridCellsFromGenes — emits well-formed cells matching the genome predictions", () => {
  const samples: DigitSample[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push({
      index: i,
      label: i % CLASS_COUNT,
      features: new Array<number>(FEATURE_COUNT).fill(0),
      pixels: new Array<number>(IMAGE_SIZE * IMAGE_SIZE).fill(0),
    });
  }
  const random = createDeterministicRandom(83);
  const genes = initMLPGenes(random, FEATURE_COUNT, 8, CLASS_COUNT);
  const cells = buildGridCellsFromGenes(genes, samples, 2);
  assertGreaterOrEqual(cells.length, 1);
  for (const cell of cells) {
    assert(cell.frames.length > 0);
    for (const frame of cell.frames) {
      assertEquals(frame.pixels.length, IMAGE_SIZE * IMAGE_SIZE);
      assert(frame.label >= 0 && frame.label < CLASS_COUNT);
      assert(frame.prediction >= 0 && frame.prediction < CLASS_COUNT);
    }
  }
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
