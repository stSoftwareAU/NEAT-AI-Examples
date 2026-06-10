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
//   * it actually invokes `deno audit` so the locked tree is scanned,
//   * every `uses:` action is pinned to a 40-character commit SHA, and
//   * it runs on `ubuntu-latest` with read-only `contents` permission.

import { assert, assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/deno-audit.yml", import.meta.url);

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
  return (wf.on ?? wf["true"] ?? wf[true as unknown as string]) as Record<
    string,
    unknown
  >;
}

Deno.test("deno-audit workflow — file exists and parses as YAML", async () => {
  const wf = await loadWorkflow();
  assertExists(wf, "workflow YAML must parse to an object");
  assertExists(wf.jobs, "workflow must declare at least one job");
});

Deno.test("deno-audit workflow — runs on a scheduled cron (the standing detector)", async () => {
  const wf = await loadWorkflow();
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

Deno.test("deno-audit workflow — supports manual workflow_dispatch", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  assert(
    Object.prototype.hasOwnProperty.call(t, "workflow_dispatch"),
    "workflow must be manually triggerable via workflow_dispatch",
  );
});

Deno.test("deno-audit workflow — actually invokes `deno audit`", async () => {
  const wf = await loadWorkflow();
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

Deno.test("deno-audit workflow — every uses: pins a 40-char commit SHA", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const shaPattern = /@[0-9a-f]{40}\b/;
  for (const [jobKey, job] of Object.entries(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) {
      const uses = step.uses as string | undefined;
      if (!uses) continue;
      assert(
        shaPattern.test(uses),
        `job '${jobKey}' step '${step.name ?? uses}' must pin its action ` +
          `to a 40-character commit SHA (got '${uses}'). See the ` +
          `supply-chain hardening rules in AGENTS.md.`,
      );
    }
  }
});

Deno.test("deno-audit workflow — runs on ubuntu-latest with read-only contents", async () => {
  const wf = await loadWorkflow();
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
