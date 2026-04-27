/**
 * Tests for the "Related Repositories" section in README.md.
 *
 * Verifies that the canonical block defined in stSoftwareAU/NEAT-AI-core#18
 * has been inserted into the README and lists every public NEAT-AI-* repo
 * with a Mermaid dependency diagram.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const README_PATH = "README.md";

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/** Extract the content of the "## Related Repositories" section. */
function extractRelatedRepositoriesSection(content: string): string {
  const match = content.match(/## Related Repositories\n([\s\S]*?)(?=\n## |\n# |$)/);
  return match ? match[1] : "";
}

Deno.test("README.md contains a 'Related Repositories' section", () => {
  const content = loadReadme();
  assertStringIncludes(content, "## Related Repositories");
});

Deno.test("Related Repositories section lists all 7 NEAT-AI-* repos", () => {
  const section = extractRelatedRepositoriesSection(loadReadme());
  const required = [
    "NEAT-AI-core",
    "NEAT-AI-Discovery",
    "NEAT-AI-Snapshot",
    "NEAT-AI-scorer",
    "NEAT-AI-Explore",
    "NEAT-AI-Examples",
  ];
  for (const repo of required) {
    assertStringIncludes(section, repo, `Section should mention ${repo}`);
  }
  // NEAT-AI must be referenced (without -suffix); use word-boundary regex.
  const mentionsNeatAi = /NEAT-AI(?![-\w])/.test(section);
  assertEquals(mentionsNeatAi, true, "Section should mention the NEAT-AI engine repo");
});

Deno.test("Related Repositories section links to the GitHub repos", () => {
  const section = extractRelatedRepositoriesSection(loadReadme());
  const links = [
    "https://github.com/stSoftwareAU/NEAT-AI",
    "https://github.com/stSoftwareAU/NEAT-AI-core",
    "https://github.com/stSoftwareAU/NEAT-AI-Discovery",
    "https://github.com/stSoftwareAU/NEAT-AI-Snapshot",
    "https://github.com/stSoftwareAU/NEAT-AI-scorer",
    "https://github.com/stSoftwareAU/NEAT-AI-Explore",
    "https://github.com/stSoftwareAU/NEAT-AI-Examples",
  ];
  for (const link of links) {
    assertStringIncludes(section, link, `Section should link to ${link}`);
  }
});

Deno.test("Related Repositories section contains a Mermaid dependency diagram", () => {
  const section = extractRelatedRepositoriesSection(loadReadme());
  assertStringIncludes(section, "```mermaid", "Section should contain a Mermaid block");
  // Canonical diagram uses a graph TD declaration with the labelled nodes.
  assertStringIncludes(section, "graph TD");
  assertStringIncludes(section, "Deno FFI");
  assertStringIncludes(section, "path dependency");
});
