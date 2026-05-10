/**
 * "What" tests for the evolution_showcase example (audit issue #211).
 *
 * The full-length showcase calls `Creature.evolveDir` against the
 * deterministic binary `.bin` training set with `targetError` +
 * `timeoutMinutes: 5` stop conditions; that run is too slow for a unit
 * test. These tests exercise the same code path with a tiny population
 * and a generous `targetError` so each finishes well inside the
 * 120-second per-test budget. They verify the *observable* outputs —
 * telemetry rows are captured, the CSV schema matches the audit, charts
 * render — without inspecting how `evolveDir` produces those outputs.
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import {
  createTeacherCreature,
  DEFAULT_SHOWCASE_EVOLUTION_CONFIG,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  formatEvolutionCsv,
  INPUT_COUNT,
  OUTPUT_COUNT,
  prepareDataset,
  rowsToEvolutionSamples,
  rowsToFitnessSamples,
  runMinimalSeedShowcase,
  SYNTHETIC_CONFIG,
} from "./evolution_showcase.ts";
import {
  captureSnapshot,
  DEFAULT_CHECKPOINTS,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { renderFitnessChartSVG } from "../common/fitness_chart.ts";

/* ------------------------------------------------------------------ */
/*  Teacher creature                                                   */
/* ------------------------------------------------------------------ */

Deno.test("createTeacherCreature has the expected I/O width and is non-trivial", () => {
  const teacher = createTeacherCreature();
  assertEquals(teacher.input, INPUT_COUNT);
  assertEquals(teacher.output, OUTPUT_COUNT);
  // Teacher must contain at least one hidden neuron — that is the
  // whole point of the regression target being non-linear.
  const hasHidden = teacher.neurons.some((n) => n.type === "hidden");
  assert(hasHidden, "teacher should have at least one hidden neuron");
});

Deno.test("createTeacherCreature produces deterministic output for identical input", () => {
  const t1 = createTeacherCreature();
  const t2 = createTeacherCreature();
  const input = new Float32Array([0.5, -0.3, 0.7, 0.1]);
  t1.clearState();
  t2.clearState();
  const o1 = t1.activate(input);
  const o2 = t2.activate(input);
  assertEquals(o1[0], o2[0], "same input should yield same output");
});

/* ------------------------------------------------------------------ */
/*  prepareDataset                                                     */
/* ------------------------------------------------------------------ */

Deno.test("prepareDataset writes the synthetic .bin file and is idempotent", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_dataset_test_" });
  try {
    const dataDir = join(tmp, "data");
    ensureDirSync(dataDir);
    prepareDataset(dataDir);
    const file = join(dataDir, "synthetic_0000.bin");
    assert(existsSync(file), `expected ${file}`);
    const sizeBefore = Deno.statSync(file).size;
    // A second call must reuse the existing file.
    prepareDataset(dataDir);
    const sizeAfter = Deno.statSync(file).size;
    assertEquals(sizeAfter, sizeBefore, "second call should not regenerate the file");
    // Each record packs INPUT_COUNT inputs + OUTPUT_COUNT outputs of float32.
    const expected = SYNTHETIC_CONFIG.totalRecords * (INPUT_COUNT + OUTPUT_COUNT) * 4;
    assertEquals(sizeBefore, expected, "file size must match the synthetic config");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Stop-condition contract                                             */
/* ------------------------------------------------------------------ */

Deno.test("DEFAULT_SHOWCASE_EVOLUTION_CONFIG honours the audit's stop-condition rule", () => {
  // Issue #211 mandates targetError + timeoutMinutes <= 5 (or higher
  // with documented justification — the default sticks to 5).
  assertGreater(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.targetError,
    0,
    "targetError must be positive",
  );
  assertEquals(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.timeoutMinutes,
    5,
    "timeoutMinutes must default to the issue #211 backstop",
  );
  assertGreater(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.populationSize,
    0,
    "populationSize must be positive",
  );
  assertGreater(
    DEFAULT_SHOWCASE_EVOLUTION_CONFIG.maxIterations,
    0,
    "maxIterations must be positive",
  );
});

Deno.test("runMinimalSeedShowcase rejects non-positive config values", async () => {
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const dataDir = Deno.makeTempDirSync({ prefix: "showcase_invalid_test_" });
  try {
    let threw = false;
    try {
      await runMinimalSeedShowcase(seed, dataDir, {
        targetError: 0,
        timeoutMinutes: 1,
        populationSize: 4,
        maxIterations: 1,
        seed: 1,
      });
    } catch (err) {
      threw = true;
      assert(err instanceof Error);
    }
    assertEquals(threw, true, "zero targetError must throw");
  } finally {
    Deno.removeSync(dataDir, { recursive: true });
  }
});

/* ------------------------------------------------------------------ */
/*  formatEvolutionCsv                                                 */
/* ------------------------------------------------------------------ */

Deno.test("formatEvolutionCsv emits the schema mandated by issue #211", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: -0.5, meanFitness: -0.7, neuronCount: 5, synapseCount: 4 },
    { generation: 2, bestFitness: -0.3, meanFitness: -0.6, neuronCount: 6, synapseCount: 7 },
  ];
  const csv = formatEvolutionCsv(rows);
  const lines = csv.trim().split("\n");
  assertEquals(lines[0], EVOLUTION_CSV_HEADER, "first line must be the audit-mandated header");
  assertEquals(lines.length, 3, "header + 2 data rows");
  assertEquals(lines[1], "1,-0.5,-0.7,5,4");
  assertEquals(lines[2], "2,-0.3,-0.6,6,7");
});

