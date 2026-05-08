/**
 * Tests for the no-warm-start policy documentation (issue #147).
 *
 * The no-warm-start policy says: in-scope examples must start evolution from
 * uniform-random noise — no pretrained champion, no hand-crafted topology, no
 * resumed checkpoint. This is enforced by review and agent instructions, not
 * by a CI test on source code (that would be a "how" test).
 *
 * These tests are "what" tests — they verify the policy is _documented_ in
 * the right places: AGENTS.md, the root README.md, and each in-scope
 * example's README. They do NOT inspect source code for warm-start patterns.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const IN_SCOPE_EXAMPLES = [
  "xor_classification",
  "cart_pole",
  "snake_game",
  "mnist_classification",
  "stock_market",
  "lunar_lander",
  "mountain_car",
  "maze_navigation",
] as const;

const EXEMPT_EXAMPLES = [
  "crispr_injection",
  "neuron_pruning",
  "discovery",
  "discovery_at_scale",
  "intelligent_design",
  "crossover",
  "memetic_evolution",
  "mcmc_acceptance",
  "synthetic_synapse",
  "adaptive_mutation",
  "evolution_showcase",
] as const;

/* ------------------------------------------------------------------ */
/*  AGENTS.md: the "No warm starts" section                            */
/* ------------------------------------------------------------------ */

Deno.test("AGENTS.md has a 'No warm starts' section heading", () => {
  const content = Deno.readTextFileSync("AGENTS.md");
  assertEquals(
    /^##\s+.*No warm starts/im.test(content),
    true,
    "AGENTS.md should contain a 'No warm starts' section heading",
  );
});

Deno.test("AGENTS.md defines what a warm start is", () => {
  const content = Deno.readTextFileSync("AGENTS.md");
  assertStringIncludes(
    content,
    "pretrained",
    "AGENTS.md should call out pretrained champions as a warm-start form",
  );
  assertStringIncludes(
    content,
    "hand-crafted",
    "AGENTS.md should call out hand-crafted starting state as a warm-start form",
  );
  assertStringIncludes(
    content,
    "checkpoint",
    "AGENTS.md should call out resumed checkpoints as a warm-start form",
  );
});

Deno.test("AGENTS.md tells the noise -> competent narrative", () => {
  const content = Deno.readTextFileSync("AGENTS.md");
  assertStringIncludes(
    content.toLowerCase(),
    "noise",
    "AGENTS.md should describe gen 1 as noise",
  );
});

for (const dir of IN_SCOPE_EXAMPLES) {
  Deno.test(`AGENTS.md lists ${dir} as an in-scope example`, () => {
    const content = Deno.readTextFileSync("AGENTS.md");
    assertStringIncludes(
      content,
      dir,
      `AGENTS.md should list ${dir} under the no-warm-start policy`,
    );
  });
}

for (const dir of EXEMPT_EXAMPLES) {
  Deno.test(`AGENTS.md lists ${dir} as exempt from the no-warm-start policy`, () => {
    const content = Deno.readTextFileSync("AGENTS.md");
    assertStringIncludes(
      content,
      dir,
      `AGENTS.md should list ${dir} as an exempt example`,
    );
  });
}

Deno.test("AGENTS.md notes the policy is enforced by review, not by a CI test", () => {
  const content = Deno.readTextFileSync("AGENTS.md");
  assertStringIncludes(
    content.toLowerCase(),
    "review",
    "AGENTS.md should note that the no-warm-start policy is enforced by review",
  );
});

/* ------------------------------------------------------------------ */
/*  Root README: noise -> competent narrative                          */
/* ------------------------------------------------------------------ */

Deno.test("README.md introduces the noise -> competent narrative", () => {
  const content = Deno.readTextFileSync("README.md").toLowerCase();
  assertStringIncludes(
    content,
    "noise",
    "README.md should mention that in-scope examples start from random noise",
  );
});

/* ------------------------------------------------------------------ */
/*  Per-example READMEs: one-line warm-start statement                 */
/* ------------------------------------------------------------------ */

for (const dir of IN_SCOPE_EXAMPLES) {
  Deno.test(`${dir}/README.md states gen 1 starts from random noise`, () => {
    const content = Deno.readTextFileSync(`${dir}/README.md`).toLowerCase();
    assertStringIncludes(
      content,
      "random noise",
      `${dir}/README.md should include a one-line statement that generation 1 starts from random noise`,
    );
  });
}
