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
      if (entry.name === "pr-summary-84.md") continue;
      if (entry.name === "pr-summary-85.md") continue;
      if (entry.name === "pr-summary-86.md") continue;
      if (entry.name === "pr-summary-87.md") continue;
      if (entry.name === "pr-summary-88.md") continue;
      if (entry.name === "pr-summary-89.md") continue;
      if (entry.name === "pr-summary-90.md") continue;
      if (entry.name === "pr-summary-91.md") continue;
      if (entry.name === "pr-summary-93.md") continue;
      if (entry.name === "pr-summary-94.md") continue;
      if (entry.name === "pr-summary-95.md") continue;
      if (entry.name === "pr-summary-96.md") continue;
      if (entry.name === "pr-summary-105.md") continue;
      if (entry.name === "pr-summary-106.md") continue;
      if (entry.name === "pr-summary-107.md") continue;
      if (entry.name === "pr-summary-108.md") continue;
      if (entry.name === "pr-summary-109.md") continue;
      if (entry.name === "pr-summary-110.md") continue;
      if (entry.name === "pr-summary-111.md") continue;
      if (entry.name === "pr-summary-112.md") continue;
      if (entry.name === "pr-summary-126.md") continue;
      if (entry.name === "pr-summary-127.md") continue;
      if (entry.name === "pr-summary-128.md") continue;
      if (entry.name === "pr-summary-131.md") continue;
      if (entry.name === "pr-summary-132.md") continue;
      if (entry.name === "pr-summary-137.md") continue;
      if (entry.name === "pr-summary-138.md") continue;
      if (entry.name === "pr-summary-143.md") continue;
      if (entry.name === "pr-summary-147.md") continue;
      if (entry.name === "pr-summary-148.md") continue;
      if (entry.name === "pr-summary-149.md") continue;
      if (entry.name === "pr-summary-150.md") continue;
      if (entry.name === "pr-summary-151.md") continue;
      if (entry.name === "pr-summary-152.md") continue;
      if (entry.name === "pr-summary-153.md") continue;
      if (entry.name === "pr-summary-154.md") continue;
      if (entry.name === "pr-summary-155.md") continue;
      if (entry.name === "pr-summary-159.md") continue;
      if (entry.name === "pr-summary-160.md") continue;
      if (entry.name === "pr-summary-177.md") continue;
      if (entry.name === "pr-summary-178.md") continue;
      if (entry.name === "pr-summary-181.md") continue;
      if (entry.name === "pr-summary-184.md") continue;
      if (entry.name === "pr-summary-185.md") continue;
      if (entry.name === "pr-summary-186.md") continue;
      if (entry.name === "pr-summary-187.md") continue;
      if (entry.name === "pr-summary-188.md") continue;
      if (entry.name === "pr-summary-189.md") continue;
      if (entry.name === "pr-summary-190.md") continue;
      if (entry.name === "pr-summary-191.md") continue;
      if (entry.name === "pr-summary-195.md") continue;
      if (entry.name === "pr-summary-196.md") continue;
      if (entry.name === "pr-summary-198.md") continue;
      if (entry.name === "pr-summary-199.md") continue;
      if (entry.name === "pr-summary-200.md") continue;
      if (entry.name === "pr-summary-201.md") continue;
      if (entry.name === "pr-summary-202.md") continue;
      if (entry.name === "pr-summary-205.md") continue;
      if (entry.name === "pr-summary-206.md") continue;
      if (entry.name === "pr-summary-207.md") continue;
      if (entry.name === "pr-summary-208.md") continue;
      if (entry.name === "pr-summary-209.md") continue;
      if (entry.name === "pr-summary-210.md") continue;
      if (entry.name === "pr-summary-211.md") continue;
      if (entry.name === "pr-summary-212.md") continue;
      if (entry.name === "pr-summary-213.md") continue;
      if (entry.name === "pr-summary-214.md") continue;
      if (entry.name === "pr-summary-215.md") continue;
      if (entry.name === "pr-summary-216.md") continue;
      if (entry.name === "pr-summary-217.md") continue;
      if (entry.name === "pr-summary-218.md") continue;
      if (entry.name === "pr-summary-219.md") continue;
      if (entry.name === "pr-summary-221.md") continue;
      if (entry.name === "pr-summary-222.md") continue;
      if (entry.name === "pr-summary-231.md") continue;
      throw new Error(
        `Found unexpected PR summary file in docs/ root: ${entry.name}`,
      );
    }
  }
});
