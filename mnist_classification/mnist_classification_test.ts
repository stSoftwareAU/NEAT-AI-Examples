/**
 * Unit tests for the MNIST classification example. "What" tests only —
 * each test calls a real function and asserts on observable outputs
 * (predictions, accuracy, file contents, SVG structure). Tests use a
 * synthetic fixture CSV so they never touch the network.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  accuracy,
  BIAS_COUNT,
  buildInitialCreatureJSON,
  confusionMatrix,
  downsample,
  evolveMnistClassifier,
  genesFromCreatureJSON,
  GRID_COLS,
  GRID_ROWS,
  INPUT_COUNT,
  INPUT_GRID,
  loadMnistDataset,
  type MnistSample,
  mutateCreatureJSON,
  OUTPUT_COUNT,
  parseMnistCsvLine,
  predictDigit,
  predictProbabilities,
  randomCreatureJSON,
  SAMPLES_PER_CELL,
  SOURCE_GRID,
  splitTrainValidation,
  WEIGHT_COUNT,
} from "./mnist_classification.ts";
import { pixelColour, renderMnistGridSVG } from "./svg.ts";

/* -------------------------------------------------------------------- */
/*  Synthetic fixture helpers                                            */
/* -------------------------------------------------------------------- */

/**
 * Build a 28×28 image of a single digit class. Each class lights up a
 * unique 4×4 block of pixels at full intensity, with light random
 * speckle elsewhere. The classes are linearly separable so a 196→10
 * fully-connected network can learn them quickly.
 */
function syntheticDigitPixels(label: number, noise: number, random: () => number): number[] {
  const pixels = new Array<number>(SOURCE_GRID * SOURCE_GRID).fill(0);
  // Class block lives at row=label*2, col=label*2, in a 4×4 region.
  const blockRow = (label * 2) % (SOURCE_GRID - 4);
  const blockCol = ((label * 3) + 4) % (SOURCE_GRID - 4);
  for (let r = blockRow; r < blockRow + 4; r++) {
    for (let c = blockCol; c < blockCol + 4; c++) {
      pixels[r * SOURCE_GRID + c] = 240;
    }
  }
  if (noise > 0) {
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = Math.max(0, Math.min(255, pixels[i] + Math.floor(random() * noise * 2 - noise)));
    }
  }
  return pixels;
}

function syntheticCsv(seed: number, perClass: number, noise: number): string {
  const random = createDeterministicRandom(seed);
  const rows: string[] = [];
  for (let cls = 0; cls < OUTPUT_COUNT; cls++) {
    for (let i = 0; i < perClass; i++) {
      const pixels = syntheticDigitPixels(cls, noise, random);
      rows.push([cls, ...pixels.map((p) => Math.round(p))].join(","));
    }
  }
  return rows.join("\n");
}

async function writeFixture(perClass: number, noise: number): Promise<string> {
  const tmp = await Deno.makeTempDir({ prefix: "mnist_test_" });
  const path = join(tmp, "fixture.csv");
  await Deno.writeTextFile(path, syntheticCsv(42, perClass, noise));
  return path;
}

/* -------------------------------------------------------------------- */
/*  Pixel + parsing primitives                                           */
/* -------------------------------------------------------------------- */

Deno.test("parseMnistCsvLine extracts label and 784 normalised pixels", () => {
  const fields = ["7", ...new Array(SOURCE_GRID * SOURCE_GRID).fill("128")];
  const { label, pixels } = parseMnistCsvLine(fields.join(","));
  assertEquals(label, 7);
  assertEquals(pixels.length, SOURCE_GRID * SOURCE_GRID);
  // 128 / 255 ≈ 0.5019
  assertGreater(pixels[0], 0.49);
  assertGreater(0.51, pixels[0]);
});

Deno.test("parseMnistCsvLine throws on a badly-shaped row", () => {
  let threw = false;
  try {
    parseMnistCsvLine("0,1,2,3");
  } catch {
    threw = true;
  }
  assert(threw, "expected an error for too-few fields");
});

Deno.test("downsample averages a 28×28 image into 14×14", () => {
  const pixels = new Float32Array(SOURCE_GRID * SOURCE_GRID).fill(0.5);
  const out = downsample(pixels, SOURCE_GRID, INPUT_GRID);
  assertEquals(out.length, INPUT_COUNT);
  // Every 2×2 average of 0.5s is still 0.5
  for (let i = 0; i < out.length; i++) {
    assertEquals(out[i], 0.5);
  }
});

