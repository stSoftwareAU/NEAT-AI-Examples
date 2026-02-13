/**
 * Tests for the CONTRIBUTING.md contributor guide.
 *
 * These are "what" tests — they read the actual file and verify that it
 * contains all the sections and information required by issue #13.
 */

import { assertEquals, assertExists } from "@std/assert";

const CONTRIBUTING_PATH = "CONTRIBUTING.md";

/** Helper to load the contributing guide. */
function loadContributing(): string {
  return Deno.readTextFileSync(CONTRIBUTING_PATH);
}

Deno.test("CONTRIBUTING.md exists and is non-empty", () => {
  const content = loadContributing();
  assertExists(content, "CONTRIBUTING.md should exist");
  assertEquals(content.length > 0, true, "CONTRIBUTING.md should not be empty");
});

/* ------------------------------------------------------------------ */
/*  Prerequisites section                                              */
/* ------------------------------------------------------------------ */

Deno.test("CONTRIBUTING.md covers Deno installation prerequisite", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("Deno"),
    true,
    "Should mention Deno as a prerequisite",
  );
});

Deno.test("CONTRIBUTING.md covers Rust library for discovery", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("Rust") || content.includes("libneat_ai_discovery"),
    true,
    "Should mention the Rust library for discovery",
  );
});

Deno.test("CONTRIBUTING.md includes platform-specific library paths", () => {
  const content = loadContributing();
  assertEquals(
    content.includes(".dylib"),
    true,
    "Should mention macOS library extension (.dylib)",
  );
  assertEquals(
    content.includes(".so"),
    true,
    "Should mention Linux library extension (.so)",
  );
});

/* ------------------------------------------------------------------ */
/*  Development workflow section                                       */
/* ------------------------------------------------------------------ */

Deno.test("CONTRIBUTING.md covers running tests", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("deno test"),
    true,
    "Should explain how to run tests",
  );
});

Deno.test("CONTRIBUTING.md covers linting", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("deno lint"),
    true,
    "Should explain how to lint",
  );
});

Deno.test("CONTRIBUTING.md covers formatting", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("deno fmt"),
    true,
    "Should explain how to format code",
  );
});

Deno.test("CONTRIBUTING.md covers the quality script", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("quality.sh"),
    true,
    "Should mention the quality.sh script",
  );
});

/* ------------------------------------------------------------------ */
/*  Adding a new example section                                       */
/* ------------------------------------------------------------------ */

Deno.test("CONTRIBUTING.md has a section about adding new examples", () => {
  const content = loadContributing();
  assertEquals(
    content.toLowerCase().includes("adding a new example") ||
      content.toLowerCase().includes("add a new example"),
    true,
    "Should have a section about adding new examples",
  );
});

Deno.test("CONTRIBUTING.md mentions the example file pattern", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("_test.ts"),
    true,
    "Should mention the test file naming convention",
  );
  assertEquals(
    content.includes("run.sh"),
    true,
    "Should mention the runner script convention",
  );
});

/* ------------------------------------------------------------------ */
/*  Testing guidelines section                                         */
/* ------------------------------------------------------------------ */

Deno.test("CONTRIBUTING.md references AGENTS.md for testing philosophy", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("AGENTS.md"),
    true,
    "Should reference AGENTS.md for detailed testing philosophy",
  );
});

Deno.test("CONTRIBUTING.md mentions what vs how tests", () => {
  const content = loadContributing();
  const lower = content.toLowerCase();
  assertEquals(
    lower.includes("what") && lower.includes("how"),
    true,
    "Should explain the what vs how testing distinction",
  );
});

/* ------------------------------------------------------------------ */
/*  Code style section                                                 */
/* ------------------------------------------------------------------ */

Deno.test("CONTRIBUTING.md mentions Australian English requirement", () => {
  const content = loadContributing();
  assertEquals(
    content.includes("Australian English"),
    true,
    "Should mention the Australian English spelling requirement",
  );
});

/* ------------------------------------------------------------------ */
/*  PR checklist section                                               */
/* ------------------------------------------------------------------ */

Deno.test("CONTRIBUTING.md has a PR checklist or review section", () => {
  const content = loadContributing();
  const lower = content.toLowerCase();
  assertEquals(
    lower.includes("pull request") || lower.includes("pr "),
    true,
    "Should have a section about the PR process",
  );
});
