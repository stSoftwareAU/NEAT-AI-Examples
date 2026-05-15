// Tests for .github/workflows/deno-outdated.yml (Issue #362).
//
// The workflow declares two behaviours: a PR drift check (non-blocking
// warning) and a scheduled auto-bump that opens a pull request via
// peter-evans/create-pull-request. These tests parse the YAML and
// assert on the declared configuration — that is the only observable
// surface of a workflow file short of running it on GitHub Actions.

import { assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/deno-outdated.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

Deno.test("deno-outdated workflow — runs on a weekly schedule", async () => {
  const wf = await loadWorkflow();
  // YAML `on:` becomes the boolean key `true` because `on` is a YAML
  // boolean literal; @std/yaml preserves that, so accept either key.
  const triggers = wf.on ?? wf["true"] ?? wf[true as unknown as string];
  assertExists(triggers, "workflow must declare triggers");
  assertExists(triggers.schedule, "must declare a schedule trigger");
  assertEquals(triggers.schedule.length, 1);
  assertEquals(triggers.schedule[0].cron, "0 6 * * 1");
});

Deno.test("deno-outdated workflow — supports manual dispatch", async () => {
  const wf = await loadWorkflow();
  const triggers = wf.on ?? wf["true"] ?? wf[true as unknown as string];
  // workflow_dispatch with no inputs serialises as `null` in YAML.
  assertEquals(
    Object.prototype.hasOwnProperty.call(triggers, "workflow_dispatch"),
    true,
  );
});

Deno.test("deno-outdated workflow — keeps PR drift-check job", async () => {
  const wf = await loadWorkflow();
  const job = wf.jobs?.["drift-check"];
  assertExists(job, "drift-check job must exist");
  assertEquals(job.if, "github.event_name == 'pull_request'");
});

Deno.test("deno-outdated workflow — auto-bump job runs on schedule and dispatch", async () => {
  const wf = await loadWorkflow();
  const job = wf.jobs?.["auto-bump"];
  assertExists(job, "auto-bump job must exist");
  assertEquals(
    job.if,
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
  );
  assertEquals(job.permissions.contents, "write");
  assertEquals(job.permissions["pull-requests"], "write");
});

Deno.test("deno-outdated workflow — auto-bump invokes bump-deps.sh and peter-evans/create-pull-request", async () => {
  const wf = await loadWorkflow();
  const steps = wf.jobs["auto-bump"].steps as Array<Record<string, unknown>>;
  const bump = steps.find((s) =>
    typeof s.run === "string" && (s.run as string).includes("bump-deps.sh")
  );
  assertExists(bump, "auto-bump must invoke bump-deps.sh");

  const prStep = steps.find((s) =>
    typeof s.uses === "string" && (s.uses as string).startsWith("peter-evans/create-pull-request@")
  );
  assertExists(prStep, "auto-bump must use peter-evans/create-pull-request");
  // Action pinned to a 40-char commit SHA per supply-chain policy.
  const uses = prStep.uses as string;
  const sha = uses.split("@")[1].split(" ")[0];
  assertEquals(
    sha.length,
    40,
    `peter-evans/create-pull-request must be pinned to a 40-char SHA, got "${sha}"`,
  );

  const withCfg = prStep.with as Record<string, unknown>;
  assertEquals(withCfg.base, "Develop");
  assertEquals(withCfg.branch, "chore/deno-outdated");
});
