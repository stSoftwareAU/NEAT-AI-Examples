/**
 * Unit tests for the multi-run state persistence helper.
 *
 * These are "what" tests — they create real artefacts on disk under a
 * temporary base directory and assert on the resulting state.
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import type { CreatureExport } from "@stsoftware/neat-ai";

import {
  appendMultiRunRun,
  loadMultiRunState,
  type MultiRunMilestone,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "./multi_run_state.ts";

/** Tiny stand-in for a real CreatureExport (the helper does not validate the shape). */
function tinyCreatureExport(seed: number): CreatureExport {
  return {
    neurons: [
      { uuid: `n-${seed}-out`, type: "output", squash: "IDENTITY", bias: 0 },
    ],
    synapses: [],
    input: 1,
    output: 1,
  } as unknown as CreatureExport;
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
    const creatureExport = tinyCreatureExport(1);
    const newSamples = [tinyMilestone(1, 0.5), tinyMilestone(10, 0.2)];

    await appendMultiRunRun(slug, {
      creatureExport,
      newSamples,
      runIndex: 1,
      baseCumulativeGen: 0,
    }, tmp);

    const state = await loadMultiRunState(slug, tmp);
    assertEquals(state.creatureExport, creatureExport);
    assertEquals(state.milestones.length, 2);
    assertEquals(state.milestones[0].runIndex, 1);
    assertEquals(state.milestones[0].cumulativeGen, 1);
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
      creatureExport: tinyCreatureExport(1),
      newSamples: [tinyMilestone(1, 0.5), tinyMilestone(10, 0.3)],
      runIndex: 1,
      baseCumulativeGen: 0,
    }, tmp);

    const first = await loadMultiRunState(slug, tmp);
    assertEquals(first.nextRunIndex, 2);
    assertEquals(first.lastCumulativeGen, 10);

    await appendMultiRunRun(slug, {
      creatureExport: tinyCreatureExport(2),
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
      creatureExport: tinyCreatureExport(1),
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

Deno.test("appendMultiRunRun writes deterministic JSON (round-trip identical)", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_multirun_" });
  try {
    const slug = "xor_classification";
    const creatureExport = tinyCreatureExport(7);
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