Deno.test("downsample throws when target does not divide source", () => {
  const pixels = new Float32Array(SOURCE_GRID * SOURCE_GRID);
  let threw = false;
  try {
    downsample(pixels, SOURCE_GRID, 13);
  } catch {
    threw = true;
  }
  assert(threw);
});

/* -------------------------------------------------------------------- */
/*  Dataset loader                                                       */
/* -------------------------------------------------------------------- */

Deno.test("loadMnistDataset reads a fixture CSV and downsamples", async () => {
  const path = await writeFixture(2, 0);
  try {
    const samples = await loadMnistDataset(path, { maxRows: Number.POSITIVE_INFINITY });
    assertEquals(samples.length, OUTPUT_COUNT * 2);
    for (const s of samples) {
      assertEquals(s.pixels.length, INPUT_COUNT);
      assert(s.source && s.source.length === SOURCE_GRID * SOURCE_GRID);
      assertGreaterOrEqual(s.label, 0);
      assertGreaterOrEqual(9, s.label);
    }
  } finally {
    await Deno.remove(path);
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("loadMnistDataset throws a clear error for a missing file (edge case)", async () => {
  let threw = false;
  let message = "";
  try {
    await loadMnistDataset("/does/not/exist/never-ever.csv");
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  assert(threw, "expected an error for a missing file");
  assert(
    message.includes("loadMnistDataset"),
    `error message must reference loadMnistDataset, got "${message}"`,
  );
});

Deno.test("loadMnistDataset throws when the CSV has zero usable rows", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "mnist_empty_" });
  const path = join(tmp, "empty.csv");
  await Deno.writeTextFile(path, "\n\n   \n");
  try {
    let threw = false;
    try {
      await loadMnistDataset(path);
    } catch {
      threw = true;
    }
    assert(threw, "empty dataset path should raise an error");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/* -------------------------------------------------------------------- */
/*  Network construction                                                 */
/* -------------------------------------------------------------------- */

Deno.test("buildInitialCreatureJSON has 196 inputs and 10 outputs", () => {
  const weights = new Array(WEIGHT_COUNT).fill(0.01);
  const biases = new Array(BIAS_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, biases);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  assertEquals(json.synapses.length, WEIGHT_COUNT);
  const outputs = json.neurons.filter((n) => n.type === "output");
  assertEquals(outputs.length, OUTPUT_COUNT);
});

Deno.test("buildInitialCreatureJSON produces a valid creature", () => {
  const weights = new Array(WEIGHT_COUNT).fill(0.01);
  const biases = new Array(BIAS_COUNT).fill(0);
  const json = buildInitialCreatureJSON(weights, biases);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("buildInitialCreatureJSON throws on wrong-sized gene vectors", () => {
  let threw = false;
  try {
    buildInitialCreatureJSON([1, 2, 3], new Array(BIAS_COUNT).fill(0));
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("genesFromCreatureJSON round-trips weights and biases", () => {
  const weights = new Array(WEIGHT_COUNT).fill(0).map((_, i) => (i % 11) * 0.01 - 0.05);
  const biases = new Array(BIAS_COUNT).fill(0).map((_, i) => i * 0.1 - 0.5);
  const json = buildInitialCreatureJSON(weights, biases);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights, weights);
  assertEquals(genes.biases, biases);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const r1 = createDeterministicRandom(99);
  const r2 = createDeterministicRandom(99);
  assertEquals(randomCreatureJSON(r1), randomCreatureJSON(r2));
});

Deno.test("mutateCreatureJSON yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const parent = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0),
    new Array(BIAS_COUNT).fill(0),
  );
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  Creature.fromJSON(asCreatureExport(child)).validate();
});

/* -------------------------------------------------------------------- */
/*  Prediction + scoring                                                 */
/* -------------------------------------------------------------------- */

Deno.test("predictProbabilities returns a 10-vector of finite numbers", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const probs = predictProbabilities(creature, new Float32Array(INPUT_COUNT).fill(0.5));
  assertEquals(probs.length, OUTPUT_COUNT);
  for (const p of probs) {
    assert(Number.isFinite(p));
    assertGreaterOrEqual(p, 0);
    assertGreaterOrEqual(1, p);
  }
});

Deno.test("predictDigit returns a class in 0..9", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const digit = predictDigit(creature, new Float32Array(INPUT_COUNT).fill(0.5));
  assertGreaterOrEqual(digit, 0);
  assertGreaterOrEqual(9, digit);
});

Deno.test("accuracy is 0 when no samples are passed and otherwise in [0, 1]", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  assertEquals(accuracy(creature, []), 0);

  const samples: MnistSample[] = [];
  for (let i = 0; i < OUTPUT_COUNT; i++) {
    samples.push({
      label: i,
      pixels: new Float32Array(INPUT_COUNT).fill(i / 9),
    });
  }
  const a = accuracy(creature, samples);
  assertGreaterOrEqual(a, 0);
  assertGreaterOrEqual(1, a);
});

Deno.test("confusionMatrix is 10×10 and rows sum to per-class counts", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const samples: MnistSample[] = [];
  for (let i = 0; i < OUTPUT_COUNT; i++) {
    for (let k = 0; k < 3; k++) {
      samples.push({ label: i, pixels: new Float32Array(INPUT_COUNT).fill(i * 0.1 + k * 0.01) });
    }
  }
  const m = confusionMatrix(creature, samples);
  assertEquals(m.length, OUTPUT_COUNT);
  for (let i = 0; i < OUTPUT_COUNT; i++) {
    assertEquals(m[i].length, OUTPUT_COUNT);
    let total = 0;
    for (let j = 0; j < OUTPUT_COUNT; j++) total += m[i][j];
    assertEquals(total, 3);
  }
});

/* -------------------------------------------------------------------- */
/*  Evolution                                                            */
/* -------------------------------------------------------------------- */

Deno.test(
  "evolveMnistClassifier learns the synthetic fixture above the floor (happy path)",
  async () => {
    const path = await writeFixture(8, 6);
    try {
      const samples = await loadMnistDataset(path, { maxRows: Number.POSITIVE_INFINITY });
      const { train, validation } = splitTrainValidation(samples, 60, 20);
      const result = evolveMnistClassifier(train, validation, {
        seed: 2024,
        populationSize: 30,
        maxGenerations: 40,
        mutationStrength: 0.5,
        mutationRate: 0.15,
        accuracyThreshold: 0.9,
      });
      // Synthetic patterns are linearly separable, so 60% on a 20-sample
      // validation fold is a conservative floor — the actual run normally
      // hits 90%+ within ~10 generations.
      assertGreaterOrEqual(
        result.bestAccuracy,
        0.6,
        `expected bestAccuracy ≥ 0.6, got ${result.bestAccuracy}`,
      );

      // Champion serialises cleanly.
      const tmp = await Deno.makeTempDir({ prefix: "mnist_champ_" });
      try {
        const championPath = join(tmp, "champion.json");
        await safeWriteJson(championPath, result.champion.exportJSON());
        assertEquals(existsSync(championPath), true);
      } finally {
        await Deno.remove(tmp, { recursive: true });
      }
    } finally {
      await Deno.remove(path);
      await Deno.remove(join(path, "..")).catch(() => {});
    }
  },
);

Deno.test(
  "evolveMnistClassifier throws on an empty training set (edge case)",
  () => {
    let threw = false;
    try {
      evolveMnistClassifier([], [{ label: 0, pixels: new Float32Array(INPUT_COUNT) }]);
    } catch {
      threw = true;
    }
    assert(threw);

    threw = false;
    try {
      evolveMnistClassifier([{ label: 0, pixels: new Float32Array(INPUT_COUNT) }], []);
    } catch {
      threw = true;
    }
    assert(threw);
  },
);

Deno.test(
  "evolveMnistClassifier is reproducible for the same seed (byte-identical champion)",
  async () => {
    const path = await writeFixture(4, 3);
    try {
      const samples = await loadMnistDataset(path);
      const { train, validation } = splitTrainValidation(samples, 30, 8);
      const opts = {
        seed: 7777,
        populationSize: 20,
        maxGenerations: 6,
        mutationStrength: 0.4,
        mutationRate: 0.1,
        accuracyThreshold: 1.1, // unreachable so both runs run the full budget
      };
      const r1 = evolveMnistClassifier(train, validation, opts);
      const r2 = evolveMnistClassifier(train, validation, opts);
      assertEquals(
        JSON.stringify(r1.champion.exportJSON()),
        JSON.stringify(r2.champion.exportJSON()),
      );
      assertEquals(r1.bestAccuracy, r2.bestAccuracy);
    } finally {
      await Deno.remove(path);
      await Deno.remove(join(path, "..")).catch(() => {});
    }
  },
);

Deno.test("splitTrainValidation throws when folds exceed available samples", () => {
  let threw = false;
  try {
    splitTrainValidation(
      [{ label: 0, pixels: new Float32Array(INPUT_COUNT) }],
      2,
      2,
    );
  } catch {
    threw = true;
  }
  assert(threw);
});

/* -------------------------------------------------------------------- */
/*  SVG renderer                                                         */
/* -------------------------------------------------------------------- */

Deno.test("pixelColour clamps and produces a hex colour", () => {
  assertEquals(pixelColour(-10).startsWith("#"), true);
  assertEquals(pixelColour(0).length, 7);
  assertEquals(pixelColour(255).length, 7);
  assertEquals(pixelColour(999).length, 7);
  // Endpoints differ.
  assert(pixelColour(0) !== pixelColour(255));
});

Deno.test("renderMnistGridSVG produces a well-formed SVG with the expected number of cells", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const samples: MnistSample[] = [];
  for (let i = 0; i < GRID_COLS * GRID_ROWS * SAMPLES_PER_CELL; i++) {
    samples.push({
      label: i % OUTPUT_COUNT,
      pixels: new Float32Array(INPUT_COUNT).fill(0.3),
      source: new Float32Array(SOURCE_GRID * SOURCE_GRID).fill(0.4),
    });
  }
  const svg = renderMnistGridSVG(creature, samples, {
    cols: GRID_COLS,
    rows: GRID_ROWS,
    samplesPerCell: SAMPLES_PER_CELL,
    accuracy: 0.5,
  });
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  // One <g class="cell" ...> per grid cell.
  const cellMatches = svg.match(/<g class="cell"/g) ?? [];
  assertEquals(cellMatches.length, GRID_COLS * GRID_ROWS);
  // Each cell carries SAMPLES_PER_CELL <g class="layer" ...> children.
  const layerMatches = svg.match(/<g class="layer"/g) ?? [];
  assertEquals(layerMatches.length, GRID_COLS * GRID_ROWS * SAMPLES_PER_CELL);
});

Deno.test("renderMnistGridSVG embeds SMIL opacity animations and repeats indefinitely", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  const samples: MnistSample[] = [];
  for (let i = 0; i < 6; i++) {
    samples.push({
      label: i % OUTPUT_COUNT,
      pixels: new Float32Array(INPUT_COUNT).fill(0.3),
    });
  }
  const svg = renderMnistGridSVG(creature, samples, {
    cols: 2,
    rows: 1,
    samplesPerCell: 2,
    accuracy: 0.5,
  });
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Two cells × two layers = four animation tags minimum.
  assertGreaterOrEqual(animateMatches.length, 4);
  assert(svg.includes('repeatCount="indefinite"'));
  assert(svg.includes('attributeName="opacity"'));
});

