// Tests for .github/workflows/deno-audit.yml (Issue #572)
//
// `dependency-review.yml` only inspects the dependency-graph *diff* of a
// pull request, so a CVE disclosed against a pin that is already on
// `Develop` goes unnoticed in CI until an unrelated PR happens to touch
// dependencies. This workflow closes that posture gap: a scheduled,
// Deno-native `deno audit` over the *standing* locked tree
// (`deno.json` / `deno.lock`).
//
// These tests pin the contract:
//   * the workflow runs on a `schedule:` cron AND supports manual
//     `workflow_dispatch` (the standing detector — focus of Issue #572),
//   * it also runs on every `pull_request` so the standing pin set is
//     re-audited per PR, not only weekly (Issue #600),
//   * it actually invokes `deno audit` so the locked tree is scanned, and
//   * it runs on `ubuntu-latest` with read-only `contents` permission.
//
// The 40-character SHA-pin policy is asserted for every workflow at once
// in `workflow_pin_policy_test.ts` (Issue #744).

import { assert, assertEquals, assertExists } from "@std/assert";
import { loadWorkflow, triggers } from "./workflow_test_utils.ts";

const WORKFLOW = "deno-audit.yml";

Deno.test("deno-audit workflow — file exists and parses as YAML", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  assertExists(wf, "workflow YAML must parse to an object");
  assertExists(wf.jobs, "workflow must declare at least one job");
});

Deno.test("deno-audit workflow — runs on a scheduled cron (the standing detector)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assertExists(t, "workflow must declare triggers");
  assert(
    Object.prototype.hasOwnProperty.call(t, "schedule"),
    "Issue #572 requires a scheduled scan of the locked tree — a " +
      "`schedule:` trigger is mandatory.",
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

Deno.test("deno-audit workflow — runs on every pull_request (Issue #600)", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assertExists(t, "workflow must declare triggers");
  assert(
    Object.prototype.hasOwnProperty.call(t, "pull_request"),
    "Issue #600 requires the locked tree to be audited on every PR, not " +
      "only on the weekly cron — a `pull_request:` trigger is mandatory.",
  );
  const pr = t.pull_request as { branches?: string[] };
  assertExists(pr, "`pull_request` trigger must declare a configuration");
  assert(
    Array.isArray(pr.branches) && pr.branches.includes("**"),
    "`pull_request.branches` must be `['**']` so PRs against base " +
      "branches containing a `/` still trigger the audit (Issue #435). " +
      `Got: ${JSON.stringify(pr.branches)}`,
  );
});

Deno.test("deno-audit workflow — supports manual workflow_dispatch", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const t = triggers(wf);
  assert(
    Object.prototype.hasOwnProperty.call(t, "workflow_dispatch"),
    "workflow must be manually triggerable via workflow_dispatch",
  );
});

Deno.test("deno-audit workflow — actually invokes `deno audit`", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  let invokesAudit = false;
  for (const job of Object.values(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) {
      const run = (step.run as string | undefined) ?? "";
      if (/\bdeno\s+audit\b/.test(run)) {
        invokesAudit = true;
        break;
      }
    }
    if (invokesAudit) break;
  }
  assert(
    invokesAudit,
    "workflow must run `deno audit` so a newly-disclosed advisory in the " +
      "locked tree fails the scheduled build (Issue #572).",
  );
});

Deno.test("deno-audit workflow — runs on ubuntu-latest with read-only contents", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const perms = wf.permissions as Record<string, string> | undefined;
  assertExists(perms, "workflow must declare an explicit permissions block");
  assertEquals(
    perms.contents,
    "read",
    "a read-only audit only needs to read repository contents",
  );
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const jobKey = Object.keys(jobs)[0];
  assertEquals(
    jobs[jobKey]["runs-on"],
    "ubuntu-latest",
    `job '${jobKey}' must run on ubuntu-latest`,
  );
});
