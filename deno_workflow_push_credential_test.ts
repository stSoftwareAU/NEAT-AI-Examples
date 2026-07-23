import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the auto-bump and security-update workflows push to PR branches
 * with the org `ACTIONS_PUSH` PAT rather than `GITHUB_TOKEN` (Issue #651).
 *
 * Root cause: a `GITHUB_TOKEN` push is attributed to `github-actions[bot]`,
 * which has no write access, so GitHub holds the resulting `pull_request`
 * check runs in `action_required` state until a maintainer clicks
 * "Approve and run". Pushing with a write-access PAT makes the
 * `synchronize` runs start automatically, matching the other stSoftwareAU
 * repos.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they
 * parse it and assert on its structure rather than grepping source text.
 */

const OUTDATED_PATH = ".github/workflows/deno-outdated.yml";
const SECURITY_PATH = ".github/workflows/deno-security-update.yml";

// deno-lint-ignore no-explicit-any
function readWorkflow(path: string): any {
  return parse(Deno.readTextFileSync(path));
}

// deno-lint-ignore no-explicit-any
function stepByRun(steps: any[], needle: string): any {
  return steps.find((s) => typeof s.run === "string" && s.run.includes(needle));
}

// deno-lint-ignore no-explicit-any
function stepByName(steps: any[], needle: string): any {
  return steps.find((s) => typeof s.name === "string" && s.name.includes(needle));
}

// Issue #678 narrowed where the PAT lives: it is no longer handed to
// `actions/checkout` (which would persist it in the workspace while
// PR-authored `bump-deps.sh` runs) but supplied to the push step alone.
// The #651 guarantee is unchanged — the push is still a PAT push, never a
// GITHUB_TOKEN one — so this test now asserts it on the push step.
Deno.test("deno-outdated pushes the bump commit with the ACTIONS_PUSH PAT", () => {
  const wf = readWorkflow(OUTDATED_PATH);
  const steps = wf.jobs["auto-bump"].steps;
  const push = stepByRun(steps, "git push");
  assert(push, "Expected a step that pushes the bump commit");
  const token = JSON.stringify(push.env ?? {}) + String(push.run);
  assert(
    token.includes("ACTIONS_PUSH"),
    `Expected the push to use the ACTIONS_PUSH PAT, got: ${token}`,
  );
  assert(
    !token.includes("GITHUB_TOKEN"),
    "The push must not fall back to GITHUB_TOKEN — that push is what stalls the checks",
  );
});

Deno.test("deno-outdated drops the unreliable re-dispatch workaround", () => {
  const wf = readWorkflow(OUTDATED_PATH);
  const steps = wf.jobs["auto-bump"].steps;
  assertEquals(
    stepByName(steps, "Re-dispatch required checks"),
    undefined,
    "The workflow_dispatch re-dispatch step must be removed — a PAT push triggers checks directly",
  );
});

// Issue #679 narrowed the GITHUB_TOKEN grant further. The #651 push moved
// entirely onto the ACTIONS_PUSH PAT, so `contents: write` was never
// exercised by any step and is now `contents: read`. The original intent of
// this test — no `actions: write` after the re-dispatch step was removed —
// is unchanged; the contents assertion tracks the least-privilege grant.
// Least-privilege coverage lives in deno_workflow_permission_scope_test.ts.
Deno.test("deno-outdated no longer requests actions: write", () => {
  const wf = readWorkflow(OUTDATED_PATH);
  const perms = wf.permissions;
  assertEquals(
    perms.contents,
    "read",
    "The bump commit is pushed with the PAT, so GITHUB_TOKEN needs read only (#679)",
  );
  assert(
    !("actions" in perms),
    "actions: write was only needed for the removed re-dispatch step",
  );
});

Deno.test("deno-outdated keeps the same-repo fork guard", () => {
  const wf = readWorkflow(OUTDATED_PATH);
  const guard = String(wf.jobs["auto-bump"].if);
  assert(
    guard.includes("github.event.pull_request.head.repo.full_name == github.repository"),
    "Fork PRs must stay excluded so external contributions still require approval",
  );
});

// See the #678 note above — the PAT moved from checkout to the push step.
Deno.test("deno-security-update pushes the advisory branch with the ACTIONS_PUSH PAT", () => {
  const wf = readWorkflow(SECURITY_PATH);
  const steps = wf.jobs["security-update"].steps;
  const push = stepByRun(steps, "git push");
  assert(push, "Expected a step that pushes the advisory branch");
  const token = JSON.stringify(push.env ?? {}) + String(push.run);
  assert(
    token.includes("ACTIONS_PUSH"),
    `Expected the push to use the ACTIONS_PUSH PAT, got: ${token}`,
  );
  assert(
    !token.includes("GITHUB_TOKEN"),
    "The push must not use GITHUB_TOKEN — the advisory branch push must trigger checks",
  );
});

Deno.test("deno-security-update opens its PR with the ACTIONS_PUSH PAT", () => {
  const wf = readWorkflow(SECURITY_PATH);
  const prStep = stepByName(wf.jobs["security-update"].steps, "Open security-update PR");
  assert(prStep, "Expected the Open security-update PR step");
  const ghToken = String(prStep.env.GH_TOKEN);
  assert(
    ghToken.includes("ACTIONS_PUSH"),
    `Expected gh pr create to authenticate with ACTIONS_PUSH, got: ${ghToken}`,
  );
  assert(
    !ghToken.includes("GITHUB_TOKEN"),
    "A GITHUB_TOKEN-opened PR does not trigger its own checks",
  );
});
