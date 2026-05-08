/**
 * "What" tests for the evolution_showcase example.
 *
 * The full-length showcase evolves for 10000 generations and is too
 * slow to run inside a unit-test budget. These tests instead exercise
 * the same code path with a deliberately abbreviated checkpoint list
 * (`[1, 5, 10]`) and a tiny population so each test finishes well
 * under the 120 second per-test budget. They verify the observable
 * outputs — snapshot files exist, score is finite, the SVG can be
 * rendered from the captured snapshots — without inspecting how the
 * evolution loop produces those outputs.
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import {
  createSeedCreatureJSON,
  createTeacherCreature,
  DEFAULT_SHOWCASE_CONFIG,
  INPUT_COUNT,
  loadDataset,
  OUTPUT_COUNT,
  prepareDataset,
  runEvolutionShowcase,
  scoreOnDataset,
  type ShowcaseConfig,
  SYNTHETIC_CONFIG,
} from "./evolution_showcase.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { Creature } from "@stsoftware/neat-ai";
import { asCreatureExport } from "../common/legacy_types.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

/** Build a fast showcase config suitable for unit-test timescales. */
function makeFastConfig(outputDir: string): ShowcaseConfig {
  return {
    ...DEFAULT_SHOWCASE_CONFIG,
    generations: 10,
    populationSize: 6,
    checkpoints: [1, 5, 10],
    outputDir,
  };
}

Deno.test("createTeacherCreature has the expected I/O width and is non-trivial", () => {
  const teacher = createTeacherCreature();
  assertEquals(teacher.input, INPUT_COUNT);
  assertEquals(teacher.output, OUTPUT_COUNT);
  // Teacher must contain at least one hidden neuron — that is the
  // whole point of the regression target being non-linear.
  const hasHidden = teacher.neurons.some((n) => n.type === "hidden");
  assert(hasHidden, "teacher should have at least one hidden neuron");
});

Deno.test("createSeedCreatureJSON is a tiny baseline with no hidden capacity", () => {
  const random = createDeterministicRandom(42);
  const json = createSeedCreatureJSON(random);
  assertEquals(json.input, INPUT_COUNT);
  assertEquals(json.output, OUTPUT_COUNT);
  const hidden = json.neurons.filter((n) => n.type === "hidden").length;
  assertEquals(hidden, 0, "seed creature must start with zero hidden neurons");
  // Validate via Creature.fromJSON so we catch malformed topologies.
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("prepareDataset writes synthetic .bin files and round-trips via loadDataset", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_dataset_test_" });
  try {
    const dataDir = join(tmp, "data");
    Deno.mkdirSync(dataDir, { recursive: true });
    const dataset = prepareDataset(dataDir);
    assertEquals(dataset.length, SYNTHETIC_CONFIG.totalRecords);
    for (const sample of dataset) {
      assertEquals(sample.inputs.length, INPUT_COUNT);
      assertEquals(sample.targets.length, OUTPUT_COUNT);
      // Inputs were drawn from [-1, 1].
      for (const v of sample.inputs) {
        assert(v >= -1 && v <= 1, `input ${v} out of range`);
      }
    }
    // A second prepareDataset call should reuse the existing files.
    const reloaded = loadDataset(dataDir);
    assertEquals(reloaded.length, dataset.length);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("scoreOnDataset returns 0 for an empty dataset and finite values otherwise", () => {
  const teacher = createTeacherCreature();
  assertEquals(scoreOnDataset(teacher, []), 0);
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_score_test_" });
  try {
    const dataDir = join(tmp, "data");
    Deno.mkdirSync(dataDir, { recursive: true });
    const dataset = prepareDataset(dataDir);
    const score = scoreOnDataset(teacher, dataset);
    assert(Number.isFinite(score), `expected finite score, got ${score}`);
    // Teacher scores its own outputs near zero error.
    assert(score > -0.001, `teacher should near-perfectly fit its own data, got ${score}`);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test(
  "runEvolutionShowcase captures snapshots at every abbreviated checkpoint",
  () => {
    const tmp = Deno.makeTempDirSync({ prefix: "showcase_run_test_" });
    try {
      const dataDir = join(tmp, "data");
      const snapshotsDir = join(tmp, "snapshots");
      Deno.mkdirSync(dataDir, { recursive: true });
      const dataset = prepareDataset(dataDir);

      const config = makeFastConfig(snapshotsDir);
      const result = runEvolutionShowcase(config, dataset);

      assertEquals(result.generations, config.generations);
      assert(Number.isFinite(result.bestScore));
      assertEquals(result.outputDir, snapshotsDir);

      for (const gen of config.checkpoints) {
        const path = join(snapshotsDir, `snapshot-gen-${gen}.json`);
        assert(existsSync(path), `expected snapshot at ${path}`);
      }

      const snapshots = loadSnapshots(snapshotsDir);
      assertEquals(snapshots.length, config.checkpoints.length);
      assertEquals(snapshots.map((s) => s.generation), config.checkpoints);
      for (const snap of snapshots) {
        assert(Number.isFinite(snap.score), `snapshot ${snap.generation} score not finite`);
        assert(snap.creature !== null && typeof snap.creature === "object");
      }
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test("snapshots from a fast run can be rendered into a multi-panel SVG", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_svg_test_" });
  try {
    const dataDir = join(tmp, "data");
    const snapshotsDir = join(tmp, "snapshots");
    Deno.mkdirSync(dataDir, { recursive: true });
    const dataset = prepareDataset(dataDir);

    const config = makeFastConfig(snapshotsDir);
    runEvolutionShowcase(config, dataset);

    const snapshots = loadSnapshots(snapshotsDir);
    const svg = renderEvolutionProgressSvg(snapshots, {
      title: "Evolution Showcase (test)",
    });
    assert(svg.startsWith("<svg "), "SVG must start with an <svg> tag");
    assert(svg.endsWith("\n"), "SVG output should end with a newline");
    // One panel per snapshot.
    const panelMatches = svg.match(/<g class="panel"/g) ?? [];
    assertEquals(panelMatches.length, config.checkpoints.length);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("evolution improves the score from the seed to gen 10", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "showcase_progress_test_" });
  try {
    const dataDir = join(tmp, "data");
    const snapshotsDir = join(tmp, "snapshots");
    Deno.mkdirSync(dataDir, { recursive: true });
    const dataset = prepareDataset(dataDir);

    const config = makeFastConfig(snapshotsDir);
    runEvolutionShowcase(config, dataset);

    const snapshots = loadSnapshots(snapshotsDir);
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    assertGreater(
      last.score,
      first.score - 1e-9,
      `final score ${last.score} should be >= initial ${first.score}`,
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