Deno.test("formatEvolutionCsv survives non-finite fitness without throwing", () => {
  const rows: EvolutionRow[] = [
    {
      generation: 1,
      bestFitness: Number.POSITIVE_INFINITY,
      meanFitness: Number.NEGATIVE_INFINITY,
      neuronCount: 5,
      synapseCount: 4,
    },
  ];
  const csv = formatEvolutionCsv(rows);
  assertEquals(csv.trim().split("\n")[1], "1,0,0,5,4");
});

/* ------------------------------------------------------------------ */
/*  rowsToFitnessSamples / rowsToEvolutionSamples                      */
/* ------------------------------------------------------------------ */

Deno.test("rowsToFitnessSamples renames meanFitness to avgFitness", () => {
  const rows: EvolutionRow[] = [
    { generation: 3, bestFitness: -0.1, meanFitness: -0.4, neuronCount: 9, synapseCount: 12 },
  ];
  const samples = rowsToFitnessSamples(rows);
  assertEquals(samples.length, 1);
  assertEquals(samples[0].generation, 3);
  assertEquals(samples[0].bestFitness, -0.1);
  assertEquals(samples[0].avgFitness, -0.4);
});

Deno.test("rowsToEvolutionSamples maps neuron and synapse counts onto chart fields", () => {
  const rows: EvolutionRow[] = [
    { generation: 7, bestFitness: 0.2, meanFitness: 0.1, neuronCount: 11, synapseCount: 18 },
  ];
  const samples = rowsToEvolutionSamples(rows);
  assertEquals(samples.length, 1);
  assertEquals(samples[0].generation, 7);
  assertEquals(samples[0].score, 0.2);
  assertEquals(samples[0].neurons, 11);
  assertEquals(samples[0].synapses, 18);
});

/* ------------------------------------------------------------------ */
/*  runMinimalSeedShowcase end-to-end                                  */
/* ------------------------------------------------------------------ */

