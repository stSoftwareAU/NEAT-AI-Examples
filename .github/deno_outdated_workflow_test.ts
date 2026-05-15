// Tests for .github/workflows/deno-outdated.yml (Issue #362, #364).
//
// The workflow must:
//  * trigger only on `pull_request` to Develop (no weekly cron — #364);
//  * run `bump-deps.sh` and, when pins drift, COMMIT and PUSH the bump
//    back to the PR head branch so dependencies are updated
//    automatically (#362) — not just warned about;
//  * skip the auto-bump for PRs from forks (push would fail without a
//    privileged token);
//  * request `contents: write` so the push succeeds.

import { assert, assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/deno-outdated.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

function triggers(wf: Workflow): Record<string, unknown> {
  // YAML's `on:` key is sometimes parsed as the boolean `true` because
  // `on` is a YAML 1.1 boolean literal; @std/yaml uses YAML 1.2 and
  // keeps it as the string `on`, but accept both for safety.
  return (wf.on ?? wf["true"] ?? wf[true as unknown as string]) as Record<string, unknown>;
}

Deno.test("deno-outdated workflow — triggers only on pull_request to Develop", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  assertExists(t, "workflow must declare triggers");
  assertExists(t.pull_request, "must trigger on pull_request");
  const pr = t.pull_request as { branches?: string[] };
  assertEquals(pr.branches, ["Develop"], "pull_request must target Develop");
});

Deno.test("deno-outdated workflow — does NOT run on a weekly cron schedule (#364)", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  assertEquals(
    Object.prototype.hasOwnProperty.call(t, "schedule"),
    false,
    "Issue #364 forbids weekly bot dependency PRs — no `schedule:` trigger allowed.",
  );
});

Deno.test("deno-outdated workflow — auto-bump job requests contents:write so it can push", async () => {
  const wf = await loadWorkflow();
  // Either job-level or workflow-level permissions must grant write.
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const jobNames = Object.keys(jobs);
  assert(jobNames.length >= 1, "must declare at least one job");
  const job = jobs[jobNames[0]];
  const jobPerms = (job.permissions ?? {}) as Record<string, string>;
  const wfPerms = (wf.permissions ?? {}) as Record<string, string>;
  const contents = jobPerms.contents ?? wfPerms.contents;
  assertEquals(contents, "write", "auto-bump must have contents: write to push");
});

Deno.test("deno-outdated workflow — skips PRs from forks", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const job = jobs[Object.keys(jobs)[0]];
  const guard = String(job.if ?? "");
  assert(
    guard.includes("head.repo.full_name") && guard.includes("github.repository"),
    `job must guard against fork PRs via head.repo.full_name == github.repository, got: ${guard}`,
  );
});

Deno.test("deno-outdated workflow — auto-bump runs bump-deps.sh and commits the result", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const job = jobs[Object.keys(jobs)[0]];
  const steps = job.steps as Array<Record<string, unknown>>;

  // bump-deps.sh must be invoked.
  const bump = steps.find((s) =>
    typeof s.run === "string" && (s.run as string).includes("bump-deps.sh")
  );
  assertExists(bump, "auto-bump must invoke bump-deps.sh");

  // A step must commit and push the changes (signals the auto-update,
  // not just warning).
  const commit = steps.find((s) => {
    const run = String(s.run ?? "");
    return run.includes("git commit") && run.includes("git push");
  });
  assertExists(commit, "auto-bump must commit and push the dependency updates");

  // Checkout must use the PR head ref so the push targets the PR branch.
  const checkout = steps.find((s) =>
    typeof s.uses === "string" && (s.uses as string).startsWith("actions/checkout@")
  );
  assertExists(checkout, "must check out the PR head");
  const cwith = checkout.with as Record<string, unknown>;
  assertEquals(
    cwith.ref,
    "${{ github.event.pull_request.head.ref }}",
    "checkout must target the PR head ref so commits go back to the PR branch",
  );
  assertEquals(
    cwith.repository,
    "${{ github.event.pull_request.head.repo.full_name }}",
    "checkout must target the PR head repository",
  );

  // checkout must be pinned to a 40-char SHA per supply-chain policy.
  const sha = (checkout.uses as string).split("@")[1].split(" ")[0];
  assertEquals(sha.length, 40, `actions/checkout must be pinned to a 40-char SHA, got "${sha}"`);
});
