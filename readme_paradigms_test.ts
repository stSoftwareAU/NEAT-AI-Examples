/**
 * Tests for the supervised-vs-agent paradigms section in README.md (issue #126).
 *
 * The top-level README must explain the difference between batch supervised
 * evolution (XOR, MNIST, Stock Market) and episode-based agent evolution
 * (Snake, Cart-Pole, Lunar Lander, Mountain Car, Maze Navigation), and tag
 * every row in the Examples at a Glance table so readers can tell which
 * paradigm an example belongs to.
 *
 * These are "what" tests — they read README.md and verify the structural
 * elements the issue requires, not the implementation.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const README_PATH = "README.md";

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/* ------------------------------------------------------------------ */
/*  Section exists and sits before "Examples at a Glance"             */
/* ------------------------------------------------------------------ */

Deno.test("README.md has a Two Training Paradigms section", () => {
  const content = loadReadme();
  assertEquals(
    /^##\s+.*(Two Training Paradigms|Supervised vs Agent)/im.test(content),
    true,
    "README.md should have a Two Training Paradigms / Supervised vs Agent heading",
  );
});

Deno.test("paradigms section appears before Examples at a Glance", () => {
  const content = loadReadme();
  const paradigmMatch = content.match(/^##\s+.*(Two Training Paradigms|Supervised vs Agent).*$/im);
  const examplesMatch = content.match(/^##\s+.*Examples at a Glance.*$/im);
  assertEquals(paradigmMatch !== null, true, "paradigms section must exist");
  assertEquals(examplesMatch !== null, true, "Examples at a Glance section must exist");
  if (paradigmMatch && examplesMatch) {
    const paradigmIndex = content.indexOf(paradigmMatch[0]);
    const examplesIndex = content.indexOf(examplesMatch[0]);
    assertEquals(
      paradigmIndex < examplesIndex,
      true,
      "paradigms section should appear before Examples at a Glance",
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Section content covers both paradigms                             */
/* ------------------------------------------------------------------ */

function paradigmSection(content: string): string {
  // Extract the text between the paradigms heading and the next H2.
  const start = content.search(/^##\s+.*(Two Training Paradigms|Supervised vs Agent).*$/im);
  if (start < 0) return "";
  const after = content.slice(start + 1);
  const nextHeadingOffset = after.search(/^##\s+/m);
  return nextHeadingOffset < 0
    ? content.slice(start)
    : content.slice(start, start + 1 + nextHeadingOffset);
}

Deno.test("paradigms section explains batch supervised training", () => {
  const section = paradigmSection(loadReadme());
  for (const term of ["supervised", "XOR", "MNIST", "Stock Market"]) {
    assertStringIncludes(
      section.toLowerCase(),
      term.toLowerCase(),
      `paradigms section should mention ${term}`,
    );
  }
});

Deno.test("paradigms section explains episode-based agent evolution", () => {
  const section = paradigmSection(loadReadme()).toLowerCase();
  for (const term of ["agent", "episode", "snake", "cart", "lunar", "maze"]) {
    assertStringIncludes(
      section,
      term,
      `paradigms section should mention ${term}`,
    );
  }
});

Deno.test("paradigms section answers the Snake question", () => {
  const section = paradigmSection(loadReadme()).toLowerCase();
  // The pointer paragraph must point readers to snake_game/README.md.
  assertStringIncludes(
    section,
    "snake_game/readme.md",
    "paradigms section should link to snake_game/README.md as the canonical agent demo",
  );
});

/* ------------------------------------------------------------------ */
/*  Section contains a Mermaid diagram covering both loops            */
/* ------------------------------------------------------------------ */

function extractMermaidBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) blocks.push(m[1]);
  return blocks;
}

Deno.test("paradigms section contains a Mermaid diagram", () => {
  const section = paradigmSection(loadReadme());
  const blocks = extractMermaidBlocks(section);
  assertEquals(
    blocks.length >= 1,
    true,
    "paradigms section should contain at least one mermaid diagram",
  );
});

Deno.test("paradigms diagram covers both loops", () => {
  const section = paradigmSection(loadReadme());
  const diagrams = extractMermaidBlocks(section).join("\n").toLowerCase();
  // Supervised loop keywords.
  assertStringIncludes(diagrams, "dataset", "supervised loop should mention the dataset/rows");
  // Episode loop keywords.
  for (const term of ["observe", "activate", "step"]) {
    assertStringIncludes(
      diagrams,
      term,
      `episode loop should mention ${term}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Examples at a Glance table tags every row                         */
/* ------------------------------------------------------------------ */

const SUPERVISED_EXAMPLES = [
  "XOR",
  "MNIST",
  "Stock Market",
  "Evolution Showcase",
] as const;

const AGENT_EXAMPLES = [
  "Cart-Pole",
  "Lunar Lander",
  "Mountain Car",
  "Snake",
  "Maze Navigation",
] as const;

const TECHNIQUE_EXAMPLES = [
  "Intelligent Design",
  "Discovery",
  "Discovery at Scale",
  "Crossover",
  "CRISPR Injection",
  "MCMC Acceptance",
  "Memetic Evolution",
  "Synthetic Synapse",
  "Neuron Pruning",
  "Adaptive Mutation",
  "Suggest Improvements",
] as const;

function examplesAtAGlanceTable(content: string): string {
  const start = content.search(/^##\s+.*Examples at a Glance.*$/im);
  if (start < 0) return "";
  const after = content.slice(start + 1);
  const nextHeadingOffset = after.search(/^##\s+/m);
  return nextHeadingOffset < 0
    ? content.slice(start)
    : content.slice(start, start + 1 + nextHeadingOffset);
}

// Badge tokens must be the explicit emoji + word so they cannot be
// satisfied by the word appearing inside an example's description prose.
const SUPERVISED_BADGE = "📊 supervised";
const AGENT_BADGE = "🎮 agent";
const TECHNIQUE_BADGE = "🛠 technique";

function rowsForExample(table: string, name: string): string[] {
  return table.split("\n").filter((l) => l.includes("[") && l.includes(name));
}

for (const name of SUPERVISED_EXAMPLES) {
  Deno.test(`Examples table tags ${name} as supervised`, () => {
    const table = examplesAtAGlanceTable(loadReadme());
    const lines = rowsForExample(table, name);
    assertEquals(lines.length >= 1, true, `Examples table should contain a row for ${name}`);
    const tagged = lines.filter((l) => l.includes(SUPERVISED_BADGE));
    assertEquals(
      tagged.length >= 1,
      true,
      `Examples table row for ${name} should include the "${SUPERVISED_BADGE}" badge`,
    );
  });
}

for (const name of AGENT_EXAMPLES) {
  Deno.test(`Examples table tags ${name} as agent`, () => {
    const table = examplesAtAGlanceTable(loadReadme());
    const lines = rowsForExample(table, name);
    assertEquals(lines.length >= 1, true, `Examples table should contain a row for ${name}`);
    const tagged = lines.filter((l) => l.includes(AGENT_BADGE));
    assertEquals(
      tagged.length >= 1,
      true,
      `Examples table row for ${name} should include the "${AGENT_BADGE}" badge`,
    );
  });
}

for (const name of TECHNIQUE_EXAMPLES) {
  Deno.test(`Examples table tags ${name} as technique`, () => {
    const table = examplesAtAGlanceTable(loadReadme());
    const lines = rowsForExample(table, name);
    assertEquals(lines.length >= 1, true, `Examples table should contain a row for ${name}`);
    const tagged = lines.filter((l) => l.includes(TECHNIQUE_BADGE));
    assertEquals(
      tagged.length >= 1,
      true,
      `Examples table row for ${name} should include the "${TECHNIQUE_BADGE}" badge`,
    );
  });
}
