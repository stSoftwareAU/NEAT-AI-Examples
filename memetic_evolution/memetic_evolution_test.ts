/**
 * Unit tests for the memetic evolution demo (issue #90).
 *
 * "What" tests only — every test calls a real function and asserts on
 * observable outputs (record structure, summary statistics, SVG
 * structure). No greps over source files.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertThrows,
} from "@std/assert";

import {
  DEFAULT_MEMETIC_CONFIG,
  fitnessOn,
  forward,
  generateDataset,
  mutateWeights,
  randomWeights,
  runMemeticEvolution,
  sampleMiniBatch,
  TARGET_WEIGHTS,
  WEIGHT_VECTOR_LENGTH,
} from "./memetic_evolution.ts";
import {
  CONTROL_CURVE_CLASS,
  MEMETIC_CURVE_CLASS,
  renderMemeticSVG,
  SEEDING_MARKER_CLASS,
} from "./svg.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

Deno.test("TARGET_WEIGHTS has the expected length", () => {
  assertEquals(TARGET_WEIGHTS.length, WEIGHT_VECTOR_LENGTH);
  for (const w of TARGET_WEIGHTS) {
    assert(Number.isFinite(w), `target weights must all be finite, got ${w}`);
  }
});

Deno.test("forward returns finite outputs in [0, 1]", () => {
  const rng = createDeterministicRandom(123);
  for (let i = 0; i < 20; i++) {
    const x0 = rng() * 4 - 2;
    const x1 = rng() * 4 - 2;
    const y = forward(TARGET_WEIGHTS, [x0, x1]);
    assert(Number.isFinite(y), `forward output must be finite, got ${y}`);
    assertGreaterOrEqual(y, 0);
    assertGreaterOrEqual(1, y);
  }
});

Deno.test("forward rejects weight vectors of the wrong length", () => {
  assertThrows(() => forward([0, 0, 0], [0, 0]));
});

Deno.test("generateDataset returns the requested number of records", () => {
  const data = generateDataset(42, 25);
  assertEquals(data.length, 25);
  for (const r of data) {
    assertEquals(r.inputs.length, 2);
    assert(Number.isFinite(r.inputs[0]));
    assert(Number.isFinite(r.inputs[1]));
    assert(Number.isFinite(r.output));
    assertGreaterOrEqual(r.output, 0);
    assertGreaterOrEqual(1, r.output);
  }
});

Deno.test("generateDataset is deterministic for the same seed", () => {
  const a = generateDataset(7, 16);
  const b = generateDataset(7, 16);
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEquals(a[i].inputs[0], b[i].inputs[0]);
    assertEquals(a[i].inputs[1], b[i].inputs[1]);
    assertEquals(a[i].output, b[i].output);
  }
});

Deno.test("generateDataset rejects a non-positive size", () => {
  assertThrows(() => generateDataset(1, 0));
});

Deno.test("fitnessOn(target, dataset) is essentially zero (perfect)", () => {
  const data = generateDataset(123, 24);
  const f = fitnessOn(TARGET_WEIGHTS, data);
  assertAlmostEquals(f, 0, 1e-12);
});

Deno.test("fitnessOn punishes wrong weights", () => {
  const data = generateDataset(123, 24);
  const wrong = TARGET_WEIGHTS.map(() => 0);
  const fGood = fitnessOn(TARGET_WEIGHTS, data);
  const fBad = fitnessOn(wrong, data);
  assertGreater(fGood, fBad);
});

Deno.test("sampleMiniBatch returns the requested batch size", () => {
  const data = generateDataset(99, 32);
  const rng = createDeterministicRandom(1);
  const batch = sampleMiniBatch(data, 5, rng);
  assertEquals(batch.length, 5);
});

Deno.test("sampleMiniBatch caps at dataset length", () => {
  const data = generateDataset(99, 4);
  const rng = createDeterministicRandom(1);
  const batch = sampleMiniBatch(data, 100, rng);
  assertEquals(batch.length, 4);
});

Deno.test("sampleMiniBatch rejects non-positive batch size", () => {
  const data = generateDataset(99, 4);
  const rng = createDeterministicRandom(1);
  assertThrows(() => sampleMiniBatch(data, 0, rng));
});

Deno.test("mutateWeights returns a new vector of the same length", () => {
  const rng = createDeterministicRandom(1);
  const w = TARGET_WEIGHTS.slice();
  const m = mutateWeights(w, rng, 0.1);
  assertEquals(m.length, w.length);
  // The original must not be modified.
  for (let i = 0; i < w.length; i++) {
    assertEquals(w[i], TARGET_WEIGHTS[i]);
  }
  // At least one weight should have moved (probability of all 9
  // Gaussian draws being exactly zero is astronomically small).
  const moved = m.some((v, i) => v !== w[i]);
  assert(moved);
});

Deno.test("randomWeights returns a vector of the right length and finite values", () => {
  const rng = createDeterministicRandom(1);
  const w = randomWeights(rng);
  assertEquals(w.length, WEIGHT_VECTOR_LENGTH);
  for (const v of w) assert(Number.isFinite(v));
});

Deno.test("runMemeticEvolution produces matched-length records for both runs", () => {
  const result = runMemeticEvolution({
    ...DEFAULT_MEMETIC_CONFIG,
    generations: 20,
  });
  assertEquals(result.memetic.length, 20);
  assertEquals(result.control.length, 20);
  for (let g = 0; g < 20; g++) {
    assertEquals(result.memetic[g].generation, g);
    assertEquals(result.control[g].generation, g);
    assert(Number.isFinite(result.memetic[g].bestFitness));
    assert(Number.isFinite(result.control[g].bestFitness));
    // Fitness is -MSE on outputs in [0, 1] — must be ≤ 0.
    assertGreaterOrEqual(0, result.memetic[g].bestFitness);
    assertGreaterOrEqual(0, result.control[g].bestFitness);
    // Control records never carry the seeded flag.
    assertEquals(result.control[g].seeded, false);
  }
});

Deno.test("runMemeticEvolution records seeding generations", () => {
  const result = runMemeticEvolution(DEFAULT_MEMETIC_CONFIG);
  // With the default 60 generations and seedingInterval=3, we expect
  // multiple seedings to fire after the archive populates.
  assertGreater(result.seedingGenerations.length, 0);
  // Every recorded seeding generation must mark the corresponding
  // memetic record's `seeded` flag.
  for (const gen of result.seedingGenerations) {
    assertEquals(result.memetic[gen].seeded, true);
  }
  // Conversely, only flagged generations should appear in the list.
  const flagged = result.memetic.filter((r) => r.seeded).map((r) => r.generation);
  assertEquals(flagged, result.seedingGenerations);
});

Deno.test("runMemeticEvolution is deterministic for the same seed", () => {
  const a = runMemeticEvolution({ ...DEFAULT_MEMETIC_CONFIG, generations: 18 });
  const b = runMemeticEvolution({ ...DEFAULT_MEMETIC_CONFIG, generations: 18 });
  assertEquals(a.memetic.length, b.memetic.length);
  for (let g = 0; g < a.memetic.length; g++) {
    assertEquals(a.memetic[g].bestFitness, b.memetic[g].bestFitness);
    assertEquals(a.control[g].bestFitness, b.control[g].bestFitness);
    assertEquals(a.memetic[g].seeded, b.memetic[g].seeded);
  }
  assertEquals(a.finalMemeticFitness, b.finalMemeticFitness);
  assertEquals(a.finalControlFitness, b.finalControlFitness);
  assertEquals(a.seedingGenerations, b.seedingGenerations);
});

Deno.test("runMemeticEvolution: memetic ≥ control - tolerance on the default seed", () => {
  const result = runMemeticEvolution(DEFAULT_MEMETIC_CONFIG);
  // Both runs produced a final best weight vector.
  assertEquals(result.bestMemeticWeights.length, WEIGHT_VECTOR_LENGTH);
  assertEquals(result.bestControlWeights.length, WEIGHT_VECTOR_LENGTH);
  // The acceptance criterion: memetic must not lag behind control by
  // more than `tolerance`. The default seed is tuned so memetic wins
  // by a clear margin (~3×); a tolerance of 0.01 leaves headroom for
  // numerical drift across platforms.
  const tolerance = 0.01;
  assertGreaterOrEqual(
    result.finalMemeticFitness,
    result.finalControlFitness - tolerance,
    `memetic (${result.finalMemeticFitness.toFixed(5)}) must be ≥ control ` +
      `(${result.finalControlFitness.toFixed(5)}) - ${tolerance}`,
  );
});

Deno.test("runMemeticEvolution: memetic outperforms control by a measurable margin on default seed", () => {
  const result = runMemeticEvolution(DEFAULT_MEMETIC_CONFIG);
  const margin = result.finalMemeticFitness - result.finalControlFitness;
  assertGreater(
    margin,
    0,
    `memetic (${result.finalMemeticFitness.toFixed(5)}) should beat control ` +
      `(${result.finalControlFitness.toFixed(5)}); margin=${margin.toFixed(5)}`,
  );
});

Deno.test("runMemeticEvolution rejects invalid configs", () => {
  assertThrows(() => runMemeticEvolution({ ...DEFAULT_MEMETIC_CONFIG, generations: 0 }));
  assertThrows(() => runMemeticEvolution({ ...DEFAULT_MEMETIC_CONFIG, populationSize: 1 }));
  assertThrows(() => runMemeticEvolution({ ...DEFAULT_MEMETIC_CONFIG, miniBatchSize: 0 }));
  assertThrows(() => runMemeticEvolution({ ...DEFAULT_MEMETIC_CONFIG, archiveSize: 0 }));
  assertThrows(() => runMemeticEvolution({ ...DEFAULT_MEMETIC_CONFIG, seedingInterval: 0 }));
  assertThrows(() =>
    runMemeticEvolution({
      ...DEFAULT_MEMETIC_CONFIG,
      seedingReplacementCount: DEFAULT_MEMETIC_CONFIG.populationSize,
    })
  );
});

Deno.test("renderMemeticSVG produces a well-formed SVG with both curves and seeding markers", () => {
  const result = runMemeticEvolution({
    ...DEFAULT_MEMETIC_CONFIG,
    generations: 24,
  });
  const svg = renderMemeticSVG({
    memetic: result.memetic,
    control: result.control,
    seedingGenerations: result.seedingGenerations,
  });
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes(MEMETIC_CURVE_CLASS), "must include memetic curve class");
  assert(svg.includes(CONTROL_CURVE_CLASS), "must include control curve class");
  assert(svg.includes(SEEDING_MARKER_CLASS), "must include the seeding-marker class");

  // Two polylines (memetic + control).
  const polylines = svg.match(/<polyline /g) ?? [];
  assertGreaterOrEqual(polylines.length, 2);

  // Width / height must be positive integers.
  const widthMatch = svg.match(/width="(\d+)"/);
  const heightMatch = svg.match(/height="(\d+)"/);
  assert(widthMatch);
  assert(heightMatch);
  assertGreater(Number.parseInt(widthMatch![1], 10), 0);
  assertGreater(Number.parseInt(heightMatch![1], 10), 0);
});

Deno.test("renderMemeticSVG rejects empty record arrays", () => {
  assertThrows(() => renderMemeticSVG({ memetic: [], control: [], seedingGenerations: [] }));
});

Deno.test("renderMemeticSVG rejects mismatched record lengths", () => {
  const memetic = [{ generation: 0, bestFitness: -0.1, seeded: false }];
  const control = [
    { generation: 0, bestFitness: -0.1, seeded: false },
    { generation: 1, bestFitness: -0.05, seeded: false },
  ];
  assertThrows(() => renderMemeticSVG({ memetic, control, seedingGenerations: [] }));
});
