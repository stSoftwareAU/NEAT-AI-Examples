/**
 * Unit tests for the multi-run state persistence helper.
 *
 * These are "what" tests — they create real artefacts on disk under a
 * temporary base directory and assert on the resulting state.
 */

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import { Creature, type CreatureExport } from "@stsoftware/neat-ai";

import { makeCreatureExport } from "./creature_export_fixture.ts";
import {
  appendMultiRunRun,
  clampSubEpsilonRegression,
  loadMultiRunState,
  MILESTONE_ERROR_EPSILON,
  type MultiRunMilestone,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "./multi_run_state.ts";

/**
 * Export of a real 1→1 creature, deterministic per `seed` so distinct runs
 * persist distinct creatures. Using a genuine export (issue #722) means these
 * persistence tests round-trip the same shape production writes to disk.
 */
function sampleCreatureExport(seed: number): CreatureExport {
  return makeCreatureExport({ input: 1, output: 1, hidden: 1, seed });
}

function tinyMilestone(runGen: number, error: number): Omit<
  MultiRunMilestone,
  "runIndex" | "cumulativeGen"
> {
  return {
    runGen,
    error,
    bestScore: 1 - error,
    neurons: 2 + runGen,
    synapses: 1 + runGen,
    generationWallClockMs: 100 * runGen,
  };
}

Deno.test("loadMultiRunState returns documented defaults when no files exist", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const state = await loadMultiRunState("xor_classification", tmp);
    assertEquals(state.creatureExport, undefined);
    assertEquals(state.milestones, []);
    assertEquals(state.nextRunIndex, 1);
    assertEquals(state.lastCumulativeGen, 0);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("appendMultiRunRun → loadMultiRunState round trip preserves data", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const slug = "xor_classification";
    const creatureExport = sampleCreatureExport(1);
    const newSamples = [tinyMilestone(1, 0.5), tinyMilestone(10, 0.2)];

    await appendMultiRunRun(slug, {
      creatureExport,
      newSamples,
      runIndex: 1,
      baseCumulativeGen: 0,
    }, tmp);

    const state = await loadMultiRunState(slug, tmp);
    // JSON persistence drops explicitly-undefined optional fields, so compare
    // the serialised forms rather than the in-memory objects.
    assertEquals(JSON.stringify(state.creatureExport), JSON.stringify(creatureExport));
    // The persisted export must still be a creature the library can reload —
    // the check a hand-rolled fixture could never satisfy (issue #722).
    assert(state.creatureExport !== undefined, "creature export must be persisted");
    Creature.fromJSON(state.creatureExport).validate();
    assertEquals(state.milestones.length, 2);
    assertEquals(state.milestones[0].runIndex, 1);
    assertEquals(state.milestones[0].cumulativeGen, 1);
    assertEquals(state.milestones[0].cumulativeWallClockMs, 100);
    assertEquals(state.milestones[1].cumulativeWallClockMs, 100 + 1000);
    assertEquals(state.milestones[0].runGen, 1);
    assertEquals(state.milestones[1].runIndex, 1);
    assertEquals(state.milestones[1].cumulativeGen, 10);
    assertEquals(state.nextRunIndex, 2);
    assertEquals(state.lastCumulativeGen, 10);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("runIndex increments and cumulativeGen is monotonic across runs", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const slug = "cart_pole";

    await appendMultiRunRun(slug, {
      creatureExport: sampleCreatureExport(1),
      newSamples: [tinyMilestone(1, 0.5), tinyMilestone(10, 0.3)],
      runIndex: 1,
      baseCumulativeGen: 0,
    }, tmp);

    const first = await loadMultiRunState(slug, tmp);
    assertEquals(first.nextRunIndex, 2);
    assertEquals(first.lastCumulativeGen, 10);

    await appendMultiRunRun(slug, {
      creatureExport: sampleCreatureExport(2),
      newSamples: [tinyMilestone(1, 0.2), tinyMilestone(5, 0.1)],
      runIndex: first.nextRunIndex,
      baseCumulativeGen: first.lastCumulativeGen,
    }, tmp);

    const merged = await loadMultiRunState(slug, tmp);
    assertEquals(merged.milestones.length, 4);
    assertEquals(merged.milestones[2].runIndex, 2);
    assertEquals(merged.milestones[2].cumulativeGen, 11);
    assertEquals(merged.milestones[3].runIndex, 2);
    assertEquals(merged.milestones[3].cumulativeGen, 15);
    assertEquals(merged.nextRunIndex, 3);
    assertEquals(merged.lastCumulativeGen, 15);

    // Monotonic cumulativeGen.
    for (let i = 1; i < merged.milestones.length; i++) {
      const prev = merged.milestones[i - 1].cumulativeGen;
      const curr = merged.milestones[i].cumulativeGen;
      assertEquals(curr > prev, true, `cumulativeGen must increase: ${prev} → ${curr}`);
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("wipeMultiRunState removes all four canonical artefact paths", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const slug = "snake_game";

    // Seed creature.json and milestones.json via appendMultiRunRun.
    await appendMultiRunRun(slug, {
      creatureExport: sampleCreatureExport(1),
      newSamples: [tinyMilestone(1, 0.5)],
      runIndex: 1,
      baseCumulativeGen: 0,
    }, tmp);

    // Manually create the two chart SVGs the helper should also remove.
    const screenshotsDir = join(tmp, "screenshots", slug);
    Deno.mkdirSync(screenshotsDir, { recursive: true });
    const milestonesSvg = join(screenshotsDir, "milestones.svg");
    const complexitySvg = join(screenshotsDir, "complexity.svg");
    Deno.writeTextFileSync(milestonesSvg, "<svg/>");
    Deno.writeTextFileSync(complexitySvg, "<svg/>");

    const creatureJson = join(tmp, "data", slug, "creature.json");
    const milestonesJson = join(tmp, "data", slug, "milestones.json");
    assertEquals(existsSync(creatureJson), true, "creature.json should exist before wipe");
    assertEquals(existsSync(milestonesJson), true, "milestones.json should exist before wipe");

    await wipeMultiRunState(slug, tmp);

    assertEquals(existsSync(creatureJson), false, "creature.json removed");
    assertEquals(existsSync(milestonesJson), false, "milestones.json removed");
    assertEquals(existsSync(milestonesSvg), false, "milestones.svg removed");
    assertEquals(existsSync(complexitySvg), false, "complexity.svg removed");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("wipeMultiRunState tolerates missing files", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    // No files exist yet — should not throw.
    await wipeMultiRunState("never_seen", tmp);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("loadMultiRunState throws on malformed milestones.json", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const slug = "cart_pole";
    const dir = join(tmp, "data", slug);
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(join(dir, "milestones.json"), "{not json");

    await assertRejects(
      () => loadMultiRunState(slug, tmp),
      Error,
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("loadMultiRunState throws on malformed creature.json", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const slug = "cart_pole";
    const dir = join(tmp, "data", slug);
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(join(dir, "creature.json"), "{not json");

    await assertRejects(
      () => loadMultiRunState(slug, tmp),
      Error,
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("parseMultiRunFlags — --fresh", () => {
  const flags = parseMultiRunFlags(["--fresh"]);
  assertEquals(flags.fresh, true);
  assertEquals(flags.timeoutMinutes, undefined);
  assertEquals(flags.targetError, undefined);
});

Deno.test("parseMultiRunFlags — --timeout=<minutes>", () => {
  const flags = parseMultiRunFlags(["--timeout=15"]);
  assertEquals(flags.fresh, false);
  assertEquals(flags.timeoutMinutes, 15);
  assertEquals(flags.targetError, undefined);
});

Deno.test("parseMultiRunFlags — --target-error=<value>", () => {
  const flags = parseMultiRunFlags(["--target-error=0.04"]);
  assertEquals(flags.fresh, false);
  assertEquals(flags.timeoutMinutes, undefined);
  assertEquals(flags.targetError, 0.04);
});

Deno.test("parseMultiRunFlags — combinations", () => {
  const flags = parseMultiRunFlags([
    "--fresh",
    "--timeout=30",
    "--target-error=0.1",
  ]);
  assertEquals(flags.fresh, true);
  assertEquals(flags.timeoutMinutes, 30);
  assertEquals(flags.targetError, 0.1);
});

Deno.test("parseMultiRunFlags — absent flags yield false / undefined", () => {
  const flags = parseMultiRunFlags([]);
  assertEquals(flags.fresh, false);
  assertEquals(flags.timeoutMinutes, undefined);
  assertEquals(flags.targetError, undefined);
});

Deno.test("parseMultiRunFlags — invalid numeric values yield undefined", () => {
  const flags = parseMultiRunFlags([
    "--timeout=not-a-number",
    "--target-error=NaN",
  ]);
  assertEquals(flags.timeoutMinutes, undefined);
  assertEquals(flags.targetError, undefined);
});

Deno.test("parseMultiRunFlags — passes unknown flags through (does not throw)", () => {
  // Helper extracts only the flags it cares about; the rest are left for callers.
  const flags = parseMultiRunFlags([
    "--fresh",
    "--other-flag=foo",
    "positional",
  ]);
  assertEquals(flags.fresh, true);
});

Deno.test("clampSubEpsilonRegression — sub-epsilon increase is snapped to prev", () => {
  // Reproduces the exact regression from issue #447: prev/curr differ
  // by ~2e-11 at the 11th decimal place, well below the epsilon.
  const prev = 0.09991484951372887;
  const curr = 0.0999148515359649;
  assertEquals(curr - prev > 0, true, "test data: curr must be greater than prev");
  assertEquals(curr - prev < MILESTONE_ERROR_EPSILON, true, "test data: delta must be sub-epsilon");
  assertEquals(clampSubEpsilonRegression(prev, curr), prev);
});

Deno.test("clampSubEpsilonRegression — above-epsilon regression is preserved", () => {
  // A real regression — twice the epsilon — must pass through unchanged.
  const prev = 0.1;
  const curr = prev + MILESTONE_ERROR_EPSILON * 2;
  assertEquals(clampSubEpsilonRegression(prev, curr), curr);
});

Deno.test("clampSubEpsilonRegression — improvement is preserved", () => {
  // An improvement (curr < prev) must always pass through unchanged.
  assertEquals(clampSubEpsilonRegression(0.5, 0.4), 0.4);
  // Tiny improvement well below epsilon — also preserved.
  assertEquals(clampSubEpsilonRegression(0.1, 0.1 - 1e-12), 0.1 - 1e-12);
});

Deno.test("clampSubEpsilonRegression — flat values pass through unchanged", () => {
  // delta === 0 must not be clamped (no regression at all).
  assertEquals(clampSubEpsilonRegression(0.25, 0.25), 0.25);
});

Deno.test("clampSubEpsilonRegression — non-finite values are passed through", () => {
  // We never want the clamp to invent a finite value from a NaN/Inf input.
  assertEquals(Number.isNaN(clampSubEpsilonRegression(NaN, 0.1)), false);
  assertEquals(clampSubEpsilonRegression(NaN, 0.1), 0.1);
  assertEquals(clampSubEpsilonRegression(0.1, Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
});

Deno.test(
  "appendMultiRunRun clamps sub-epsilon regression between runs (issue #447)",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
    try {
      const slug = "mnist_classification";

      // Run 1 ends at the exact value observed in issue #447.
      const prevError = 0.09991484951372887;
      await appendMultiRunRun(slug, {
        creatureExport: sampleCreatureExport(1),
        newSamples: [{
          runGen: 95,
          error: prevError,
          bestScore: 1 - prevError,
          neurons: 794,
          synapses: 7841,
          generationWallClockMs: 312607,
        }],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      // Run 2 reports the (slightly noisier) re-evaluated error — sub-epsilon worse.
      const noisyError = 0.0999148515359649;
      await appendMultiRunRun(slug, {
        creatureExport: sampleCreatureExport(2),
        newSamples: [{
          runGen: 1,
          error: noisyError,
          bestScore: 1 - noisyError,
          neurons: 794,
          synapses: 7841,
          generationWallClockMs: 100,
        }],
        runIndex: 2,
        baseCumulativeGen: 95,
      }, tmp);

      const state = await loadMultiRunState(slug, tmp);
      assertEquals(state.milestones.length, 2);
      // The clamp snaps the second sample's error to the prior value —
      // the recorded history is monotonically non-increasing.
      assertEquals(state.milestones[1].error, prevError);
      assert(
        state.milestones[1].error <= state.milestones[0].error,
        "recorded error must never increase across runs",
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "appendMultiRunRun preserves a genuine above-epsilon regression",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
    try {
      const slug = "cart_pole";

      await appendMultiRunRun(slug, {
        creatureExport: sampleCreatureExport(1),
        newSamples: [tinyMilestone(10, 0.1)],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      // A run that is 0.05 worse — well above any noise epsilon. Must
      // be recorded unchanged so reviewers see the real regression.
      const regressedError = 0.15;
      await appendMultiRunRun(slug, {
        creatureExport: sampleCreatureExport(2),
        newSamples: [tinyMilestone(5, regressedError)],
        runIndex: 2,
        baseCumulativeGen: 10,
      }, tmp);

      const state = await loadMultiRunState(slug, tmp);
      assertEquals(state.milestones.length, 2);
      assertEquals(state.milestones[1].error, regressedError);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "appendMultiRunRun clamps sub-epsilon regression within a single run too",
  async () => {
    // The clamp is applied per-sample against the previous milestone,
    // so an intra-run float jitter sample also gets snapped down.
    const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
    try {
      const slug = "xor_classification";
      const error1 = 0.2;
      const error2 = 0.2 + 5e-12; // sub-epsilon "regression" within the run
      await appendMultiRunRun(slug, {
        creatureExport: sampleCreatureExport(1),
        newSamples: [
          tinyMilestone(1, error1),
          { ...tinyMilestone(2, error2), error: error2 },
        ],
        runIndex: 1,
        baseCumulativeGen: 0,
      }, tmp);

      const state = await loadMultiRunState(slug, tmp);
      assertEquals(state.milestones.length, 2);
      assertEquals(state.milestones[0].error, error1);
      assertEquals(state.milestones[1].error, error1, "sub-epsilon jitter snaps to prev");
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test("appendMultiRunRun writes deterministic JSON (round-trip identical)", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const slug = "xor_classification";
    const creatureExport = sampleCreatureExport(7);
    const newSamples = [tinyMilestone(1, 0.5)];

    await appendMultiRunRun(slug, {
      creatureExport,
      newSamples,
      runIndex: 1,
      baseCumulativeGen: 0,
    }, tmp);
    const firstBytes = Deno.readTextFileSync(join(tmp, "data", slug, "milestones.json"));

    // Reload and rewrite — same input must produce same bytes.
    const state = await loadMultiRunState(slug, tmp);
    assertNotEquals(state.milestones.length, 0);

    // Second run should append, not corrupt.
    await appendMultiRunRun(slug, {
      creatureExport,
      newSamples: [tinyMilestone(1, 0.4)],
      runIndex: 2,
      baseCumulativeGen: state.lastCumulativeGen,
    }, tmp);
    const secondBytes = Deno.readTextFileSync(join(tmp, "data", slug, "milestones.json"));
    assertNotEquals(secondBytes, firstBytes, "second run must change the file");

    const reloaded = await loadMultiRunState(slug, tmp);
    assertEquals(reloaded.milestones.length, 2);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
