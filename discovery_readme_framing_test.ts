/**
 * Tests for the science-driven structural mutation framing on Discovery
 * READMEs (issue #189).
 *
 * `discovery/README.md` previously sat under the same framing, but the
 * audit (issue #207) repurposed that example to evolve from a minimal
 * NEAT seed via `Creature.evolveDir(...)` — i.e. random mutation —
 * rather than `discoveryDir(...)`.
 *
 * `discovery_at_scale/README.md` was reframed in the same way by the
 * audit (issue #208), so it too is excluded from the science-driven
 * framing rules below. Holding either README to the science-driven
 * framing would now contradict the audit.
 *
 * No README in this repository currently uses the science-driven
 * framing, so the structural assertions below run over an empty set —
 * but the test scaffolding is retained so future Discovery-flow
 * examples can opt back in by adding their path to {@link README_PATHS}.
 *
 * These are "what" tests — they read the README files and check the
 * required structural elements without inspecting implementation.
 */

import { assert, assertStringIncludes } from "@std/assert";

const README_PATHS: Record<string, string> = {
  // No examples currently use the science-driven framing — see audits
  // #207 (discovery) and #208 (discovery_at_scale).
};

const COMPARISON_URL = "https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md";

function loadReadme(path: string): string {
  return Deno.readTextFileSync(path);
}

/** Extract mermaid code blocks from markdown content. */
function extractMermaidBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * Return the prose between the first H1 and the first H2 — the
 * "top-level paragraph" the issue requires.
 */
function topLevelIntro(content: string): string {
  const h1 = content.search(/^#\s+/m);
  if (h1 < 0) return "";
  const after = content.slice(h1);
  const nextH2 = after.search(/^##\s+/m);
  return nextH2 < 0 ? after : after.slice(0, nextH2);
}

for (const [name, path] of Object.entries(README_PATHS)) {
  Deno.test(`${name} README opens with science-driven structural mutation framing`, () => {
    const intro = topLevelIntro(loadReadme(path)).toLowerCase();
    // The intro must say Discovery is error-driven, not random.
    for (
      const phrase of [
        "error-driven",
        "structural mutation",
        "not random",
      ]
    ) {
      assertStringIncludes(
        intro,
        phrase,
        `${path} intro should mention "${phrase}"`,
      );
    }
    // The reporter's exact framing must appear verbatim somewhere in the intro.
    assertStringIncludes(
      intro,
      "science-driven structural mutation",
      `${path} intro should use the phrase "science-driven structural mutation"`,
    );
  });

  Deno.test(`${name} README intro contrasts textbook NEAT random mutation`, () => {
    const intro = topLevelIntro(loadReadme(path)).toLowerCase();
    for (const term of ["textbook neat", "random"]) {
      assertStringIncludes(
        intro,
        term,
        `${path} intro should reference textbook NEAT random mutation (missing "${term}")`,
      );
    }
  });

  Deno.test(`${name} README intro mentions activation analysis vocabulary`, () => {
    const intro = topLevelIntro(loadReadme(path)).toLowerCase();
    // The activation distribution categories that drive Discovery's
    // structural decisions must be named.
    for (const term of ["saturated", "dead", "dormant", "bottleneck"]) {
      assertStringIncludes(
        intro,
        term,
        `${path} intro should mention activation category "${term}"`,
      );
    }
  });

  Deno.test(`${name} README links to upstream COMPARISON.md`, () => {
    const content = loadReadme(path);
    assertStringIncludes(
      content,
      COMPARISON_URL,
      `${path} should link to upstream COMPARISON.md`,
    );
    // Both feature 2 (error-driven mutation) and feature 8 (discovery
    // caching) must be cited explicitly.
    const lower = content.toLowerCase();
    assertStringIncludes(lower, "feature 2", `${path} should cite COMPARISON.md feature 2`);
    assertStringIncludes(lower, "feature 8", `${path} should cite COMPARISON.md feature 8`);
  });

  Deno.test(`${name} README has a Mermaid block contrasting random vs Discovery-driven mutation`, () => {
    const content = loadReadme(path);
    const blocks = extractMermaidBlocks(content);
    assert(blocks.length >= 1, `${path} should contain at least one mermaid block`);
    // At least one block must mention both "random" and "discovery-driven"
    // so the contrast is unambiguous.
    const hasContrast = blocks.some((b) => {
      const lower = b.toLowerCase();
      return lower.includes("random") && lower.includes("discovery-driven");
    });
    assert(
      hasContrast,
      `${path} should contain a Mermaid block contrasting random NEAT mutation with Discovery-driven mutation`,
    );
  });
}
