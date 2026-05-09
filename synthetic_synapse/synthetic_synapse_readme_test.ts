/**
 * "What" tests for the synthetic-synapse README terminology
 * (issue #188).
 *
 * The README must clearly distinguish textbook NEAT (Stanley &
 * Miikkulainen 2002) from NEAT-AI's enhanced behaviour, so the
 * "Vanilla NEAT struggles at scale" framing can no longer mislead
 * readers into thinking NEAT-AI itself struggles at scale.
 *
 * These tests load the README at runtime and assert on its contents
 * — they do not inspect any source-level implementation detail.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const README_PATH = "synthetic_synapse/README.md";
const COMPARISON_URL = "https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md";

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

Deno.test("synthetic_synapse README - drops bare 'Vanilla NEAT' and 'Pure NEAT' wording", () => {
  const content = loadReadme();
  // The contrast is with NEAT-AI's behaviour, so any unqualified
  // "Vanilla NEAT" or "Pure NEAT" framing must be gone.
  assertEquals(
    content.includes("Vanilla NEAT"),
    false,
    "README should no longer use the phrase 'Vanilla NEAT'",
  );
  assertEquals(
    content.includes("Pure NEAT"),
    false,
    "README should no longer use the phrase 'Pure NEAT'",
  );
});

Deno.test("synthetic_synapse README - uses 'textbook NEAT' framing with the canonical citation", () => {
  const content = loadReadme();
  // Lower-cased so we match both prose and table-header forms.
  const lower = content.toLowerCase();
  assertStringIncludes(
    lower,
    "textbook neat",
    "README should use the explicit 'textbook NEAT' framing",
  );
  // The Stanley & Miikkulainen citation pins what 'textbook NEAT'
  // means and keeps the contrast unambiguous.
  assertStringIncludes(
    content,
    "Stanley",
    "README should cite Stanley & Miikkulainen 2002 to anchor 'textbook NEAT'",
  );
  assertStringIncludes(
    content,
    "2002",
    "README should cite the 2002 NEAT paper alongside Stanley",
  );
});

Deno.test("synthetic_synapse README - renames the comparison column to 'Textbook NEAT'", () => {
  const content = loadReadme();
  // The "Pure NEAT vs Synthetic-synapse training" comparison table
  // is the cleanest visual of why the technique matters; only the
  // column header changes.
  assertStringIncludes(
    content,
    "| Textbook NEAT",
    "Comparison table should rename the 'Pure NEAT' column to 'Textbook NEAT'",
  );
  assertStringIncludes(
    content,
    "Synthetic-synapse training",
    "Comparison table contrasting textbook NEAT with synthetic-synapse training should remain",
  );
});

Deno.test("synthetic_synapse README - lists at least three other NEAT-AI scaling techniques with upstream links", () => {
  const content = loadReadme();
  // The 'Why does NEAT-AI need this?' section must call out the
  // other NEAT-AI features that target the same scaling failure
  // mode, so readers do not walk away thinking synthetic synapses
  // are the only mitigation NEAT-AI ships.
  const start = content.search(/^##\s+.*Why does NEAT-AI need this/m);
  assert(start >= 0, "README must contain a 'Why does NEAT-AI need this?' heading");
  const tail = content.slice(start);
  const nextH2 = tail.slice(1).search(/^##\s+/m);
  const section = nextH2 < 0 ? tail : tail.slice(0, nextH2 + 1);
  const lower = section.toLowerCase();

  // At least three other NEAT-AI techniques addressing the same
  // scaling failure mode must be named in this section.
  const techniques = [
    "gpu-accelerated discovery",
    "memetic evolution",
    "mcmc",
    "adaptive mutation",
    "advanced breeding",
  ];
  let mentioned = 0;
  for (const t of techniques) {
    if (lower.includes(t)) mentioned++;
  }
  assert(
    mentioned >= 3,
    `Expected at least three of ${
      techniques.join(", ")
    } to be mentioned, but only ${mentioned} were found`,
  );

  // The section must link to upstream COMPARISON.md so each
  // technique is anchored to the canonical feature description.
  assertStringIncludes(
    section,
    COMPARISON_URL,
    "Why-does-NEAT-AI-need-this section should link to upstream COMPARISON.md",
  );
});

Deno.test("synthetic_synapse README - cites the COMPARISON.md anchors for the listed techniques", () => {
  const content = loadReadme();
  // Each NEAT-AI technique we cite for the scaling failure mode
  // should point at its specific COMPARISON.md anchor, not just
  // the page root, so readers can jump straight to the relevant
  // feature description.
  const expectedAnchors = [
    "COMPARISON.md#1--memetic-evolution",
    "COMPARISON.md#2--error-guided-structural-evolution",
    "COMPARISON.md#9--mcmc-mutation-acceptance",
  ];
  for (const anchor of expectedAnchors) {
    assertStringIncludes(
      content,
      anchor,
      `README should link to '${anchor}' for the corresponding NEAT-AI feature`,
    );
  }
});
