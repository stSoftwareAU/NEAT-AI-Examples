// Tests for .github/workflows/markdown-lint.yml (Issue #435).
//
// The Markdown Lint workflow must trigger on push to the repository's
// default branch (`Develop`) as well as on every pull request. Without
// the `Develop` entry in the push trigger list, the workflow does not
// automatically run after a PR is merged into `Develop`, so drift
// introduced by a merge commit is never linted — the bug reported in
// Issue #435.

import { assert, assertEquals, assertExists } from "@std/assert";
import { loadWorkflow, triggers, type Workflow } from "./workflow_test_utils.ts";

const WORKFLOW = "markdown-lint.yml";

/** Every step of every job in the workflow. */
function allSteps(wf: Workflow): Array<Record<string, unknown>> {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  return Object.values(jobs).flatMap((job) => (job.steps ?? []) as Array<Record<string, unknown>>);
}

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

// Issue #814: `actions/checkout` writes the job's `GITHUB_TOKEN` into
// `.git/config` as an auth header unless `persist-credentials: false` is set.
// The `markdownlint` job only reads the checked-out Markdown — it never pushes
// and fetches no private submodule — so the persisted credential buys nothing
// and any later step (a compromised npm package, an injected script) could read
// it back and act as the token.
Deno.test("markdown-lint workflow — checkout does not persist a credential in the workspace", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const checkouts = allSteps(wf).filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(checkouts.length > 0, "expected at least one actions/checkout step");
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job never ` +
        `pushes, so the GITHUB_TOKEN must not be left readable in .git/config`,
    );
  }
});

Deno.test("markdown-lint workflow — no step pushes back to the repository", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  for (const step of allSteps(wf)) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #814 fix before allowing this`,
    );
  }
});
