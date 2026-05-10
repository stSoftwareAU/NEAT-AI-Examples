/**
 * Tests for `docs/event-driven-evolution.md` — the navigation/landing
 * page that summarises the supervised-batch vs reinforcement /
 * event-driven paradigm split for Examples readers (issue #235).
 *
 * These are "what" tests — they verify what the documentation
 * produces (the file exists, contains the four required sections,
 * lists every example by name, and links to the upstream API spec).
 * They do not inspect any source code patterns.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const DOC_PATH = "docs/event-driven-evolution.md";
const README_PATH = "README.md";

/** Supervised batch examples that must appear in the table. */
const SUPERVISED_EXAMPLES = [
  "mnist_classification",
  "xor_classification",
  "stock_market",
] as const;

/** Reinforcement / event-driven examples that must appear in the table. */
const EVENT_DRIVEN_EXAMPLES = [
  "cart_pole",
  "mountain_car",
  "snake_game",
  "maze_navigation",
  "lunar_lander",
] as const;

/** Migration sub-issues that must appear in the migration-status checklist. */
const MIGRATION_ISSUES = [236, 237, 238, 239, 240] as const;

function loadDoc(): string {
  return Deno.readTextFileSync(DOC_PATH);
}

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/* ------------------------------------------------------------------ */
/*  Doc presence and shape                                             */
/* ------------------------------------------------------------------ */

Deno.test("docs/event-driven-evolution.md exists and is non-empty", () => {
  const content = loadDoc();
  assertEquals(
    content.length > 0,
    true,
    "event-driven-evolution.md must not be empty",
  );
});

Deno.test("docs/event-driven-evolution.md has the four required sections", () => {
  const content = loadDoc();
  // Each acceptance-criteria section must appear as a Markdown heading.
  const expectedHeadings = [
    /^##\s+.*two paradigms/im,
    /^##\s+.*why the split matters/im,
    /^##\s+.*what .*evolveenv.*provides/im,
    /^##\s+.*migration status/im,
  ];
  for (const re of expectedHeadings) {
    assertEquals(
      re.test(content),
      true,
      `event-driven-evolution.md should contain heading matching ${re}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Two-paradigms table — every example must be classified            */
/* ------------------------------------------------------------------ */

Deno.test("docs/event-driven-evolution.md lists every supervised batch example", () => {
  const content = loadDoc();
  for (const name of SUPERVISED_EXAMPLES) {
    assertStringIncludes(
      content,
      name,
      `event-driven-evolution.md should list ${name} as a supervised batch example`,
    );
  }
});

Deno.test("docs/event-driven-evolution.md lists every event-driven example", () => {
  const content = loadDoc();
  for (const name of EVENT_DRIVEN_EXAMPLES) {
    assertStringIncludes(
      content,
      name,
      `event-driven-evolution.md should list ${name} as a reinforcement / event-driven example`,
    );
  }
});

Deno.test("docs/event-driven-evolution.md names the two evolution APIs", () => {
  const content = loadDoc().toLowerCase();
  for (const api of ["evolvedir", "evolveenv"]) {
    assertStringIncludes(
      content,
      api,
      `event-driven-evolution.md should name the ${api} API`,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Why-the-split-matters narrative                                    */
/* ------------------------------------------------------------------ */

Deno.test("docs/event-driven-evolution.md explains why the split matters", () => {
  const content = loadDoc().toLowerCase();
  // Supervised batch is pre-generated forward-only records; event-driven
  // is per-trajectory rollout against a stepping environment.
  for (const term of ["forward", "trajectory", "rollout", "environment"]) {
    assertStringIncludes(
      content,
      term,
      `event-driven-evolution.md should mention "${term}" when contrasting the paradigms`,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Upstream API spec link                                             */
/* ------------------------------------------------------------------ */

Deno.test("docs/event-driven-evolution.md links to the upstream NEAT-AI spec", () => {
  const content = loadDoc();
  assertStringIncludes(
    content,
    "stSoftwareAU/NEAT-AI",
    "event-driven-evolution.md should link to the upstream NEAT-AI repository",
  );
  assertStringIncludes(
    content,
    "event-driven-evolution.md",
    "event-driven-evolution.md should reference the upstream doc by filename",
  );
});

/* ------------------------------------------------------------------ */
/*  Migration-status checklist                                         */
/* ------------------------------------------------------------------ */

Deno.test("docs/event-driven-evolution.md migration-status section is a checkbox list", () => {
  const content = loadDoc();
  // GitHub-style task list markers: "- [ ]" or "- [x]".
  const checkboxRe = /^- \[[ xX]\]/m;
  assertEquals(
    checkboxRe.test(content),
    true,
    "event-driven-evolution.md should contain at least one Markdown task-list item",
  );
});

Deno.test("docs/event-driven-evolution.md migration-status section references every sub-issue", () => {
  const content = loadDoc();
  for (const issue of MIGRATION_ISSUES) {
    assertStringIncludes(
      content,
      `#${issue}`,
      `event-driven-evolution.md should reference migration sub-issue #${issue}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  README.md links to the new doc                                     */
/* ------------------------------------------------------------------ */

Deno.test("README.md links to docs/event-driven-evolution.md", () => {
  const readme = loadReadme();
  assertStringIncludes(
    readme,
    "docs/event-driven-evolution.md",
    "README.md should link to the new event-driven-evolution doc",
  );
});
