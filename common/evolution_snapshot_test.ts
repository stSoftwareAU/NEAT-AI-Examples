/**
 * Unit tests for the shared evolution-snapshot helper.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `captureSnapshot` and `loadSnapshots` (files written, content, ordering,
 * byte-for-byte reproducibility) without inspecting how the helper builds
 * its output.
 */

import { assert, assertEquals } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import {
  captureSnapshot,
  DEFAULT_CHECKPOINTS,
  loadSnapshots,
  type SnapshotConfig,
} from "./evolution_snapshot.ts";

function makeConfig(outputDir: string): SnapshotConfig {
  return { checkpoints: [...DEFAULT_CHECKPOINTS], outputDir };
}

Deno.test("captureSnapshot writes a file for each checkpoint generation", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_snapshot_test_" });
  try {
    const config = makeConfig(tmp);

    captureSnapshot(config, 1, { nodes: [], connections: [] }, 0.1);
    captureSnapshot(config, 10, { nodes: [{ id: 1 }], connections: [] }, 0.5);
    captureSnapshot(config, 100, { nodes: [], connections: [] }, 0.9, [[1, 2, 3]]);

    assert(existsSync(join(tmp, "snapshot-gen-1.json")), "gen 1 file should exist");
    assert(existsSync(join(tmp, "snapshot-gen-10.json")), "gen 10 file should exist");
    assert(existsSync(join(tmp, "snapshot-gen-100.json")), "gen 100 file should exist");

    const parsed = JSON.parse(Deno.readTextFileSync(join(tmp, "snapshot-gen-100.json")));
    assertEquals(parsed.generation, 100);
    assertEquals(parsed.score, 0.9);
    assertEquals(parsed.sampleOutputs, [[1, 2, 3]]);
    assertEquals(parsed.creature, { nodes: [], connections: [] });
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("captureSnapshot writes nothing for non-checkpoint generations", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_snapshot_test_" });
  try {
    const config = makeConfig(tmp);

    assertEquals(captureSnapshot(config, 2, {}, 0), null);
    assertEquals(captureSnapshot(config, 7, {}, 0), null);
    assertEquals(captureSnapshot(config, 999, {}, 0), null);

    const entries = [...Deno.readDirSync(tmp)].filter((e) => e.name.startsWith("snapshot-gen-"));
    assertEquals(entries.length, 0, "no snapshot files should have been written");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("loadSnapshots round-trips captureSnapshot output sorted by generation", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_snapshot_test_" });
  try {
    const config = makeConfig(tmp);

    // Write out of generation order to prove loadSnapshots sorts.
    captureSnapshot(config, 100, { nodes: ["c"] }, 0.9);
    captureSnapshot(config, 1, { nodes: ["a"] }, 0.1);
    captureSnapshot(config, 10, { nodes: ["b"] }, 0.5, [[42]]);

    const snaps = loadSnapshots(tmp);

    assertEquals(snaps.length, 3);
    assertEquals(snaps.map((s) => s.generation), [1, 10, 100]);
    assertEquals(snaps[0].score, 0.1);
    assertEquals(snaps[1].sampleOutputs, [[42]]);
    assertEquals(snaps[2].creature, { nodes: ["c"] });
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("captureSnapshot is reproducible — identical inputs yield byte-identical files", () => {
  const tmpA = Deno.makeTempDirSync({ prefix: "neat_snapshot_test_a_" });
  const tmpB = Deno.makeTempDirSync({ prefix: "neat_snapshot_test_b_" });
  try {
    const cfgA = makeConfig(tmpA);
    const cfgB = makeConfig(tmpB);
    const creature = {
      nodes: [{ id: 1 }, { id: 2 }],
      connections: [{ from: 1, to: 2, w: 0.3 }],
    };
    const samples = [[0, 0, 0], [1, 1, 1]];

    captureSnapshot(cfgA, 1, creature, 0.42, samples);
    captureSnapshot(cfgA, 10, creature, 0.84, samples);
    captureSnapshot(cfgB, 1, creature, 0.42, samples);
    captureSnapshot(cfgB, 10, creature, 0.84, samples);

    for (const gen of [1, 10]) {
      const a = Deno.readFileSync(join(tmpA, `snapshot-gen-${gen}.json`));
      const b = Deno.readFileSync(join(tmpB, `snapshot-gen-${gen}.json`));
      assertEquals(a, b, `snapshot-gen-${gen}.json should be byte-identical`);
    }
  } finally {
    Deno.removeSync(tmpA, { recursive: true });
    Deno.removeSync(tmpB, { recursive: true });
  }
});

Deno.test("loadSnapshots returns an empty array for a missing or empty directory", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "neat_snapshot_test_" });
  try {
    assertEquals(loadSnapshots(join(tmp, "does-not-exist")), []);
    assertEquals(loadSnapshots(tmp), []);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