Deno.test("renderMnistGridSVG throws on bad dimensions or empty samples", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  for (
    const opts of [
      { cols: 0, rows: 1, samplesPerCell: 1 },
      { cols: 1, rows: 0, samplesPerCell: 1 },
      { cols: 1, rows: 1, samplesPerCell: 0 },
    ]
  ) {
    let threw = false;
    try {
      renderMnistGridSVG(creature, [{ label: 0, pixels: new Float32Array(INPUT_COUNT) }], {
        ...opts,
        accuracy: 0.5,
      });
    } catch {
      threw = true;
    }
    assert(threw, `expected an error for opts ${JSON.stringify(opts)}`);
  }

  let threw = false;
  try {
    renderMnistGridSVG(creature, [], {
      cols: 1,
      rows: 1,
      samplesPerCell: 1,
      accuracy: 0,
    });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("renderMnistGridSVG green/red label tracks prediction correctness", () => {
  const json = buildInitialCreatureJSON(
    new Array(WEIGHT_COUNT).fill(0.01),
    new Array(BIAS_COUNT).fill(0),
  );
  const creature = Creature.fromJSON(asCreatureExport(json));
  // Predict the digit of a single sample and use it as the label →
  // marker should be green (#2ecc71). Then flip the label → red.
  const pixels = new Float32Array(INPUT_COUNT).fill(0.5);
  const predicted = predictDigit(creature, pixels);
  const wrongLabel = (predicted + 1) % OUTPUT_COUNT;

  const greenSvg = renderMnistGridSVG(creature, [{ label: predicted, pixels }], {
    cols: 1,
    rows: 1,
    samplesPerCell: 1,
    accuracy: 1,
  });
  assert(greenSvg.includes("#2ecc71"), "correct prediction must use the green marker");

  const redSvg = renderMnistGridSVG(creature, [{ label: wrongLabel, pixels }], {
    cols: 1,
    rows: 1,
    samplesPerCell: 1,
    accuracy: 0,
  });
  assert(redSvg.includes("#e74c3c"), "incorrect prediction must use the red marker");
});
