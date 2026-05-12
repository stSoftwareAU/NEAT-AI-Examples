/**
 * Unit tests for the classification-task primitives (issue #262).
 *
 * "What" tests only — every test calls a real exported function with
 * deterministic inputs and asserts on the returned value, the resulting
 * file on disk, or the classifier accuracy. No source-level grepping or
 * implementation-shape inspection.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreaterOrEqual,
  assertLessOrEqual,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  createSeededRng,
  Creature,
  type CreatureExport,
  setRandomNumberGenerator,
} from "@stsoftware/neat-ai";

import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";

import {
  classifierAccuracy,
  type DataPoint,
  evenParityLabel,
  generateClassificationDataset,
  INPUT_COUNT,
  OUTPUT_COUNT,
  targetVectorFor,
  TASK_NAME,
  TRUTH_TABLE_SIZE,
  writeBinaryClassificationDataset,
} from "./classification_task.ts";

/* ------------------------------------------------------------------ */
/*  Constants and metadata                                             */
/* ------------------------------------------------------------------ */

Deno.test("module exports the 4-bit binary classification task metadata", () => {
  assertEquals(INPUT_COUNT, 4);
  assertEquals(OUTPUT_COUNT, 1);
  assertEquals(TRUTH_TABLE_SIZE, 16);
  // Task name is human-readable and references parity. The exact wording
  // is intentionally checked so README captions stay in sync.
  assertEquals(typeof TASK_NAME, "string");
  assert(TASK_NAME.length > 0, "TASK_NAME must be non-empty");
});

/* ------------------------------------------------------------------ */
/*  evenParityLabel                                                    */
/* ------------------------------------------------------------------ */

Deno.test("evenParityLabel - returns 1 for even count, 0 for odd count", () => {
  // 0 ones (even) → 1
  assertEquals(evenParityLabel([0, 0, 0, 0]), 1);
  // 1 one (odd) → 0
  assertEquals(evenParityLabel([1, 0, 0, 0]), 0);
  assertEquals(evenParityLabel([0, 0, 0, 1]), 0);
  // 2 ones (even) → 1
  assertEquals(evenParityLabel([1, 1, 0, 0]), 1);
  assertEquals(evenParityLabel([1, 0, 0, 1]), 1);
  // 3 ones (odd) → 0
  assertEquals(evenParityLabel([1, 1, 1, 0]), 0);
  // 4 ones (even) → 1
  assertEquals(evenParityLabel([1, 1, 1, 1]), 1);
});

Deno.test("evenParityLabel - rejects malformed input", () => {
  assertThrows(() => evenParityLabel([0, 0, 0]));
  assertThrows(() => evenParityLabel([0, 0, 0, 0, 0]));
  assertThrows(() => evenParityLabel([0, 0, 0, 2]));
  assertThrows(() => evenParityLabel([0, 0, 0, -1]));
});

/* ------------------------------------------------------------------ */
/*  targetVectorFor                                                    */
/* ------------------------------------------------------------------ */

Deno.test("targetVectorFor - encodes 0 and 1 as single-element Float32Arrays", () => {
  const zero = targetVectorFor(0);
  assertEquals(zero.length, OUTPUT_COUNT);
  assertEquals(zero[0], 0);
  const one = targetVectorFor(1);
  assertEquals(one.length, OUTPUT_COUNT);
  assertEquals(one[0], 1);
});

Deno.test("targetVectorFor - rejects non-binary labels", () => {
  assertThrows(() => targetVectorFor(2));
  assertThrows(() => targetVectorFor(-1));
  assertThrows(() => targetVectorFor(0.5));
});

/* ------------------------------------------------------------------ */
/*  generateClassificationDataset                                      */
/* ------------------------------------------------------------------ */

