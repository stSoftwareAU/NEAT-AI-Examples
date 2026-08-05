// Tests for .github/workflows/markdown-lint.yml (Issue #435).
//
// The Markdown Lint workflow must trigger on push to the repository's
// default branch (`Develop`) as well as on every pull request. Without
// the `Develop` entry in the push trigger list, the workflow does not
// automatically run after a PR is merged into `Develop`, so drift
// introduced by a merge commit is never linted — the bug reported in
// Issue #435.

import { assert, assertExists } from "@std/assert";
import { loadWorkflow, triggers } from "./workflow_test_utils.ts";

const WORKFLOW = "markdown-lint.yml";

Deno.test("markdown-lint workflow — triggers on push to Develop", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assertExists(t, "workflow must declare triggers");
  const push = t.push as { branches?: string[] } | undefined;
  assertExists(push, "workflow must trigger on push");
  assertExists(push.branches, "push trigger must declare branches");
  assert(
    push.branches.includes("Develop"),
    `push trigger must include the default branch 'Develop' so the workflow runs after merges (got ${
      JSON.stringify(push.branches)
    })`,
  );
});

Deno.test("markdown-lint workflow — triggers on pull_request to any branch", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  const pr = t.pull_request as { branches?: string[] } | undefined;
  assertExists(pr, "workflow must trigger on pull_request");
  assertExists(pr.branches, "pull_request trigger must declare branches");
  assert(
    pr.branches.includes("*") || pr.branches.includes("**"),
    `pull_request must run for PRs against any branch (got ${JSON.stringify(pr.branches)})`,
  );
});

// Issue #442 — supply-chain hardening. The previous step
// `npm install -g markdownlint-cli2` resolved `latest` from npm on every
// CI run, undoing the 40-char SHA pins on the surrounding actions. The
// install must pin the package to an exact version (matching the pin
// pattern `<name>@<version>`), so an attacker who compromises the
// package cannot ship malicious bytes into the next PR run.
Deno.test("markdown-lint workflow — markdownlint-cli2 install is version-pinned (#442)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const job = jobs[Object.keys(jobs)[0]];
  const steps = job.steps as Array<Record<string, unknown>>;

  // Find every shell step that installs markdownlint-cli2 (covers
  // `npm install`, `npm i`, and `npx --package=...` forms).
  const installSteps = steps.filter((s) => {
    const run = String(s.run ?? "");
    return run.includes("markdownlint-cli2") &&
      (run.includes("npm install") || run.includes("npm i ") ||
        run.includes("npx"));
  });

  assert(
    installSteps.length > 0,
    "workflow must install markdownlint-cli2 via npm/npx",
  );

  // Match an exact-version pin like `markdownlint-cli2@0.18.1`. Reject
  // tag specifiers (`@latest`, `@next`), range specifiers (`@^1.0.0`,
  // `@~1.2`, `@>=1`), and bare names with no `@<version>` at all.
  const pinPattern = /markdownlint-cli2@\d+\.\d+\.\d+(?:[-+][\w.-]+)?/;
  for (const step of installSteps) {
    const run = String(step.run);
    assert(
      pinPattern.test(run),
      `install step must pin markdownlint-cli2 to an exact version (got: ${run.trim()})`,
    );
    // Defence in depth — reject obvious mutable specifiers even if a
    // pinned version is also present somewhere in the same line.
    assert(
      !/markdownlint-cli2@latest\b/.test(run),
      `install step must not reference markdownlint-cli2@latest (got: ${run.trim()})`,
    );
    assert(
      !/markdownlint-cli2@next\b/.test(run),
      `install step must not reference markdownlint-cli2@next (got: ${run.trim()})`,
    );
  }
});
