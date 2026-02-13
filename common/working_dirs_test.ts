/**
 * Unit tests for the shared working directory setup module.
 *
 * These are "what" tests — they verify that setupWorkingDirs creates
 * the expected directory structure without checking implementation details.
 */

import { assertEquals } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import { setupWorkingDirs } from "./working_dirs.ts";

Deno.test("setupWorkingDirs creates all required subdirectories", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_dirs_test_" });
  const root = join(tmpDir, "test-working");

  try {
    const dirs = setupWorkingDirs(root);

    assertEquals(existsSync(dirs.dataDir), true, "data directory should exist");
    assertEquals(existsSync(dirs.creaturesDir), true, "creatures directory should exist");
    assertEquals(existsSync(dirs.outputDir), true, "output directory should exist");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("setupWorkingDirs returns correct paths", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_dirs_test_" });
  const root = join(tmpDir, "test-working");

  try {
    const dirs = setupWorkingDirs(root);

    assertEquals(dirs.root, root, "root should match input");
    assertEquals(dirs.dataDir, join(root, "data"), "dataDir should be <root>/data");
    assertEquals(
      dirs.creaturesDir,
      join(root, "creatures"),
      "creaturesDir should be <root>/creatures",
    );
    assertEquals(dirs.outputDir, join(root, "output"), "outputDir should be <root>/output");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("setupWorkingDirs empties the output directory on re-run", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_dirs_test_" });
  const root = join(tmpDir, "test-working");

  try {
    // First run creates directories
    const dirs = setupWorkingDirs(root);

    // Place a file in the output directory
    const dummyFile = join(dirs.outputDir, "leftover.txt");
    Deno.writeTextFileSync(dummyFile, "should be removed");
    assertEquals(existsSync(dummyFile), true, "dummy file should exist before re-run");

    // Second run should empty the output directory
    setupWorkingDirs(root);
    assertEquals(existsSync(dummyFile), false, "dummy file should be removed after re-run");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("setupWorkingDirs preserves existing data and creatures directories", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_dirs_test_" });
  const root = join(tmpDir, "test-working");

  try {
    // First run
    const dirs = setupWorkingDirs(root);

    // Place files in data and creatures directories
    const dataFile = join(dirs.dataDir, "keep.bin");
    const creaturesFile = join(dirs.creaturesDir, "keep.json");
    Deno.writeTextFileSync(dataFile, "data");
    Deno.writeTextFileSync(creaturesFile, "creature");

    // Second run should preserve data and creatures
    setupWorkingDirs(root);
    assertEquals(existsSync(dataFile), true, "data file should be preserved");
    assertEquals(existsSync(creaturesFile), true, "creatures file should be preserved");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("setupWorkingDirs is idempotent", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "neat_dirs_test_" });
  const root = join(tmpDir, "test-working");

  try {
    // Calling setupWorkingDirs multiple times should not fail
    setupWorkingDirs(root);
    setupWorkingDirs(root);
    const dirs = setupWorkingDirs(root);

    assertEquals(existsSync(dirs.dataDir), true, "data directory should still exist");
    assertEquals(existsSync(dirs.creaturesDir), true, "creatures directory should still exist");
    assertEquals(existsSync(dirs.outputDir), true, "output directory should still exist");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