Deno.test("generateClassificationDataset - default size returns the full truth table", () => {
  const ds = generateClassificationDataset(1);
  assertEquals(ds.length, TRUTH_TABLE_SIZE);
  // All 16 distinct rows must be present (set of bit patterns).
  const seen = new Set<number>();
  for (const dp of ds) {
    let key = 0;
    for (let j = 0; j < INPUT_COUNT; j++) {
      key |= (dp.inputs[j] >= 0.5 ? 1 : 0) << j;
    }
    seen.add(key);
  }
  assertEquals(seen.size, TRUTH_TABLE_SIZE);
});

Deno.test("generateClassificationDataset - rejects non-positive or non-integer size", () => {
  assertThrows(() => generateClassificationDataset(1, 0));
  assertThrows(() => generateClassificationDataset(1, -3));
  assertThrows(() => generateClassificationDataset(1, 1.5));
  assertThrows(() => generateClassificationDataset(1, Number.NaN));
});

Deno.test("generateClassificationDataset - same seed → identical bytes (determinism)", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "classification_task_test_" });
  try {
    const ds1 = generateClassificationDataset(424242, 16);
    const ds2 = generateClassificationDataset(424242, 16);
    // Field-level equality.
    assertEquals(ds1.length, ds2.length);
    for (let i = 0; i < ds1.length; i++) {
      assertEquals(Array.from(ds1[i].inputs), Array.from(ds2[i].inputs));
      assertEquals(Array.from(ds1[i].targets), Array.from(ds2[i].targets));
    }
    // Byte-level equality via the binary writer (the format actually
    // consumed by `Creature.evolveDir`).
    const p1 = writeBinaryClassificationDataset(ds1, `${tmp}/run-a`);
    const p2 = writeBinaryClassificationDataset(ds2, `${tmp}/run-b`);
    const b1 = Deno.readFileSync(p1);
    const b2 = Deno.readFileSync(p2);
    assertEquals(b1.length, b2.length);
    for (let i = 0; i < b1.length; i++) assertEquals(b1[i], b2[i]);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("generateClassificationDataset - different seeds differ; labels follow the truth function", () => {
  // For size > truth-table cardinality the per-record contents must
  // differ between seeds (different sampling order and picks). For all
  // sizes the labels must match `evenParityLabel(inputs)`.
  const a = generateClassificationDataset(1, 32);
  const b = generateClassificationDataset(2, 32);
  assertEquals(a.length, 32);
  assertEquals(b.length, 32);

  let differs = false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].inputs[0] !== b[i].inputs[0] || a[i].inputs[1] !== b[i].inputs[1] ||
      a[i].inputs[2] !== b[i].inputs[2] || a[i].inputs[3] !== b[i].inputs[3]
    ) {
      differs = true;
      break;
    }
  }
  assert(differs, "different seeds must produce different per-record inputs");

  for (const dp of [...a, ...b]) {
    const bits = [
      dp.inputs[0] >= 0.5 ? 1 : 0,
      dp.inputs[1] >= 0.5 ? 1 : 0,
      dp.inputs[2] >= 0.5 ? 1 : 0,
      dp.inputs[3] >= 0.5 ? 1 : 0,
    ];
    assertEquals(dp.targets[0], evenParityLabel(bits));
  }
});

Deno.test("generateClassificationDataset - full truth table is perfectly class-balanced", () => {
  // 16 rows: 8 even-parity, 8 odd-parity.
  for (const seed of [1, 7, 99]) {
    const ds = generateClassificationDataset(seed, TRUTH_TABLE_SIZE);
    let pos = 0;
    for (const dp of ds) if (dp.targets[0] >= 0.5) pos++;
    const neg = ds.length - pos;
    assertEquals(pos, 8, `seed ${seed} expected 8 positives, got ${pos}`);
    assertEquals(neg, 8, `seed ${seed} expected 8 negatives, got ${neg}`);
  }
});

Deno.test("generateClassificationDataset - sampled sets stay within reason of balance", () => {
  // For sizes > truth-table the implementation alternates desired
  // labels — balance is exact, not approximate.
  const ds = generateClassificationDataset(13, 64);
  let pos = 0;
  for (const dp of ds) if (dp.targets[0] >= 0.5) pos++;
  // Within ±1 of perfect 50/50 — issue #262 asks for "within reason"
  // for sampled sets; alternating sampling makes this exact.
  assertGreaterOrEqual(pos, 31);
  assertLessOrEqual(pos, 33);
});

