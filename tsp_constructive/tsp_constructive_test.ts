/**
 * Unit tests for the TSP-constructive entry point + milestone wiring.
 *
 * "What" tests only — drive the adapter and the multi-run helper with
 * tiny iteration caps and assert on outputs.
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";

import { Creature } from "@stsoftware/neat-ai";

import { loadMultiRunState, type MultiRunMilestone } from "../common/multi_run_state.ts";
import { loadInstance } from "../common/tsp_instances.ts";

import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { geoTourLength, isCompleteTour } from "./environment.ts";
import {
  evolveTspController,
  EXAMPLE_SLUG,
  milestoneToMultiRunSample,
  parseInstanceFlag,
  runMultiRunTsp,
  TspConstructiveAdapter,
} from "./tsp_constructive.ts";

Deno.test("parseInstanceFlag — defaults to burma14 when absent", () => {
  assertEquals(parseInstanceFlag([]), "burma14");
});

Deno.test("parseInstanceFlag — recognises burma14 and ulysses22", () => {
  assertEquals(parseInstanceFlag(["--instance=burma14"]), "burma14");
  assertEquals(parseInstanceFlag(["--instance=ulysses22"]), "ulysses22");
});

Deno.test("parseInstanceFlag — rejects unknown instances", () => {
  assertThrows(() => parseInstanceFlag(["--instance=foo"]));
});

Deno.test("TspConstructiveAdapter — reset returns observation with INPUT_COUNT channels", () => {
  const burma14 = loadInstance("burma14");
  const adapter = new TspConstructiveAdapter(burma14);
  const { observation, state } = adapter.reset(0);
  assertEquals(observation.length, INPUT_COUNT);
  assertEquals(state.tour, [0]);
  assertEquals(state.current, 0);
  assert(state.visited[0]);
});

Deno.test(
  "TspConstructiveAdapter — full episode against a real Creature visits every city once",
  () => {
    const burma14 = loadInstance("burma14");
    const adapter = new TspConstructiveAdapter(burma14);
    const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    let { observation, state } = adapter.reset(0);
    const cap = adapter.maxSteps();
    let steps = 0;
    while (steps < cap) {
      const out = creature.activate(observation) as Float32Array;
      const action = adapter.decodeAction(out, state);
      const result = adapter.step(state, action);
      state = result.state;
      observation = result.observation;
      steps++;
      if (result.terminated) break;
    }
    assert(isCompleteTour(state.tour, burma14.cities.length));
    assertEquals(state.tour[0], 0);
  },
);

Deno.test(
  "evolveTspController — completes a short run on burma14 from random noise",
  async () => {
    const result = await evolveTspController({
      seed: 42,
      populationSize: 12,
      // Loose target combined with an iterations cap — both "target"
      // and "iterations" stopReasons are acceptable; what matters is
      // that the run completes with a valid champion tour.
      targetError: 0.001,
      timeoutMinutes: 1,
      iterations: 2,
      instanceName: "burma14",
    });
    assert(
      result.stopReason === "target" || result.stopReason === "iterations",
      `expected target or iterations stop, got ${result.stopReason}`,
    );
    assert(result.generations >= 1, `expected at least one generation, got ${result.generations}`);
    assertEquals(result.championTour.length, 14);
    assert(isCompleteTour(result.championTour, 14));
    // Champion tour length must round-trip through the GEO helper.
    const recomputed = geoTourLength(loadInstance("burma14").cities, result.championTour);
    assertAlmostEquals(result.championLength, recomputed, 1e-6);
    // At least one milestone must have been captured.
    assert(result.milestones.length > 0, "expected at least one milestone");
  },
);

Deno.test(
  "milestoneToMultiRunSample — error mapping is `-bestScore` clamped to [0, 1]",
  () => {
    const sample = milestoneToMultiRunSample({
      generation: 5,
      bestScore: -0.42,
      bestNeurons: 3,
      bestSynapses: 7,
      meanEpisodeSteps: 13,
      generationWallClockMs: 12,
    });
    assertAlmostEquals(sample.error, 0.42, 1e-6);
    assertEquals(sample.runGen, 5);
    assertEquals(sample.neurons, 3);
    assertEquals(sample.synapses, 7);

    // bestScore = 0 → error 0.
    const zero = milestoneToMultiRunSample({
      generation: 1,
      bestScore: 0,
      bestNeurons: 1,
      bestSynapses: 1,
      meanEpisodeSteps: 1,
      generationWallClockMs: 1,
    });
    assertEquals(zero.error, 0);

    // bestScore = -2 (out of range) → clamped to 1.
    const clamped = milestoneToMultiRunSample({
      generation: 1,
      bestScore: -2,
      bestNeurons: 1,
      bestSynapses: 1,
      meanEpisodeSteps: 1,
      generationWallClockMs: 1,
    });
    assertEquals(clamped.error, 1);
  },
);

Deno.test(
  "public exports — dead MILESTONES_SVG_PATH is gone, used siblings remain",
  async () => {
    const mod = await import("./tsp_constructive.ts") as Record<string, unknown>;
    // The dead constant (issue #628) must not be re-introduced.
    assertEquals("MILESTONES_SVG_PATH" in mod, false);
    // The genuinely-used sibling artefact constants stay exported.
    assertEquals(mod.EXAMPLE_SLUG, "tsp_constructive");
    assertEquals(typeof mod.SCREENSHOT_PATH, "string");
  },
);

Deno.test(
  "runMultiRunTsp — persists champion + milestones and writes milestone SVG",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tsp_constructive_test_" });
    try {
      const result = await runMultiRunTsp({
        argv: ["--fresh", "--instance=burma14"],
        baseDir: tmp,
        evolveOverrides: {
          seed: 7,
          populationSize: 8,
          targetError: -1,
          timeoutMinutes: 1,
          iterations: 1,
        },
      });
      assertEquals(result.instanceName, "burma14");
      assertEquals(result.runIndex, 1);
      assert(result.totalMilestones > 0);

      const slug = `${EXAMPLE_SLUG}_burma14`;
      const state = await loadMultiRunState(slug, tmp);
      assert(state.creatureExport !== undefined);
      assertEquals(state.milestones.length, result.totalMilestones);
      // First sample must be stamped with runIndex 1.
      assertEquals(
        state.milestones.every((m: MultiRunMilestone) => m.runIndex === 1),
        true,
      );

      // Milestone SVG was written.
      const svgPath = `${tmp}/screenshots/${slug}/milestones.svg`;
      const stat = await Deno.stat(svgPath);
      assert(stat.isFile);
      assert(stat.size > 0);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
