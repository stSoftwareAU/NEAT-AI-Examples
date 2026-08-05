// Tests for .github/workflows/deno-outdated.yml (Issue #362, #364, #651).
//
// The workflow must:
//  * trigger only on `pull_request` to Develop (no weekly cron — #364);
//  * run `bump-deps.sh` and, when pins drift, COMMIT and PUSH the bump
//    back to the PR head branch so dependencies are updated
//    automatically (#362) — not just warned about;
//  * skip the auto-bump for PRs from forks (push would fail without a
//    privileged token);
//  * request `contents: write` so the push succeeds; and
//  * push with the org `ACTIONS_PUSH` PAT so the bumped commit
//    re-triggers the `pull_request` checks automatically instead of
//    leaving them held in `action_required` (#651). Because the PAT push
//    is a write-access event, no `workflow_dispatch` re-dispatch and no
//    `actions: write` are needed — both removed under #651. The PAT is
//    scoped to the push step alone and never persisted in the workspace
//    while PR-controlled `bump-deps.sh` runs (#678).

import { assert, assertEquals, assertExists } from "@std/assert";
import { loadWorkflow, triggers } from "./workflow_test_utils.ts";

const WORKFLOW = "deno-outdated.yml";

// Since #747 the bump and the secret-bearing push live in separate jobs
// (`auto-bump` / `push-bump`) so no PR-authored `$GITHUB_PATH` mutation is
// in scope when the PAT is used. The invariants below are about the
// workflow as a whole, so they sweep every job's steps rather than one.
// deno-lint-ignore no-explicit-any
function allSteps(wf: any): Array<Record<string, unknown>> {
  const jobs = (wf.jobs ?? {}) as Record<string, { steps?: unknown }>;
  return Object.values(jobs).flatMap((j) => (j?.steps ?? []) as Array<Record<string, unknown>>);
}

Deno.test("deno-outdated workflow — triggers only on pull_request to Develop", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assertExists(t, "workflow must declare triggers");
  assertExists(t.pull_request, "must trigger on pull_request");
  const pr = t.pull_request as { branches?: string[] };
  assertEquals(pr.branches, ["Develop"], "pull_request must target Develop");
});

Deno.test("deno-outdated workflow — does NOT run on a weekly cron schedule (#364)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assertEquals(
    Object.prototype.hasOwnProperty.call(t, "schedule"),
    false,
    "Issue #364 forbids weekly bot dependency PRs — no `schedule:` trigger allowed.",
  );
});

Deno.test("deno-outdated workflow — auto-bump job grants GITHUB_TOKEN read-only contents", async () => {
  // Business-logic change (#679): the bump commit is pushed with the org
  // ACTIONS_PUSH PAT via an explicit remote URL (#651), never with
  // GITHUB_TOKEN, so the old `contents: write` grant was capability handed
  // to PR-authored `bump-deps.sh` for zero functional benefit. This test
  // previously asserted "write"; it now pins the least-privilege grant.
  const wf = await loadWorkflow(WORKFLOW);
  // Either job-level or workflow-level permissions must grant read.
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const jobNames = Object.keys(jobs);
  assert(jobNames.length >= 1, "must declare at least one job");
  const job = jobs[jobNames[0]];
  const jobPerms = (job.permissions ?? {}) as Record<string, string>;
  const wfPerms = (wf.permissions ?? {}) as Record<string, string>;
  const contents = jobPerms.contents ?? wfPerms.contents;
  assertEquals(contents, "read", "auto-bump only reads with GITHUB_TOKEN — the checkout fetch");
});

Deno.test("deno-outdated workflow — does NOT request actions:write (re-dispatch removed, #651)", async () => {
  // Business-logic change (#651): the ACTIONS_PUSH PAT push re-triggers the
  // `pull_request` checks by itself, so the `workflow_dispatch` re-dispatch
  // step is gone and the `actions: write` permission it required must not be
  // granted (principle of least privilege).
  const wf = await loadWorkflow(WORKFLOW);
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const job = jobs[Object.keys(jobs)[0]];
  const jobPerms = (job.permissions ?? {}) as Record<string, string>;
  const wfPerms = (wf.permissions ?? {}) as Record<string, string>;
  const actions = jobPerms.actions ?? wfPerms.actions;
  assertEquals(
    actions,
    undefined,
    "auto-bump no longer re-dispatches CI, so it must not request actions: write (#651)",
  );
});

Deno.test("deno-outdated workflow — skips PRs from forks", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const job = jobs[Object.keys(jobs)[0]];
  const guard = String(job.if ?? "");
  assert(
    guard.includes("head.repo.full_name") && guard.includes("github.repository"),
    `job must guard against fork PRs via head.repo.full_name == github.repository, got: ${guard}`,
  );
});

Deno.test("deno-outdated workflow — pins VIBE_BUMP_QUARANTINE_HOURS so the supply-chain policy is auditable (#441)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const job = jobs[Object.keys(jobs)[0]];
  const jobEnv = (job.env ?? {}) as Record<string, string>;
  const wfEnv = (wf.env ?? {}) as Record<string, string>;
  const value = jobEnv.VIBE_BUMP_QUARANTINE_HOURS ?? wfEnv.VIBE_BUMP_QUARANTINE_HOURS;
  assertExists(
    value,
    "auto-bump must pin VIBE_BUMP_QUARANTINE_HOURS so the supply-chain quarantine window is visible in CI config",
  );
  // The value is either a plain number or an auditable override expression
  // of the form `${{ inputs.quarantine_hours || '24' }}` (Issue #603). In
  // both cases the effective default (the value used on an ordinary PR run,
  // where the dispatch input is empty) must be a non-negative number.
  const overrideMatch = value.match(/\|\|\s*'?(\d+(?:\.\d+)?)'?\s*}}/);
  const effectiveDefault = overrideMatch ? overrideMatch[1] : value;
  const n = Number(effectiveDefault);
  assert(
    Number.isFinite(n) && n >= 0,
    `VIBE_BUMP_QUARANTINE_HOURS default must be a non-negative number, got: ${value}`,
  );
});

