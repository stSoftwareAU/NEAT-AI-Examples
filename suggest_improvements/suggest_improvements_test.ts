/**
 * Unit tests for the suggest_improvements module.
 *
 * These are "what" tests — they verify that the analysis functions
 * produce correct results (outputs, structure) without checking
 * implementation details.
 */

import {
  assert,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  analyseProject,
  type AnalysisResult,
  creatureHeldOutScore,
  DEFAULT_MINIMAL_SEED_CONFIG,
  EVOLUTION_CSV_HEADER,
  formatEvolutionCsv,
  generateDataset,
  type Improvement,
  improvementToDataPoint,
  INPUT_COUNT,
  type MinimalSeedConfig,
  OUTPUT_COUNT,
  runMinimalSeedEvolution,
  writeBinaryDataset,
  writeImprovementsSummary,
} from "./suggest_improvements.ts";
import {
  FITNESS_CURVE_CLASS,
  MEAN_CURVE_CLASS,
  NEURON_CURVE_CLASS,
  renderFitnessChartSvg,
  renderTopologyChartSvg,
  SYNAPSE_CURVE_CLASS,
} from "./svg.ts";

/* ------------------------------------------------------------------ */
/*  analyseProject                                                     */
/* ------------------------------------------------------------------ */

Deno.test("analyseProject returns an AnalysisResult with improvements", () => {
  const result: AnalysisResult = analyseProject();

  assertGreater(
    result.improvements.length,
    0,
    "should find at least one improvement",
  );
});

Deno.test("analyseProject improvements have required fields", () => {
  const result: AnalysisResult = analyseProject();

  for (const improvement of result.improvements) {
    assertGreater(
      improvement.title.length,
      0,
      "title should not be empty",
    );
    assertGreater(
      improvement.description.length,
      0,
      "description should not be empty",
    );
    assertGreater(
      improvement.category.length,
      0,
      "category should not be empty",
    );
  }
});

Deno.test("analyseProject includes CI/CD improvement", () => {
  const result: AnalysisResult = analyseProject();

  const ciImprovement = result.improvements.find(
    (i) => i.category === "ci-cd",
  );
  assertEquals(
    ciImprovement !== undefined,
    true,
    "should include a CI/CD improvement suggestion",
  );
});

Deno.test("analyseProject includes linting improvement", () => {
  const result: AnalysisResult = analyseProject();

  const lintImprovement = result.improvements.find(
    (i) => i.category === "code-quality",
  );
  assertEquals(
    lintImprovement !== undefined,
    true,
    "should include a code quality improvement suggestion",
  );
});

Deno.test("analyseProject includes documentation improvement", () => {
  const result: AnalysisResult = analyseProject();

  const docImprovement = result.improvements.find(
    (i) => i.category === "documentation",
  );
  assertEquals(
    docImprovement !== undefined,
    true,
    "should include a documentation improvement suggestion",
  );
});

Deno.test("analyseProject includes new example improvement", () => {
  const result: AnalysisResult = analyseProject();

  const exampleImprovement = result.improvements.find(
    (i) => i.category === "new-example",
  );
  assertEquals(
    exampleImprovement !== undefined,
    true,
    "should include a new example improvement suggestion",
  );
});

Deno.test("analyseProject improvements have unique titles", () => {
  const result: AnalysisResult = analyseProject();

  const titles = result.improvements.map((i) => i.title);
  const uniqueTitles = new Set(titles);
  assertEquals(
    titles.length,
    uniqueTitles.size,
    "all improvement titles should be unique",
  );
});

Deno.test("analyseProject summary is non-empty", () => {
  const result: AnalysisResult = analyseProject();

  assertGreater(
    result.summary.length,
    0,
    "summary should not be empty",
  );
});

/* ------------------------------------------------------------------ */
/*  writeImprovementsSummary                                           */
/* ------------------------------------------------------------------ */

