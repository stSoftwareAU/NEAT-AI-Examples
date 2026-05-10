import { assert, assertEquals } from "@std/assert";

/**
 * Verify that PR summary files have been archived to docs/archive/
 * and no longer exist in the docs/ root directory.
 */

Deno.test("PR summary files exist in docs/archive/", () => {
  const archived = [...Deno.readDirSync("docs/archive/")]
    .filter((entry) => entry.isFile && entry.name.startsWith("pr-summary-"));

  assert(archived.length > 0, "Expected archived PR summary files");
  for (const entry of archived) {
    const path = `docs/archive/${entry.name}`;
    assertEquals(Deno.statSync(path).isFile, true, `Expected ${path} to be a file`);
  }
});

Deno.test("No PR summary files remain in docs/ root", () => {
  for (const entry of Deno.readDirSync("docs/")) {
    if (entry.isFile && entry.name.startsWith("pr-summary-")) {
      throw new Error(
        `Found unexpected PR summary file in docs/ root: ${entry.name}`,
      );
    }
  }
});
