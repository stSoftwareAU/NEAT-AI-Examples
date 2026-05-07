/**
 * Tests for the main README.md structure (issue #55).
 *
 * The main README should focus on _what_ the examples are and _how_ to run
 * them at a glance, with deeper detail living in per-example README files.
 * These are "what" tests — they read the actual README files and verify the
 * structure, links, and minimum content requirements.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const README_PATH = "README.md";

const EXAMPLE_DIRS = [
  "cart_pole",
  "crossover",
  "discovery",
  "intelligent_design",
  "lunar_lander",
  "mnist_classification",
  "stock_market",
  "suggest_improvements",
  "xor_classification",
] as const;

const SCREENSHOT_PATHS = [
  "docs/screenshots/xor_decision_boundary.svg",
  "docs/screenshots/cart_pole.svg",
  "docs/screenshots/lunar_lander.svg",
  "docs/screenshots/stock_market.svg",
  "docs/screenshots/mnist_classification.svg",
] as const;

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/* ------------------------------------------------------------------ */
/*  Per-example README files exist                                     */
/* ------------------------------------------------------------------ */

for (const dir of EXAMPLE_DIRS) {
  Deno.test(`${dir}/README.md exists and is non-empty`, () => {
    const path = `${dir}/README.md`;
    const content = Deno.readTextFileSync(path);
    assertEquals(
      content.trim().length > 0,
      true,
      `${path} should not be empty`,
    );
  });

  Deno.test(`${dir}/README.md begins with a heading`, () => {
    const content = Deno.readTextFileSync(`${dir}/README.md`);
    const firstNonBlank = content.split("\n").find((l) => l.trim().length > 0) ?? "";
    assertEquals(
      firstNonBlank.startsWith("# "),
      true,
      `${dir}/README.md should start with a level-1 heading, got: "${firstNonBlank}"`,
    );
  });

  Deno.test(`${dir}/README.md describes how to run the example`, () => {
    const content = Deno.readTextFileSync(`${dir}/README.md`);
    assertStringIncludes(
      content,
      "run.sh",
      `${dir}/README.md should mention the run.sh runner script`,
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Main README links to each per-example README                       */
/* ------------------------------------------------------------------ */

for (const dir of EXAMPLE_DIRS) {
  Deno.test(`README.md links to ${dir}/README.md`, () => {
    const content = loadReadme();
    const linkPattern = new RegExp(`\\]\\(\\.?/?${dir}/README\\.md\\)`);
    assertEquals(
      linkPattern.test(content),
      true,
      `README.md should link to ${dir}/README.md so readers can follow through to detail`,
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Main README is focused: what & how, not a deep dive                */
/* ------------------------------------------------------------------ */

Deno.test("README.md introduces every example by name", () => {
  const content = loadReadme();
  const required = [
    "Intelligent Design",
    "Discovery",
    "Crossover",
    "Cart-Pole",
    "Suggest Improvements",
    "XOR",
    "Lunar Lander",
    "Stock Market",
    "MNIST",
  ];
  for (const name of required) {
    assertStringIncludes(
      content,
      name,
      `README.md should name the ${name} example`,
    );
  }
});

Deno.test("README.md has a Screenshots section", () => {
  const content = loadReadme();
  assertEquals(
    /^##\s+.*Screenshots/im.test(content),
    true,
    "README.md should have a Screenshots section heading",
  );
});

for (const path of SCREENSHOT_PATHS) {
  Deno.test(`README.md embeds the ${path} screenshot`, () => {
    const content = loadReadme();
    assertStringIncludes(
      content,
      path,
      `README.md should embed the ${path} screenshot`,
    );
  });

  Deno.test(`screenshot file ${path} exists on disk`, () => {
    const stat = Deno.statSync(path);
    assertEquals(stat.isFile, true, `${path} should be a committed file`);
    assertEquals(
      stat.size > 0,
      true,
      `${path} should be a non-empty file`,
    );
  });
}

Deno.test("README.md keeps a short one-line summary for each example", () => {
  // The Examples Overview section should hold a concise table or bullet
  // list. We verify it appears before any deep-dive content by checking
  // that a "## Examples" heading exists.
  const content = loadReadme();
  assertEquals(
    /^##\s+.*Examples?/im.test(content),
    true,
    "README.md should have an Examples section heading",
  );
});

Deno.test("README.md does not duplicate the per-example deep-dive content", () => {
  // The main README should no longer carry the detailed "How It Works"
  // numbered walkthroughs that now live in the per-example READMEs.
  // We allow a single "How It Works" reference (e.g. as an anchor link),
  // but more than that means the deep-dive content was duplicated.
  const content = loadReadme();
  const matches = content.match(/How It Works/g) ?? [];
  assertEquals(
    matches.length <= 1,
    true,
    `README.md should not repeat "How It Works" deep dives, found ${matches.length} occurrences`,
  );
});

Deno.test("README.md retains the prerequisites section", () => {
  const content = loadReadme();
  assertStringIncludes(
    content,
    "Prerequisites",
    "README.md should keep a top-level Prerequisites section",
  );
});

Deno.test("README.md retains the Quality Check section", () => {
  const content = loadReadme();
  assertStringIncludes(
    content,
    "Quality Check",
    "README.md should keep a Quality Check section",
  );
});