Deno.test("writeImprovementsSummary creates a markdown file", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "Test improvement",
        description: "A test improvement description.",
        category: "enhancement",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Test summary",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    assertEquals(existsSync(outputPath), true, "output file should exist");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeImprovementsSummary output contains improvement titles", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "Add CI/CD pipeline",
        description: "Automate quality checks.",
        category: "ci-cd",
      },
      {
        title: "Add linting configuration",
        description: "Enforce consistent code style.",
        category: "code-quality",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Found 2 improvements",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    const content = Deno.readTextFileSync(outputPath);
    assertEquals(
      content.includes("Add CI/CD pipeline"),
      true,
      "output should contain first improvement title",
    );
    assertEquals(
      content.includes("Add linting configuration"),
      true,
      "output should contain second improvement title",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeImprovementsSummary output contains summary", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "Test item",
        description: "Description here.",
        category: "enhancement",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Overall the project is well-structured.",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    const content = Deno.readTextFileSync(outputPath);
    assertEquals(
      content.includes("Overall the project is well-structured."),
      true,
      "output should contain the summary text",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeImprovementsSummary output is valid markdown with headings", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_suggest_test_" });

  try {
    const improvements: Improvement[] = [
      {
        title: "First item",
        description: "First description.",
        category: "ci-cd",
      },
    ];
    const result: AnalysisResult = {
      improvements,
      summary: "Summary text",
    };

    const outputPath = join(tmpDir, "improvements.md");
    writeImprovementsSummary(result, outputPath);

    const content = Deno.readTextFileSync(outputPath);
    assertEquals(
      content.includes("# "),
      true,
      "output should contain markdown headings",
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Audit #219 — minimal-seed evolveDir stage                          */
/* ------------------------------------------------------------------ */

/**
 * Small config used for the minimal-seed `evolveDir` tests — keeps each
 * test fast while still exercising the new code path. `timeoutMinutes:
 * 0` skips the FFI cleanup paths so the Deno test sanitiser stays
 * clean.
 */
const SMALL_MINIMAL_CONFIG: MinimalSeedConfig = {
  targetError: 0.0001,
  timeoutMinutes: 0,
  populationSize: 6,
  maxIterations: 3,
  seed: 219,
  mutationRate: 0.6,
  mutationAmount: 3,
};

Deno.test("DEFAULT_MINIMAL_SEED_CONFIG - has audit-policy stop conditions", () => {
  assertEquals(DEFAULT_MINIMAL_SEED_CONFIG.timeoutMinutes, 5);
  assertGreater(DEFAULT_MINIMAL_SEED_CONFIG.targetError, 0);
  assertGreaterOrEqual(0.1, DEFAULT_MINIMAL_SEED_CONFIG.targetError);
  assertGreater(DEFAULT_MINIMAL_SEED_CONFIG.populationSize, 1);
  assertGreater(DEFAULT_MINIMAL_SEED_CONFIG.maxIterations, 0);
});

Deno.test("INPUT_COUNT and OUTPUT_COUNT are 2 → 1", () => {
  // Two scalar features (description length, category bucket) → one
  // actionability score in [0, 1].
  assertEquals(INPUT_COUNT, 2);
  assertEquals(OUTPUT_COUNT, 1);
});

Deno.test("improvementToDataPoint maps an improvement to a finite (input, output) record", () => {
  const point = improvementToDataPoint({
    title: "Test",
    description: "x".repeat(120),
    category: "code-quality",
  });
  assertEquals(point.inputs.length, 2);
  assert(Number.isFinite(point.inputs[0]));
  assert(Number.isFinite(point.inputs[1]));
  assert(Number.isFinite(point.output));
  assertGreaterOrEqual(point.inputs[0], 0);
  assertGreaterOrEqual(1, point.inputs[0]);
  assertGreaterOrEqual(point.inputs[1], -1);
  assertGreaterOrEqual(1, point.inputs[1]);
  assertGreaterOrEqual(point.output, 0);
  assertGreaterOrEqual(1, point.output);
});

Deno.test("improvementToDataPoint is deterministic", () => {
  const sample: Improvement = {
    title: "Test",
    description: "a long description for the synthetic regressor",
    category: "ci-cd",
  };
  const a = improvementToDataPoint(sample);
  const b = improvementToDataPoint(sample);
  assertEquals(a.inputs[0], b.inputs[0]);
  assertEquals(a.inputs[1], b.inputs[1]);
  assertEquals(a.output, b.output);
});

Deno.test("generateDataset includes every improvement plus the requested synthetic extras", () => {
  const result = analyseProject();
  const ds = generateDataset(result.improvements, 1, 10);
  assertEquals(ds.length, result.improvements.length + 10);
  for (const r of ds) {
    assertEquals(r.inputs.length, 2);
    assert(Number.isFinite(r.inputs[0]));
    assert(Number.isFinite(r.inputs[1]));
    assert(Number.isFinite(r.output));
    assertGreaterOrEqual(r.output, 0);
    assertGreaterOrEqual(1, r.output);
  }
});

Deno.test("generateDataset is deterministic for the same seed", () => {
  const result = analyseProject();
  const a = generateDataset(result.improvements, 7, 12);
  const b = generateDataset(result.improvements, 7, 12);
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEquals(a[i].inputs[0], b[i].inputs[0]);
    assertEquals(a[i].inputs[1], b[i].inputs[1]);
    assertEquals(a[i].output, b[i].output);
  }
});

Deno.test("generateDataset rejects a negative extra size", () => {
  const result = analyseProject();
  assertThrows(() => generateDataset(result.improvements, 1, -1));
});

Deno.test("writeBinaryDataset - emits a Float32 .bin of the expected size", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "suggest_improvements_test_" });
  try {
    const result = analyseProject();
    const ds = generateDataset(result.improvements, 1, 4);
    const path = writeBinaryDataset(ds, tmp);
    const stat = await Deno.stat(path);
    const expectedBytes = ds.length * (INPUT_COUNT + OUTPUT_COUNT) * 4;
    assertEquals(stat.size, expectedBytes);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runMinimalSeedEvolution - rejects invalid configs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "suggest_improvements_test_" });
  try {
    const result = analyseProject();
    const ds = generateDataset(result.improvements, 1, 8);
    writeBinaryDataset(ds, tmp);
    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    await assertRejects(() =>
      runMinimalSeedEvolution(seed, tmp, { ...SMALL_MINIMAL_CONFIG, targetError: 0 })
    );
    await assertRejects(() =>
      runMinimalSeedEvolution(seed, tmp, { ...SMALL_MINIMAL_CONFIG, populationSize: 0 })
    );
    await assertRejects(() =>
      runMinimalSeedEvolution(seed, tmp, { ...SMALL_MINIMAL_CONFIG, maxIterations: 0 })
    );
    await assertRejects(() =>
      runMinimalSeedEvolution(seed, tmp, { ...SMALL_MINIMAL_CONFIG, timeoutMinutes: -1 })
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runMinimalSeedEvolution - seed is minimal and emits telemetry rows", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "suggest_improvements_test_" });
  try {
    const result = analyseProject();
    const ds = generateDataset(result.improvements, 1, 16);
    writeBinaryDataset(ds, tmp);

    // Build the minimal seed exactly like the runner — only INPUT_COUNT
    // and OUTPUT_COUNT are passed; no hidden hint, no warm start.
    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    // The minimal seed has no hidden neurons.
    assertEquals(seed.neurons.length, INPUT_COUNT + OUTPUT_COUNT);

    const evolveResult = await runMinimalSeedEvolution(seed, tmp, SMALL_MINIMAL_CONFIG);

    // Champion has the right I/O shape.
    assertEquals(evolveResult.champion.input, INPUT_COUNT);
    assertEquals(evolveResult.champion.output, OUTPUT_COUNT);

    // At least one telemetry row was captured.
    assertGreater(evolveResult.rows.length, 0);
    for (const row of evolveResult.rows) {
      assertGreaterOrEqual(row.generation, 0);
      assertGreaterOrEqual(row.neuronCount, INPUT_COUNT + OUTPUT_COUNT);
      assertGreaterOrEqual(row.synapseCount, 0);
      assert(Number.isFinite(row.bestFitness));
    }

    // Wall-clock and generation count are non-negative.
    assertGreaterOrEqual(evolveResult.wallClockMs, 0);
    assertGreaterOrEqual(evolveResult.generations, 0);
    assertEquals(evolveResult.seedNeuronCount, INPUT_COUNT + OUTPUT_COUNT);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("creatureHeldOutScore - returns finite non-positive value", () => {
  const result = analyseProject();
  const ds = generateDataset(result.improvements, 1, 4);
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const score = creatureHeldOutScore(creature, ds);
  assert(Number.isFinite(score));
  assertGreaterOrEqual(0, score);
});

Deno.test("creatureHeldOutScore - empty dataset returns 0", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  assertEquals(creatureHeldOutScore(creature, []), 0);
});

Deno.test("formatEvolutionCsv - emits canonical header and one row per generation", () => {
  const csv = formatEvolutionCsv([
    { generation: 1, bestFitness: 0.5, meanFitness: 0.4, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: 0.7, meanFitness: 0.6, neuronCount: 4, synapseCount: 5 },
  ]);
  const lines = csv.trim().split("\n");
  assertEquals(lines[0], EVOLUTION_CSV_HEADER);
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[1], "1,0.5,0.4,3,2");
  assertStringIncludes(lines[2], "2,0.7,0.6,4,5");
});

Deno.test("formatEvolutionCsv - handles non-finite numbers by writing 0", () => {
  const csv = formatEvolutionCsv([
    {
      generation: 1,
      bestFitness: Number.NaN,
      meanFitness: Number.POSITIVE_INFINITY,
      neuronCount: 3,
      synapseCount: 2,
    },
  ]);
  assertStringIncludes(csv, "1,0,0,3,2");
});

Deno.test("renderFitnessChartSvg - well-formed SVG with the fitness CSS classes", () => {
  const svg = renderFitnessChartSvg([
    { generation: 1, bestFitness: 0.5, meanFitness: 0.4, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: 0.7, meanFitness: 0.6, neuronCount: 4, synapseCount: 5 },
  ]);
  assert(svg.startsWith("<svg"));
  assert(svg.includes("</svg>"));
  assertStringIncludes(svg, FITNESS_CURVE_CLASS);
  assertStringIncludes(svg, MEAN_CURVE_CLASS);
});

Deno.test("renderFitnessChartSvg - rejects empty rows", () => {
  assertThrows(() => renderFitnessChartSvg([]), Error, "at least one row");
});

Deno.test("renderTopologyChartSvg - well-formed SVG with topology CSS classes", () => {
  const svg = renderTopologyChartSvg([
    { generation: 1, bestFitness: 0.5, meanFitness: 0.4, neuronCount: 3, synapseCount: 2 },
    { generation: 2, bestFitness: 0.7, meanFitness: 0.6, neuronCount: 4, synapseCount: 5 },
  ]);
  assert(svg.startsWith("<svg"));
  assertStringIncludes(svg, NEURON_CURVE_CLASS);
  assertStringIncludes(svg, SYNAPSE_CURVE_CLASS);
});

Deno.test("renderTopologyChartSvg - rejects empty rows", () => {
  assertThrows(() => renderTopologyChartSvg([]), Error, "at least one row");
});
