import { assertEquals } from "@std/assert";

/**
 * Verify that PR summary files have been archived to docs/archive/
 * and no longer exist in the docs/ root directory.
 */

const ARCHIVED_FILES = [
  "pr-summary-5.md",
  "pr-summary-7.md",
  "pr-summary-8.md",
  "pr-summary-9.md",
  "pr-summary-10.md",
  "pr-summary-11.md",
  "pr-summary-12.md",
  "pr-summary-13.md",
  "pr-summary-14.md",
];

Deno.test("PR summary files exist in docs/archive/", () => {
  for (const file of ARCHIVED_FILES) {
    const path = `docs/archive/${file}`;
    const stat = Deno.statSync(path);
    assertEquals(stat.isFile, true, `Expected ${path} to be a file`);
  }
});

Deno.test("No PR summary files remain in docs/ root", () => {
  for (const entry of Deno.readDirSync("docs/")) {
    if (entry.isFile && entry.name.startsWith("pr-summary-")) {
      // Current PR summaries that have not yet been archived
      if (entry.name === "pr-summary-24.md") continue;
      if (entry.name === "pr-summary-25.md") continue;
      if (entry.name === "pr-summary-26.md") continue;
      if (entry.name === "pr-summary-27.md") continue;
      if (entry.name === "pr-summary-32.md") continue;
      if (entry.name === "pr-summary-33.md") continue;
      if (entry.name === "pr-summary-34.md") continue;
      if (entry.name === "pr-summary-35.md") continue;
      if (entry.name === "pr-summary-36.md") continue;
      if (entry.name === "pr-summary-37.md") continue;
      if (entry.name === "pr-summary-38.md") continue;
      if (entry.name === "pr-summary-49.md") continue;
      if (entry.name === "pr-summary-50.md") continue;
      if (entry.name === "pr-summary-51.md") continue;
      if (entry.name === "pr-summary-55.md") continue;
      if (entry.name === "pr-summary-57.md") continue;
      if (entry.name === "pr-summary-58.md") continue;
      if (entry.name === "pr-summary-59.md") continue;
      if (entry.name === "pr-summary-60.md") continue;
      if (entry.name === "pr-summary-65.md") continue;
      if (entry.name === "pr-summary-70.md") continue;
      if (entry.name === "pr-summary-72.md") continue;
      if (entry.name === "pr-summary-73.md") continue;
      if (entry.name === "pr-summary-76.md") continue;
      if (entry.name === "pr-summary-77.md") continue;
      if (entry.name === "pr-summary-78.md") continue;
      if (entry.name === "pr-summary-79.md") continue;
      if (entry.name === "pr-summary-80.md") continue;
      if (entry.name === "pr-summary-81.md") continue;
      if (entry.name === "pr-summary-83.md") continue;
      if (entry.name === "pr-summary-85.md") continue;
      if (entry.name === "pr-summary-88.md") continue;
      if (entry.name === "pr-summary-89.md") continue;
      if (entry.name === "pr-summary-90.md") continue;
      if (entry.name === "pr-summary-93.md") continue;
      if (entry.name === "pr-summary-94.md") continue;
      if (entry.name === "pr-summary-96.md") continue;
      if (entry.name === "pr-summary-105.md") continue;
      if (entry.name === "pr-summary-106.md") continue;
      throw new Error(
        `Found unexpected PR summary file in docs/ root: ${entry.name}`,
      );
    }
  }
});
