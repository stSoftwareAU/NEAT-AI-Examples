/**
 * Tests for the streaming-vs-batch FAQ section in `snake_game/README.md`
 * (issue #128).
 *
 * The Snake README must answer the four conceptual questions raised in
 * issue #125 inline so readers who arrive at the canonical worked example
 * find the streaming-observation explanation where they would naturally
 * look.
 *
 * These are "what" tests — they read the README file and verify the
 * structural elements and the four answers the issue requires.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const README_PATH = "snake_game/README.md";

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/** Slice of the FAQ section: from the FAQ heading through to the next H2. */
function faqSlice(): string {
  const content = loadReadme();
  const headingRe = /^##\s+.*FAQ.*$/im;
  const m = content.match(headingRe);
  if (!m) return "";
  const start = content.indexOf(m[0]);
  const rest = content.slice(start + m[0].length);
  const nextHeading = rest.match(/^##\s+/m);
  const end = nextHeading ? start + m[0].length + (nextHeading.index ?? 0) : content.length;
  return content.slice(start, end);
}

/* ------------------------------------------------------------------ */
/*  FAQ section exists                                                 */
/* ------------------------------------------------------------------ */

Deno.test("snake_game/README.md has a FAQ section heading", () => {
  const content = loadReadme();
  assertEquals(
    /^##\s+.*FAQ.*$/im.test(content),
    true,
    "snake_game/README.md should have a FAQ section heading",
  );
});

Deno.test("FAQ section sits before the Tacit Knowledge section", () => {
  const content = loadReadme();
  const faqMatch = content.match(/^##\s+.*FAQ.*$/im);
  const tacitMatch = content.match(/^##\s+.*Tacit Knowledge.*$/im);
  assertEquals(faqMatch !== null, true, "FAQ heading must exist");
  assertEquals(tacitMatch !== null, true, "Tacit Knowledge heading must exist");
  if (faqMatch && tacitMatch) {
    const faqIdx = content.indexOf(faqMatch[0]);
    const tacitIdx = content.indexOf(tacitMatch[0]);
    assertEquals(
      faqIdx < tacitIdx,
      true,
      "FAQ section should appear before Tacit Knowledge",
    );
  }
});

/* ------------------------------------------------------------------ */
/*  All four questions from issue #125 are present                     */
/* ------------------------------------------------------------------ */

Deno.test("FAQ covers question 1: stream of observations", () => {
  const slice = faqSlice();
  assertStringIncludes(
    slice.toLowerCase(),
    "stream of observations",
    "FAQ must answer the 'stream of observations' question",
  );
  // Names the streaming primitive.
  assertStringIncludes(
    slice,
    "Creature.activate",
    "FAQ should name `Creature.activate(input)` as the per-tick streaming primitive",
  );
});

Deno.test("FAQ covers question 2: how is this normally done", () => {
  const slice = faqSlice();
  assertStringIncludes(
    slice.toLowerCase(),
    "how is this normally done",
    "FAQ should pose the 'how is this normally done' question",
  );
  assertStringIncludes(
    slice,
    "scoreController",
    "FAQ should reference the `scoreController` rollout loop",
  );
});

Deno.test("FAQ covers question 3: different observation stream per creature", () => {
  const slice = faqSlice();
  assertStringIncludes(
    slice.toLowerCase(),
    "different observation",
    "FAQ should answer 'does each creature get a different observation stream?'",
  );
  // Mentions the per-generation seed mechanism that keeps the comparison fair.
  assertEquals(
    /seed/i.test(slice),
    true,
    "FAQ should reference the per-generation seed that keeps comparisons fair",
  );
});

Deno.test("FAQ covers question 4: RL-shaped vs batch supervised", () => {
  const slice = faqSlice();
  assertEquals(
    /reinforcement.learning/i.test(slice),
    true,
    "FAQ should mention reinforcement-learning shape vs batch supervised",
  );
  // "20 GiB" or "training data" framing from issue #125.
  assertEquals(
    /training data|20\s?gib/i.test(slice),
    true,
    "FAQ should explicitly contrast with 'training data' batch framing",
  );
});

/* ------------------------------------------------------------------ */
/*  Cross-link to the top-level README paradigms section               */
/* ------------------------------------------------------------------ */

Deno.test("FAQ cross-links to the top-level README", () => {
  const slice = faqSlice();
  assertEquals(
    /\]\(\.\.\/README\.md(#[^\s)]*)?\)/.test(slice),
    true,
    "FAQ should include a relative link to ../README.md (optionally anchored)",
  );
});

/* ------------------------------------------------------------------ */
/*  Word-count budget — keep the section under ~400 words              */
/* ------------------------------------------------------------------ */

Deno.test("FAQ section stays under 400 words", () => {
  const slice = faqSlice();
  const words = slice.split(/\s+/).filter((w) => w.length > 0);
  assertEquals(
    words.length < 400,
    true,
    `FAQ section should stay under 400 words, found ${words.length}`,
  );
});
