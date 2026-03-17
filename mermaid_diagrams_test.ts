/**
 * Tests for mermaid diagrams in documentation.
 *
 * These are "what" tests — they read the actual documentation files and verify
 * that mermaid diagrams are present, well-formed, and cover the required topics.
 */

import { assertEquals } from "@std/assert";

const README_PATH = "README.md";

/** Helper to load README.md content. */
function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/** Extract all mermaid code blocks from markdown content. */
function extractMermaidBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/*  Mermaid diagram count                                              */
/* ------------------------------------------------------------------ */

Deno.test("README.md contains at least 3 mermaid diagrams", () => {
  const content = loadReadme();
  const blocks = extractMermaidBlocks(content);
  assertEquals(
    blocks.length >= 3,
    true,
    `Expected at least 3 mermaid diagrams, found ${blocks.length}`,
  );
});

/* ------------------------------------------------------------------ */
/*  Mermaid blocks are well-formed                                     */
/* ------------------------------------------------------------------ */

Deno.test("all mermaid blocks have a valid diagram type declaration", () => {
  const content = loadReadme();
  const blocks = extractMermaidBlocks(content);
  const validTypes = ["graph", "flowchart", "sequenceDiagram", "classDiagram", "mindmap", "gantt"];

  for (const block of blocks) {
    const firstLine = block.split("\n")[0].trim();
    const hasValidType = validTypes.some((t) => firstLine.startsWith(t));
    assertEquals(
      hasValidType,
      true,
      `Mermaid block should start with a valid diagram type, got: "${firstLine}"`,
    );
  }
});

Deno.test("no mermaid block is empty", () => {
  const content = loadReadme();
  const blocks = extractMermaidBlocks(content);

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    assertEquals(
      lines.length >= 2,
      true,
      "Each mermaid block should have at least a type declaration and one node/edge",
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Diagram content coverage                                           */
/* ------------------------------------------------------------------ */

Deno.test("README.md has a diagram covering the example modules", () => {
  const content = loadReadme();
  const blocks = extractMermaidBlocks(content);
  const allDiagrams = blocks.join("\n");

  assertEquals(
    allDiagrams.includes("Intelligent Design") || allDiagrams.includes("intelligent_design"),
    true,
    "Should have a diagram mentioning the Intelligent Design example",
  );
  assertEquals(
    allDiagrams.includes("Discovery") || allDiagrams.includes("discovery"),
    true,
    "Should have a diagram mentioning the Discovery example",
  );
  assertEquals(
    allDiagrams.includes("Crossover") || allDiagrams.includes("crossover"),
    true,
    "Should have a diagram mentioning the Crossover example",
  );
});

Deno.test("README.md has a diagram covering the quality check pipeline", () => {
  const content = loadReadme();
  const blocks = extractMermaidBlocks(content);
  const allDiagrams = blocks.join("\n");

  assertEquals(
    allDiagrams.toLowerCase().includes("lint"),
    true,
    "Should have a diagram mentioning linting",
  );
  assertEquals(
    allDiagrams.toLowerCase().includes("test"),
    true,
    "Should have a diagram mentioning tests",
  );
});

Deno.test("README.md has a diagram covering the project architecture", () => {
  const content = loadReadme();
  const blocks = extractMermaidBlocks(content);
  const allDiagrams = blocks.join("\n");

  assertEquals(
    allDiagrams.includes("common") || allDiagrams.includes("Common"),
    true,
    "Should have a diagram showing the common module",
  );
});

Deno.test("mermaid diagrams use emojis for visual engagement", () => {
  const content = loadReadme();
  const blocks = extractMermaidBlocks(content);
  const allDiagrams = blocks.join("\n");

  // Check for at least some emoji usage across all diagrams
  const emojiPattern = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  assertEquals(
    emojiPattern.test(allDiagrams),
    true,
    "Mermaid diagrams should use emojis for visual engagement",
  );
});