Deno.test(
  "runMinimalSeedShowcase captures per-generation telemetry from a minimal seed",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "showcase_run_test_" });
    try {
      const dataDir = join(tmp, "data");
      ensureDirSync(dataDir);
      prepareDataset(dataDir);

      const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      const seedNeurons = seed.neurons.length;
      const seedSynapses = seed.synapses.length;

      // A loose targetError keeps the run inside the unit-test budget
      // while still exercising the real evolveDir code path.
      const result = await runMinimalSeedShowcase(seed, dataDir, {
        targetError: 0.5,
        timeoutMinutes: 1,
        populationSize: 6,
        maxIterations: 10,
        seed: 211,
      });

      assertEquals(
        result.seedNeuronCount,
        seedNeurons,
        "seed neuron count must be recorded",
      );
      assertEquals(
        result.seedSynapseCount,
        seedSynapses,
        "seed synapse count must be recorded",
      );
      assertGreater(
        result.rows.length,
        0,
        "at least one generation_complete event must be captured",
      );
      const finalRow = result.rows[result.rows.length - 1];
      assertGreater(finalRow.generation, 0, "generation must be 1-based");
      assertGreater(finalRow.neuronCount, 0, "neuron count must be positive");
      assertGreater(finalRow.synapseCount, 0, "synapse count must be positive");
      assertEquals(
        Number.isFinite(finalRow.bestFitness),
        true,
        "bestFitness must be finite once evolution has progressed",
      );
      // The champion must be the same JS object the caller passed in —
      // evolveDir mutates the creature in place. This guards against a
      // future refactor accidentally breaking that contract.
      assertEquals(
        result.champion === seed,
        true,
        "champion must be the in-place creature",
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "runMinimalSeedShowcase captures snapshots at configured checkpoints",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "showcase_snap_test_" });
    try {
      const dataDir = join(tmp, "data");
      const snapDir = join(tmp, "snapshots");
      ensureDirSync(dataDir);
      ensureDirSync(snapDir);
      prepareDataset(dataDir);

      const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
      const snapshotConfig: SnapshotConfig = {
        // Cheap checkpoints so the test stays inside the unit-test budget.
        checkpoints: [1, 3, 6],
        outputDir: snapDir,
      };

      await runMinimalSeedShowcase(
        seed,
        dataDir,
        {
          targetError: 0.5,
          timeoutMinutes: 1,
          populationSize: 6,
          maxIterations: 8,
          seed: 211,
        },
        snapshotConfig,
      );

      // At least the gen-1 snapshot must have been written — later
      // checkpoints may or may not be hit depending on how the run
      // chunks, but the file existence and the ascending ordering are
      // observable contracts.
      assert(
        existsSync(join(snapDir, "snapshot-gen-1.json")),
        "expected snapshot-gen-1.json",
      );
      const snapshots = loadSnapshots(snapDir);
      assertGreater(snapshots.length, 0, "at least one snapshot must be loaded");
      for (let i = 1; i < snapshots.length; i++) {
        assertGreater(
          snapshots[i].generation,
          snapshots[i - 1].generation,
          "snapshots must be sorted by generation",
        );
      }
      // Snapshot generations must all be drawn from the configured list.
      for (const s of snapshots) {
        assert(
          snapshotConfig.checkpoints.includes(s.generation),
          `unexpected snapshot generation ${s.generation}`,
        );
      }
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test("captured snapshots can be rendered into a multi-panel SVG", () => {
  // Independent of evolveDir — verify the renderer accepts the snapshot
  // shape this example produces.
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_svg_test_" });
  try {
    const snapDir = join(tmp, "snapshots");
    ensureDirSync(snapDir);
    const config: SnapshotConfig = { checkpoints: [1, 5], outputDir: snapDir };
    const dummyCreature = new Creature(INPUT_COUNT, OUTPUT_COUNT).exportJSON();
    captureSnapshot(config, 1, dummyCreature, -1);
    captureSnapshot(config, 5, dummyCreature, -0.5);
    const snaps = loadSnapshots(snapDir);
    assertEquals(snaps.length, 2);
    const svg = renderEvolutionProgressSvg(snaps, { title: "Evolution Showcase (test)" });
    assert(svg.startsWith("<svg "), "SVG must start with an <svg> tag");
    assert(svg.endsWith("\n"), "SVG output should end with a newline");
    const panels = svg.match(/<g class="panel"/g) ?? [];
    assertEquals(panels.length, snaps.length);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("telemetry rows render into both audit-mandated chart helpers", () => {
  const rows: EvolutionRow[] = [
    { generation: 1, bestFitness: -0.5, meanFitness: -0.7, neuronCount: 5, synapseCount: 4 },
    { generation: 2, bestFitness: -0.3, meanFitness: -0.6, neuronCount: 6, synapseCount: 7 },
  ];
  const fitnessSvg = renderFitnessChartSVG(rowsToFitnessSamples(rows), {
    title: "Test Fitness",
  });
  const topologySvg = renderEvolutionChartSVG(rowsToEvolutionSamples(rows), {
    title: "Test Topology",
  });
  assert(fitnessSvg.startsWith("<svg "), "fitness SVG must start with <svg>");
  assert(topologySvg.startsWith("<svg "), "topology SVG must start with <svg>");
});

/* ------------------------------------------------------------------ */
/*  Default checkpoints exposed by the helper                          */
/* ------------------------------------------------------------------ */

Deno.test("DEFAULT_CHECKPOINTS still exposes the canonical checkpoint list", () => {
  // Documents the contract that the runner uses the canonical
  // `[1, 10, 100, 1000, 10000]` checkpoints when capturing snapshots.
  assertEquals([...DEFAULT_CHECKPOINTS], [1, 10, 100, 1000, 10000]);
});