Deno.test("deno-outdated workflow — auto-bump runs bump-deps.sh and commits the result", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const steps = allSteps(wf);

  // bump-deps.sh must be invoked.
  const bump = steps.find((s) =>
    typeof s.run === "string" && (s.run as string).includes("bump-deps.sh")
  );
  assertExists(bump, "auto-bump must invoke bump-deps.sh");

  // The changes must be committed and pushed (signals the auto-update, not
  // just a warning). Since Issue #747 the bump and the commit/push live in
  // separate jobs: the PAT-bearing job runs on a fresh runner once the
  // PR-controlled bump script has finished, so the credential is never
  // readable from the workspace nor reachable via `$GITHUB_PATH`.
  const commit = steps.find((s) => String(s.run ?? "").includes("git commit"));
  assertExists(commit, "auto-bump must commit the dependency updates");
  const push = steps.find((s) => String(s.run ?? "").includes("git push"));
  assertExists(push, "auto-bump must push the dependency updates");

  // Checkout must use the PR head ref so the push targets the PR branch.
  const checkout = steps.find((s) =>
    typeof s.uses === "string" && (s.uses as string).startsWith("actions/checkout@")
  );
  assertExists(checkout, "must check out the PR head");
  const cwith = checkout.with as Record<string, unknown>;
  // On a pull_request run the checkout must target the PR head ref/repo so
  // bump commits go back to the PR branch. A manual emergency dispatch has
  // no PR context, so an auditable fallback to the dispatched ref/repository
  // is permitted (Issue #603) — assert the PR-head reference is present
  // rather than requiring an exact, fallback-free string.
  assert(
    String(cwith.ref ?? "").includes("github.event.pull_request.head.ref"),
    `checkout must target the PR head ref so commits go back to the PR branch, got: ${cwith.ref}`,
  );
  assert(
    String(cwith.repository ?? "").includes(
      "github.event.pull_request.head.repo.full_name",
    ),
    `checkout must target the PR head repository, got: ${cwith.repository}`,
  );

  // checkout must be pinned to a 40-char SHA per supply-chain policy.
  const sha = (checkout.uses as string).split("@")[1].split(" ")[0];
  assertEquals(sha.length, 40, `actions/checkout must be pinned to a 40-char SHA, got "${sha}"`);
});

Deno.test("deno-outdated workflow — commits both deno.json and deno.lock (#418)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const steps = allSteps(wf);

  const bump = steps.find((s) => s.id === "bump");
  assertExists(bump, "bump step must expose the bump logic via id: bump");
  // The bump step decides whether either manifest drifted; the commit
  // itself lives in the separate push job since #747, so assert both.
  assert(
    String(bump.run ?? "").includes("deno.json deno.lock"),
    "bump step must consider both deno.json and deno.lock (issue #418)",
  );
  const commit = steps.find((s) => String(s.run ?? "").includes("git add deno.json deno.lock"));
  assertExists(commit, "the bump must commit both deno.json and deno.lock (issue #418)");
});

Deno.test("deno-outdated workflow — does NOT re-dispatch checks (PAT push re-triggers them, #651)", async () => {
  // Business-logic change (#651): pushing the bump with the ACTIONS_PUSH PAT
  // is a write-access event, so the `pull_request` checks re-run on the
  // bumped commit automatically. The old `workflow_dispatch` re-dispatch
  // workaround (#485) was unreliable (Semgrep/Gitleaks/Dependency Review
  // failed outside PR context) and is removed.
  const wf = await loadWorkflow(WORKFLOW);
  const steps = allSteps(wf);

  const redispatch = steps.find((s) =>
    typeof s.run === "string" && (s.run as string).includes("gh workflow run")
  );
  assertEquals(
    redispatch,
    undefined,
    "the re-dispatch step must be removed — the ACTIONS_PUSH push re-triggers checks (#651)",
  );
});

// Business-logic change (#678): the PAT is no longer handed to
// `actions/checkout` — that persisted it in `.git/config` for the whole
// job, including while PR-authored `bump-deps.sh` ran. The #651 guarantee
// is unchanged (the push is still a PAT push, so the checks re-trigger);
// only the step that holds the credential moved.
Deno.test("deno-outdated workflow — pushes with the ACTIONS_PUSH PAT so the bump re-triggers checks (#651)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const steps = allSteps(wf);

  const push = steps.find((s) => String(s.run ?? "").includes("git push"));
  assertExists(push, "must push the bump commit");
  const scope = JSON.stringify(push.env ?? {}) + String(push.run ?? "");
  assert(
    scope.includes("secrets.ACTIONS_PUSH"),
    `the push must use the ACTIONS_PUSH PAT so the bumped commit re-triggers ` +
      `the pull_request checks, got: ${scope}`,
  );

  const checkouts = steps.filter((s) =>
    typeof s.uses === "string" && (s.uses as string).startsWith("actions/checkout@")
  );
  assert(checkouts.length > 0, "must check out the PR head");
  for (const checkout of checkouts) {
    const cwith = (checkout.with ?? {}) as Record<string, unknown>;
    assertEquals(
      cwith.token,
      undefined,
      "checkout must not receive the PAT — it would be persisted while PR code runs (#678)",
    );
  }
});
