// Tests for .github/workflows/deno-security-update.yml (Issue #601)
//
// The existing posture has two pieces but a gap between them:
//   * `deno-outdated.yml` bumps pins, but only `on: pull_request` and
//     behind the routine 24h supply-chain quarantine (#441) — no
//     out-of-band path for a disclosed CVE;
//   * `deno-audit.yml` (#572) *detects* a newly-disclosed advisory on a
//     schedule, but only fails the build — it never raises the patch.
//
// This workflow is the missing security-UPDATE channel: a scheduled,
// advisory-driven job that runs `deno audit`, and when an advisory is
// found, fast-tracks a patch via `bump-deps.sh` with the quarantine
// window set to 0h (security fixes bypass the routine quarantine) and
// opens a PR — independently of the PR-time bumper.
//
// These tests pin the contract:
//   * runs on a `schedule:` cron AND supports manual `workflow_dispatch`;
//   * runs `deno audit` to detect the advisory (the gate);
//   * invokes `bump-deps.sh` to apply the patch (the update channel);
//   * pins VIBE_BUMP_QUARANTINE_HOURS to "0" so security fixes are
//     fast-tracked past the routine 24h quarantine;
//   * opens a PR via `gh pr create` so the patch lands out-of-band; and
//   * runs on `ubuntu-latest` with contents:write + pull-requests:write.
//
// The 40-character SHA-pin policy is asserted for every workflow at once
// in `workflow_pin_policy_test.ts` (Issue #744).

import { assert, assertEquals, assertExists } from "@std/assert";
import { loadWorkflow, triggers, type Workflow } from "./workflow_test_utils.ts";

const WORKFLOW = "deno-security-update.yml";

function firstJob(wf: Workflow): Record<string, unknown> {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  return jobs[Object.keys(jobs)[0]];
}

function allRun(wf: Workflow): string {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  let text = "";
  for (const job of Object.values(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) text += `\n${String(step.run ?? "")}`;
  }
  return text;
}

Deno.test("deno-security-update workflow — file exists and parses as YAML", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  assertExists(wf, "workflow YAML must parse to an object");
  assertExists(wf.jobs, "workflow must declare at least one job");
});

Deno.test("deno-security-update workflow — runs on a scheduled cron (advisory-driven channel)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assertExists(t, "workflow must declare triggers");
  assert(
    Object.prototype.hasOwnProperty.call(t, "schedule"),
    "Issue #601 requires a standing, out-of-band security-update " +
      "channel — a `schedule:` trigger is mandatory.",
  );
  const schedule = t.schedule as Array<{ cron?: string }>;
  assert(
    Array.isArray(schedule) && schedule.length > 0,
    "`schedule:` must list at least one cron entry",
  );
  for (const entry of schedule) {
    assertExists(entry.cron, "each schedule entry must declare a cron string");
    assert(
      /^[\d*/,\s-]+$/.test(entry.cron!),
      `cron expression looks malformed: '${entry.cron}'`,
    );
  }
});

Deno.test("deno-security-update workflow — supports manual workflow_dispatch", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assert(
    Object.prototype.hasOwnProperty.call(t, "workflow_dispatch"),
    "workflow must be manually triggerable via workflow_dispatch",
  );
});

Deno.test("deno-security-update workflow — runs `deno audit` to detect the advisory", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  assert(
    /\bdeno\s+audit\b/.test(allRun(wf)),
    "the security-update channel must gate on `deno audit` so it only " +
      "raises a patch when an advisory is actually disclosed (#601).",
  );
});

Deno.test("deno-security-update workflow — applies the patch via bump-deps.sh", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  assert(
    /bump-deps\.sh/.test(allRun(wf)),
    "the update channel must invoke bump-deps.sh to apply the patch — " +
      "reusing the existing quarantine-aware updater, not a new path.",
  );
});

Deno.test("deno-security-update workflow — fast-tracks past quarantine with VIBE_BUMP_QUARANTINE_HOURS=0", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const job = firstJob(wf);
  const jobEnv = (job.env ?? {}) as Record<string, string>;
  const wfEnv = (wf.env ?? {}) as Record<string, string>;
  const value = jobEnv.VIBE_BUMP_QUARANTINE_HOURS ??
    wfEnv.VIBE_BUMP_QUARANTINE_HOURS;
  assertExists(
    value,
    "the security channel must pin VIBE_BUMP_QUARANTINE_HOURS so the " +
      "fast-track policy is auditable from CI config.",
  );
  assertEquals(
    String(value),
    "0",
    "security fixes must bypass the routine 24h quarantine — a disclosed " +
      "advisory means the current pin is the risk, so the patch is " +
      "fast-tracked with a 0h window (#601).",
  );
});

Deno.test("deno-security-update workflow — opens a PR so the patch lands out-of-band", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  assert(
    /gh\s+pr\s+create/.test(allRun(wf)),
    "the channel must raise its own PR (gh pr create) so the security " +
      "patch lands independently of the PR-time bumper (#601).",
  );
});

Deno.test("deno-security-update workflow — runs on ubuntu-latest with read-only GITHUB_TOKEN permissions", async () => {
  // Business-logic change (#679): both writes in this job ride the org
  // ACTIONS_PUSH PAT — the branch push uses a PAT-bearing remote URL and
  // `gh pr create` runs with `GH_TOKEN: secrets.ACTIONS_PUSH` (#651). The
  // old `contents: write` / `pull-requests: write` grants were therefore
  // never exercised. This test previously asserted both were "write"; it
  // now pins the least-privilege grant.
  const wf = await loadWorkflow(WORKFLOW);
  const job = firstJob(wf);
  const jobPerms = (job.permissions ?? {}) as Record<string, string>;
  const wfPerms = (wf.permissions ?? {}) as Record<string, string>;
  const contents = jobPerms.contents ?? wfPerms.contents;
  const pulls = jobPerms["pull-requests"] ?? wfPerms["pull-requests"];
  assertEquals(
    contents,
    "read",
    "the branch is pushed with the ACTIONS_PUSH PAT, so GITHUB_TOKEN needs read only",
  );
  assertEquals(
    pulls,
    undefined,
    "gh pr create authenticates with the PAT, so pull-requests: write is unused",
  );
  assertEquals(
    job["runs-on"],
    "ubuntu-latest",
    "job must run on ubuntu-latest",
  );
});
