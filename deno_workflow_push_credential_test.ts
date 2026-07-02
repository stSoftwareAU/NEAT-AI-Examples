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
function stepByUses(steps: any[], needle: string): any {
  return steps.find((s) => typeof s.uses === "string" && s.uses.includes(needle));
}

// deno-lint-ignore no-explicit-any
function stepByName(steps: any[], needle: string): any {
  return steps.find((s) => typeof s.name === "string" && s.name.includes(needle));
}

Deno.test("deno-outdated checks out the PR head with the ACTIONS_PUSH PAT", () => {
  const wf = readWorkflow(OUTDATED_PATH);
  const checkout = stepByUses(wf.jobs["auto-bump"].steps, "actions/checkout");
  assert(checkout, "Expected an actions/checkout step");
  const token = String(checkout.with.token);
  assert(
    token.includes("ACTIONS_PUSH"),
    `Expected checkout to use the ACTIONS_PUSH PAT, got: ${token}`,
  );
  assert(
    !token.includes("GITHUB_TOKEN"),
    "Checkout must not fall back to GITHUB_TOKEN — that push is what stalls the checks",
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

Deno.test("deno-outdated no longer requests actions: write", () => {
  const wf = readWorkflow(OUTDATED_PATH);
  const perms = wf.permissions;
  assertEquals(
    perms.contents,
    "write",
    "Still needs contents: write to push the bump commit",
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

Deno.test("deno-security-update checks out with the ACTIONS_PUSH PAT", () => {
  const wf = readWorkflow(SECURITY_PATH);
  const checkout = stepByUses(wf.jobs["security-update"].steps, "actions/checkout");
  assert(checkout, "Expected an actions/checkout step");
  const token = String(checkout.with.token);
  assert(
    token.includes("ACTIONS_PUSH"),
    `Expected checkout to use the ACTIONS_PUSH PAT, got: ${token}`,
  );
  assert(
    !token.includes("GITHUB_TOKEN"),
    "Checkout must not use GITHUB_TOKEN — the advisory branch push must trigger checks",
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
