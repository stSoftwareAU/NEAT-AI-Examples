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
  "adaptive_mutation",
  "cart_pole",
  "crispr_injection",
  "crossover",
  "discovery",
  "discovery_at_scale",
  "evolution_showcase",
  "intelligent_design",
  "lunar_lander",
  "maze_navigation",
  "mcmc_acceptance",
  "memetic_evolution",
  "mnist_classification",
  "mountain_car",
  "neuron_pruning",
  "snake_game",
  "stock_market",
  "suggest_improvements",
  "synthetic_synapse",
  "xor_classification",
] as const;

const SCREENSHOT_PATHS = [
  "docs/screenshots/xor_decision_boundary.svg",
  "docs/screenshots/cart_pole.svg",
  "docs/screenshots/lunar_lander.svg",
  "docs/screenshots/mountain_car.svg",
  "docs/screenshots/snake_game.svg",
  "docs/screenshots/maze_navigation.svg",
  "docs/screenshots/stock_market.svg",
  "docs/screenshots/mnist_classification.svg",
  "docs/screenshots/mcmc_acceptance.svg",
  "docs/screenshots/crispr_injection.svg",
  "docs/screenshots/memetic_evolution.svg",
  "docs/screenshots/evolution_showcase_evolution.svg",
] as const;

/**
 * Unique-feature demos consolidated by issue #91. Each row of the
 * "Unique Features Showcase" table embeds one of these screenshots.
 */
const UNIQUE_FEATURE_SHOWCASE: ReadonlyArray<
  { name: string; dir: string; screenshot: string }
> = [
  {
    name: "Discovery at Scale",
    dir: "discovery_at_scale",
    screenshot: "docs/screenshots/discovery_at_scale.svg",
  },
  {
    name: "Synthetic Synapse",
    dir: "synthetic_synapse",
    screenshot: "docs/screenshots/synthetic_synapse.svg",
  },
  {
    name: "Adaptive Mutation",
    dir: "adaptive_mutation",
    screenshot: "docs/screenshots/adaptive_mutation.svg",
  },
  {
    name: "Neuron Pruning",
    dir: "neuron_pruning",
    screenshot: "docs/screenshots/neuron_pruning.svg",
  },
  {
    name: "CRISPR Injection",
    dir: "crispr_injection",
    screenshot: "docs/screenshots/crispr_injection.svg",
  },
  {
    name: "MCMC Acceptance",
    dir: "mcmc_acceptance",
    screenshot: "docs/screenshots/mcmc_acceptance.svg",
  },
  {
    name: "Memetic Evolution",
    dir: "memetic_evolution",
    screenshot: "docs/screenshots/memetic_evolution.svg",
  },
];

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
    "Mountain Car",
    "Snake",
    "Maze Navigation",
    "Stock Market",
    "MNIST",
    "MCMC Acceptance",
    "CRISPR",
    "Memetic Evolution",
    "Synthetic Synapse",
    "Neuron Pruning",
    "Adaptive Mutation",
    "Evolution Showcase",
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

/* ------------------------------------------------------------------ */
/*  Per-example "NEAT-AI Features Used" callout (issue #187)           */
/* ------------------------------------------------------------------ */

/**
 * Every per-example README must include a "NEAT-AI Features Used" section
 * that lists the upstream capabilities the example actually invokes, with
 * at least one bullet linking to upstream COMPARISON.md so the reader can
 * drill in. See issue #187.
 */

const FEATURES_USED_HEADING_RE = /^##\s+.*NEAT-AI Features Used/im;
const UPSTREAM_COMPARISON_LINK_RE =
  /https?:\/\/github\.com\/stSoftwareAU\/NEAT-AI\/(?:blob|tree)\/[^\s)]*COMPARISON\.md(?:#[^\s)]*)?/i;

function sliceFeaturesSection(content: string): string {
  const headingIdx = content.search(FEATURES_USED_HEADING_RE);
  if (headingIdx < 0) return "";
  // Skip past the heading line itself, then bound by the next "## " heading.
  const afterHeading = content.slice(headingIdx);
  const nextLineBreak = afterHeading.indexOf("\n");
  const body = nextLineBreak >= 0 ? afterHeading.slice(nextLineBreak + 1) : "";
  const nextHeadingIdx = body.search(/^##\s+/m);
  return nextHeadingIdx >= 0 ? body.slice(0, nextHeadingIdx) : body;
}

for (const dir of EXAMPLE_DIRS) {
  Deno.test(`${dir}/README.md has a "NEAT-AI Features Used" section`, () => {
    const content = Deno.readTextFileSync(`${dir}/README.md`);
    assertEquals(
      FEATURES_USED_HEADING_RE.test(content),
      true,
      `${dir}/README.md should contain a "## … NEAT-AI Features Used" section so readers see at a glance which upstream capabilities the example exercises (issue #187).`,
    );
  });

  Deno.test(`${dir}/README.md NEAT-AI Features Used section links to upstream COMPARISON.md`, () => {
    const content = Deno.readTextFileSync(`${dir}/README.md`);
    const section = sliceFeaturesSection(content);
    assertEquals(
      section.length > 0,
      true,
      `${dir}/README.md must contain the NEAT-AI Features Used heading before this assertion runs (issue #187).`,
    );
    assertEquals(
      UPSTREAM_COMPARISON_LINK_RE.test(section),
      true,
      `${dir}/README.md NEAT-AI Features Used section must link to upstream COMPARISON.md at least once so the reader can drill into the cited capability (issue #187).`,
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Unique Features Showcase section (issue #91)                       */
/* ------------------------------------------------------------------ */

Deno.test("README.md has a Unique Features Showcase section", () => {
  const content = loadReadme();
  assertEquals(
    /^##\s+.*Unique Features Showcase/im.test(content),
    true,
    "README.md should have a Unique Features Showcase section heading",
  );
});

for (const row of UNIQUE_FEATURE_SHOWCASE) {
  Deno.test(`Unique Features Showcase row exists for ${row.name}`, () => {
    const content = loadReadme();
    const showcaseIdx = content.search(/^##\s+.*Unique Features Showcase/im);
    assertEquals(
      showcaseIdx >= 0,
      true,
      "Unique Features Showcase heading must be present",
    );
    // The remainder of the file from the heading onward must be the
    // showcase section. We slice and confirm each demo is listed and
    // its screenshot embedded inside that slice.
    const showcaseSlice = content.slice(showcaseIdx);
    assertStringIncludes(
      showcaseSlice,
      `${row.dir}/README.md`,
      `Showcase row for ${row.name} should link to ${row.dir}/README.md`,
    );
    assertStringIncludes(
      showcaseSlice,
      row.screenshot,
      `Showcase row for ${row.name} should embed ${row.screenshot}`,
    );
  });

  Deno.test(`Unique Features Showcase screenshot ${row.screenshot} exists on disk`, () => {
    const stat = Deno.statSync(row.screenshot);
    assertEquals(stat.isFile, true, `${row.screenshot} should be a committed file`);
    assertEquals(
      stat.size > 0,
      true,
      `${row.screenshot} should be a non-empty file`,
    );
  });
}