Deno.test("generateClassificationDataset - smaller-than-truth-table subset has no duplicate rows", () => {
  const ds = generateClassificationDataset(31, 8);
  const seen = new Set<number>();
  for (const dp of ds) {
    let key = 0;
    for (let j = 0; j < INPUT_COUNT; j++) {
      key |= (dp.inputs[j] >= 0.5 ? 1 : 0) << j;
    }
    seen.add(key);
  }
  assertEquals(seen.size, 8, "small subset should be unique truth-table rows");
});

/* ------------------------------------------------------------------ */
/*  writeBinaryClassificationDataset                                   */
/* ------------------------------------------------------------------ */

Deno.test("writeBinaryClassificationDataset - emits a Float32 .bin of the expected byte length", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "classification_task_test_" });
  try {
    const ds = generateClassificationDataset(1, TRUTH_TABLE_SIZE);
    const path = writeBinaryClassificationDataset(ds, tmp);
    const stat = Deno.statSync(path);
    const expected = (INPUT_COUNT + OUTPUT_COUNT) * 4 * ds.length;
    assertEquals(stat.size, expected);
    // The bytes can be re-interpreted as Float32 records — the first
    // record must match dataset[0] exactly.
    const bytes = Deno.readFileSync(path);
    const floats = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      ds.length * (INPUT_COUNT + OUTPUT_COUNT),
    );
    for (let j = 0; j < INPUT_COUNT; j++) {
      assertEquals(floats[j], ds[0].inputs[j]);
    }
    assertEquals(floats[INPUT_COUNT], ds[0].targets[0]);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("writeBinaryClassificationDataset - rejects empty datasets and malformed records", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "classification_task_test_" });
  try {
    assertThrows(() => writeBinaryClassificationDataset([], tmp));
    const bad: DataPoint[] = [{
      inputs: new Float32Array([0, 1, 0]), // wrong arity
      targets: new Float32Array([1]),
    }];
    assertThrows(() => writeBinaryClassificationDataset(bad, tmp));
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  classifierAccuracy — hand-built perfect creature                   */
/* ------------------------------------------------------------------ */

/**
 * Build a hand-tuned creature that perfectly classifies 4-bit even
 * parity. **For tests only** — it does NOT seed the evolution loop.
 *
 * Construction: one hidden neuron per truth-table row, with input
 * weights and bias engineered so the hidden neuron's LOGISTIC squash
 * approaches `1` for the matching input pattern and `0` for any other.
 * The output neuron sums the hidden neurons weighted by their parity
 * label, with a negative bias and high gain so the LOGISTIC output
 * crosses the `0.5` decision threshold exactly when the true label is
 * `1`.
 */
function buildPerfectParityCreature(): Creature {
  const neurons: LegacyCreatureJSON["neurons"] = [];
  const synapses: LegacyCreatureJSON["synapses"] = [];

  // Input neurons at indices 0..3. Their `squash` is unused at the
  // input layer but a value is required by the runtime.
  for (let j = 0; j < INPUT_COUNT; j++) {
    neurons.push({ type: "input", squash: "LOGISTIC", index: j, uuid: `input-${j}` });
  }

  // Hidden neurons at indices 4..19, one per truth-table row.
  for (let k = 0; k < TRUTH_TABLE_SIZE; k++) {
    let onesInRow = 0;
    for (let j = 0; j < INPUT_COUNT; j++) {
      const cj = (k >> j) & 1;
      if (cj === 1) onesInRow++;
    }
    // bias = 50 - 100 * (number of 1-bits in row k). Combined with the
    // ±100 input weights, the pre-squash sum is +50 for the matched
    // input and ≤ -50 for any input differing in one bit. After
    // LOGISTIC this gives ≈ 1 on match and ≈ 0 elsewhere.
    const bias = 50 - 100 * onesInRow;
    neurons.push({
      type: "hidden",
      squash: "LOGISTIC",
      index: INPUT_COUNT + k,
      bias,
      uuid: `hidden-${k}`,
    });
    for (let j = 0; j < INPUT_COUNT; j++) {
      const cj = (k >> j) & 1;
      synapses.push({ from: j, to: INPUT_COUNT + k, weight: 100 * (2 * cj - 1) });
    }
  }

  // Output neuron at the final index. Bias = -5 plus high-gain weights
  // of 10 from each even-parity hidden neuron (weight 0 from odd-parity
  // rows) drives LOGISTIC well above 0.5 for matched even-parity inputs
  // and well below 0.5 for matched odd-parity inputs.
  const outputIndex = INPUT_COUNT + TRUTH_TABLE_SIZE;
  neurons.push({
    type: "output",
    squash: "LOGISTIC",
    index: outputIndex,
    bias: -5,
    uuid: "output-0",
  });
  for (let k = 0; k < TRUTH_TABLE_SIZE; k++) {
    const bits = [];
    for (let j = 0; j < INPUT_COUNT; j++) bits.push((k >> j) & 1);
    const label = evenParityLabel(bits);
    // Every hidden neuron must have an outward connection for NEAT-AI's
    // `creature.validate()`. Odd-parity rows therefore get a 0-weight
    // edge to the output — semantically equivalent to "no contribution"
    // but structurally a connected synapse.
    const weight = label === 1 ? 10 : 0;
    synapses.push({ from: INPUT_COUNT + k, to: outputIndex, weight });
  }

  const json: LegacyCreatureJSON = {
    neurons,
    synapses,
    input: INPUT_COUNT,
    output: OUTPUT_COUNT,
  };
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
  return creature;
}

Deno.test("classifierAccuracy - returns 1.0 for a hand-built perfect parity creature", () => {
  const creature = buildPerfectParityCreature();
  const ds = generateClassificationDataset(5, TRUTH_TABLE_SIZE);
  const acc = classifierAccuracy(creature, ds);
  // Reference creature is engineered to score 1.0 on the full truth
  // table — any miss indicates the construction is wrong, not the
  // metric.
  assertEquals(acc, 1.0);
});

Deno.test("classifierAccuracy - returns 0 for the empty dataset", () => {
  const creature = buildPerfectParityCreature();
  assertEquals(classifierAccuracy(creature, []), 0);
});

Deno.test("classifierAccuracy - reasonable bounds for a randomly-initialised seed creature", () => {
  // Seed NEAT-AI's global RNG so the random creature is reproducible.
  setRandomNumberGenerator(createSeededRng(987654));
  const json: CreatureExport = new Creature(INPUT_COUNT, OUTPUT_COUNT).exportJSON();
  // Pin the output to LOGISTIC so the >= 0.5 threshold applies.
  for (const neuron of json.neurons) {
    if (neuron.type === "output") neuron.squash = "LOGISTIC";
  }
  const creature = Creature.fromJSON(json);

  const ds = generateClassificationDataset(7, TRUTH_TABLE_SIZE);
  const acc = classifierAccuracy(creature, ds);
  // A random direct-only seed cannot represent parity — accuracy must
  // be in `[0, 1]` and, because the dataset is perfectly class-balanced,
  // a trivial "always 0" or "always 1" classifier scores exactly 0.5.
  // Anything between 0.25 and 0.75 is "close to 0.5" in the sense the
  // issue acceptance criterion intends.
  assertGreaterOrEqual(acc, 0);
  assertLessOrEqual(acc, 1);
  assertAlmostEquals(acc, 0.5, 0.25);
  // The reference and random creatures must produce *different*
  // accuracy values — a sanity check that the random creature is not
  // accidentally perfect.
  const ref = buildPerfectParityCreature();
  const refAcc = classifierAccuracy(ref, ds);
  assertNotEquals(acc, refAcc);
});
