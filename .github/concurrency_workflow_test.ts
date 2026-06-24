// Tests for .github/workflows/*.yml concurrency groups (Issue #554).
//
// Without a top-level `concurrency:` block, rapid pushes to a pull
// request (or to `Develop`) start a fresh run for every commit and let
// superseded runs continue to completion — wasting runner minutes and
// risking out-of-order landings. A concurrency group keyed on the
// workflow and ref with `cancel-in-progress: true` cancels the older
// run as soon as a newer commit arrives.
//
// `deno-outdated.yml` pushes commits back to the PR head branch, so it
// uses `cancel-in-progress: false` to avoid interrupting an in-flight
// auto-bump push mid-commit

import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

// deno-lint-ignore no-explicit-any
type Workflow = any;

const WORKFLOW_DIR = new URL("./workflows/", import.meta.url);

// Expected group expression for every workflow.
const EXPECTED_GROUP = "${{ github.workflow }}-${{ github.ref }}";

// Workflows that should cancel superseded runs immediately.
const CANCEL_WORKFLOWS = [
  "actionlint.yml",
  "dependency-review.yml",
  "gitleaks.yml",
  "markdown-lint.yml",
  "quality.yml",
  "semgrep.yml",
  "shellcheck.yml",
];

// Workflows that must NOT cancel in progress (push commits back to PR head).
const NO_CANCEL_WORKFLOWS = [
  "deno-outdated.yml",
  // Pushes a branch and opens a PR; must not be interrupted mid-commit.
  "deno-security-update.yml",
];

async function loadWorkflow(name: string): Promise<Workflow> {
  const path = new URL(name, WORKFLOW_DIR);
  const text = await Deno.readTextFile(path);
  return parse(text) as Workflow;
}

function concurrency(wf: Workflow): Record<string, unknown> | undefined {
  // deno-lint-ignore no-explicit-any
  const w = wf as Record<string, any>;
  return w.concurrency as Record<string, unknown> | undefined;
}

for (const wf of [...CANCEL_WORKFLOWS, ...NO_CANCEL_WORKFLOWS]) {
  Deno.test(`${wf} — declares a ref-keyed concurrency group`, async () => {
    const doc = await loadWorkflow(wf);
    const conc = concurrency(doc);

    assert(
      conc !== undefined,
      `${wf}: missing top-level concurrency block`,
    );
    assertEquals(
      conc.group,
      EXPECTED_GROUP,
      `${wf}: concurrency.group must be "${EXPECTED_GROUP}"`,
    );
  });
}

for (const wf of CANCEL_WORKFLOWS) {
  Deno.test(`${wf} — cancels superseded runs`, async () => {
    const doc = await loadWorkflow(wf);
    const conc = concurrency(doc);
    assert(conc !== undefined, `${wf}: missing concurrency block`);
    assertEquals(
      conc["cancel-in-progress"],
      true,
      `${wf}: cancel-in-progress must be true`,
    );
  });
}

for (const wf of NO_CANCEL_WORKFLOWS) {
  Deno.test(`${wf} — does NOT cancel in-flight auto-bump pushes`, async () => {
    const doc = await loadWorkflow(wf);
    const conc = concurrency(doc);
    assert(conc !== undefined, `${wf}: missing concurrency block`);
    assertEquals(
      conc["cancel-in-progress"],
      false,
      `${wf}: cancel-in-progress must be false so auto-bump pushes ` +
        `are not interrupted mid-commit`,
    );
  });
}
