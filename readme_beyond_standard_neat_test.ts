/**
 * Tests for the "Beyond Standard NEAT" feature breadth section in
 * README.md (issue #186).
 *
 * The top-level README must surface — from page one — that NEAT-AI is a
 * substantial superset of the textbook Stanley & Miikkulainen (2002)
 * algorithm. The section lists the major capability categories with
 * one-line summaries, maps each capability to the demo in this repo
 * that exercises it, includes a Mermaid diagram grouping the
 * capabilities by category, and ends with a prominent call-out to
 * upstream COMPARISON.md.
 *
 * These are "what" tests — they read README.md and verify the structural
 * elements the issue requires, not the implementation.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const README_PATH = "README.md";

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

const SECTION_HEADING_RE = /^##\s+.*Beyond Standard NEAT.*$/im;
const PARADIGMS_HEADING_RE = /^##\s+.*(Two Training Paradigms|Supervised vs Agent).*$/im;
const EXAMPLES_HEADING_RE = /^##\s+.*Examples at a Glance.*$/im;
const UPSTREAM_COMPARISON_LINK_RE =
  /https?:\/\/github\.com\/stSoftwareAU\/NEAT-AI\/(?:blob|tree)\/[^\s)]*COMPARISON\.md(?:#[^\s)]*)?/i;

function beyondSection(content: string): string {
  const start = content.search(SECTION_HEADING_RE);
  if (start < 0) return "";
  const after = content.slice(start + 1);
  const nextHeadingOffset = after.search(/^##\s+/m);
  return nextHeadingOffset < 0
    ? content.slice(start)
    : content.slice(start, start + 1 + nextHeadingOffset);
}

function extractMermaidBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) blocks.push(m[1]);
  return blocks;
}

/* ------------------------------------------------------------------ */
/*  Section exists and sits between paradigms and Examples at a Glance */
/* ------------------------------------------------------------------ */

Deno.test("README.md has a Beyond Standard NEAT section", () => {
  const content = loadReadme();
  assertEquals(
    SECTION_HEADING_RE.test(content),
    true,
    "README.md should have a 'Beyond Standard NEAT' heading",
  );
});

Deno.test("Beyond Standard NEAT section appears after the paradigms section", () => {
  const content = loadReadme();
  const paradigmMatch = content.match(PARADIGMS_HEADING_RE);
  const beyondMatch = content.match(SECTION_HEADING_RE);
  assertEquals(paradigmMatch !== null, true, "paradigms section must exist");
  assertEquals(beyondMatch !== null, true, "Beyond Standard NEAT section must exist");
  if (paradigmMatch && beyondMatch) {
    const paradigmIndex = content.indexOf(paradigmMatch[0]);
    const beyondIndex = content.indexOf(beyondMatch[0]);
    assertEquals(
      paradigmIndex < beyondIndex,
      true,
      "Beyond Standard NEAT should sit after the paradigms section",
    );
  }
});

Deno.test("Beyond Standard NEAT section appears before Examples at a Glance", () => {
  const content = loadReadme();
  const beyondMatch = content.match(SECTION_HEADING_RE);
  const examplesMatch = content.match(EXAMPLES_HEADING_RE);
  assertEquals(beyondMatch !== null, true, "Beyond Standard NEAT section must exist");
  assertEquals(examplesMatch !== null, true, "Examples at a Glance section must exist");
  if (beyondMatch && examplesMatch) {
    const beyondIndex = content.indexOf(beyondMatch[0]);
    const examplesIndex = content.indexOf(examplesMatch[0]);
    assertEquals(
      beyondIndex < examplesIndex,
      true,
      "Beyond Standard NEAT should sit before Examples at a Glance",
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Section frames NEAT-AI as a superset of textbook NEAT             */
/* ------------------------------------------------------------------ */

Deno.test("Beyond Standard NEAT section frames NEAT-AI as a superset of textbook NEAT", () => {
  const section = beyondSection(loadReadme()).toLowerCase();
  assertStringIncludes(
    section,
    "superset",
    "section should explicitly state NEAT-AI is a superset of textbook NEAT",
  );
  assertStringIncludes(
    section,
    "stanley",
    "section should reference Stanley (& Miikkulainen) so readers know which baseline is being extended",
  );
});

/* ------------------------------------------------------------------ */
/*  Capability one-line summaries                                     */
/* ------------------------------------------------------------------ */

const REQUIRED_CAPABILITIES: ReadonlyArray<{ name: string; tokens: ReadonlyArray<string> }> = [
  { name: "Backpropagation", tokens: ["backprop"] },
  { name: "Memetic evolution", tokens: ["memetic"] },
  { name: "MCMC mutation acceptance", tokens: ["mcmc"] },
  { name: "GPU-accelerated Discovery", tokens: ["discovery"] },
  { name: "Synthetic synapse training", tokens: ["synthetic synapse"] },
  { name: "Advanced breeding", tokens: ["breeding", "crossover"] },
  { name: "Predictive coding", tokens: ["predictive coding"] },
  { name: "Hyperparameter self-adaptation", tokens: ["hyperparameter"] },
  { name: "Adaptive population sizing", tokens: ["population sizing", "adaptive population"] },
  { name: "ONNX export", tokens: ["onnx"] },
  { name: "Transfer learning", tokens: ["transfer learning"] },
  { name: "Binary .bin training stream", tokens: [".bin"] },
];

for (const cap of REQUIRED_CAPABILITIES) {
  Deno.test(`Beyond Standard NEAT section mentions ${cap.name}`, () => {
    const section = beyondSection(loadReadme()).toLowerCase();
    const present = cap.tokens.some((t) => section.includes(t.toLowerCase()));
    assertEquals(
      present,
      true,
      `Beyond Standard NEAT section should mention ${cap.name} (any of: ${cap.tokens.join(", ")})`,
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Mermaid diagram with category groupings                           */
/* ------------------------------------------------------------------ */

Deno.test("Beyond Standard NEAT section contains a Mermaid diagram", () => {
  const section = beyondSection(loadReadme());
  const blocks = extractMermaidBlocks(section);
  assertEquals(
    blocks.length >= 1,
    true,
    "Beyond Standard NEAT section should contain at least one mermaid diagram",
  );
});

Deno.test("Beyond Standard NEAT diagram groups capabilities by category", () => {
  const section = beyondSection(loadReadme());
  const diagrams = extractMermaidBlocks(section).join("\n").toLowerCase();
  for (const category of ["search", "training", "structure", "scale", "interop"]) {
    assertStringIncludes(
      diagrams,
      category,
      `Beyond Standard NEAT diagram should label the ${category} category`,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Prominent call-out to upstream COMPARISON.md                      */
/* ------------------------------------------------------------------ */

Deno.test("Beyond Standard NEAT section links to upstream COMPARISON.md", () => {
  const section = beyondSection(loadReadme());
  assertEquals(
    UPSTREAM_COMPARISON_LINK_RE.test(section),
    true,
    "Beyond Standard NEAT section should link to upstream NEAT-AI/COMPARISON.md",
  );
});

Deno.test("Beyond Standard NEAT section ends with a COMPARISON.md call-out", () => {
  const section = beyondSection(loadReadme());
  // The call-out must mention COMPARISON.md and use the word "taxonomy"
  // so the closing pointer is unambiguous.
  assertStringIncludes(
    section,
    "COMPARISON.md",
    "section should call out COMPARISON.md by name",
  );
  assertStringIncludes(
    section.toLowerCase(),
    "taxonomy",
    "section should use the word 'taxonomy' in the closing call-out",
  );
});
