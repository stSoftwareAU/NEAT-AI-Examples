// Tests for .github/workflows/actionlint.yml (Issue #508).
//
// The repository ships several GitHub Actions workflows under
// `.github/workflows/`, but there was no CI lint gate for those YAML
// files. A typo or unsafe pattern in a workflow file could land on
// `Develop` without anyone noticing until it broke a downstream run.
//
// This test pins the contract for a dedicated actionlint workflow:
//   * triggers on every pull request (against any base branch) and on
//     pushes to the default branch `Develop`,
//   * runs on `ubuntu-latest` with read-only `contents` permission,
//     mirroring the other lint workflows,
//   * pins every third-party action to a 40-character commit SHA in
//     line with the project's supply-chain hardening rules, and
//   * actually invokes `actionlint` so workflow regressions fail the
//     build.

import { assert, assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/actionlint.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

function triggers(wf: Workflow): Record<string, unknown> {
  // YAML 1.1 treats `on` as a boolean; @std/yaml uses YAML 1.2 and keeps
  // it as the string `on`. Accept both for safety.
  return (wf.on ?? wf["true"] ?? wf[true as unknown as string]) as Record<
    string,
    unknown
  >;
}

Deno.test("actionlint workflow — file exists and parses as YAML", async () => {
  const wf = await loadWorkflow();
  assertExists(wf, "workflow YAML must parse to an object");
  assertExists(wf.jobs, "workflow must declare at least one job");
});

Deno.test("actionlint workflow — triggers on pull_request to any branch", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  const pr = t.pull_request as { branches?: string[] } | undefined;
  assertExists(pr, "workflow must trigger on pull_request");
  assertExists(pr.branches, "pull_request trigger must declare branches");
  assert(
    pr.branches.includes("**"),
    `pull_request must run for PRs against any branch (got ${
      JSON.stringify(pr.branches)
    }). Use "**" — see Issue #435.`,
  );
});

Deno.test("actionlint workflow — triggers on push to Develop", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  const push = t.push as { branches?: string[] } | undefined;
  assertExists(push, "workflow must trigger on push so regressions on Develop fail loudly");
  assertExists(push.branches, "push trigger must declare branches");
  assert(
    push.branches.includes("Develop"),
    `push trigger must include the default branch 'Develop' (got ${JSON.stringify(push.branches)})`,
  );
});

Deno.test("actionlint workflow — declares read-only contents permission", async () => {
  const wf = await loadWorkflow();
  const perms = wf.permissions as Record<string, string> | undefined;
  assertExists(perms, "workflow must declare an explicit permissions block");
  assertEquals(
    perms.contents,
    "read",
    "actionlint only needs to read repository contents",
  );
});

Deno.test("actionlint workflow — runs on ubuntu-latest", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const jobKey = Object.keys(jobs)[0];
  const job = jobs[jobKey];
  assertEquals(
    job["runs-on"],
    "ubuntu-latest",
    `job '${jobKey}' must run on ubuntu-latest`,
  );
});

Deno.test("actionlint workflow — every uses: pins a 40-char commit SHA", async () => {
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
          `to a 40-character commit SHA (got '${uses}'). See the supply-chain ` +
          `hardening rules in AGENTS.md.`,
      );
    }
  }
});

Deno.test("actionlint workflow — actually invokes the actionlint binary", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  let invokesActionlint = false;
  for (const job of Object.values(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) {
      const uses = (step.uses as string | undefined) ?? "";
      const run = (step.run as string | undefined) ?? "";
      if (
        // Either the official rhysd action…
        uses.startsWith("rhysd/actionlint") ||
        // …or a shell step that runs the binary directly.
        /\bactionlint\b/.test(run)
      ) {
        invokesActionlint = true;
        break;
      }
    }
    if (invokesActionlint) break;
  }
  assert(
    invokesActionlint,
    "workflow must run actionlint (either rhysd/actionlint-* action or `actionlint` binary directly)",
  );
});

Deno.test("actionlint workflow — workflow_dispatch accepts pr_head_ref for CI re-dispatch", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  const wd = t.workflow_dispatch as
    | { inputs?: Record<string, { required?: boolean; type?: string }> }
    | undefined;
  assertExists(
    wd,
    "workflow must accept workflow_dispatch so the CI re-dispatch helper can re-run it after auto-bumps",
  );
  assertExists(wd.inputs, "workflow_dispatch must declare an inputs map");
  assertExists(
    wd.inputs.pr_head_ref,
    "workflow_dispatch must accept a 'pr_head_ref' input (the PR head branch)",
  );
  assertEquals(
    wd.inputs.pr_head_ref.required,
    true,
    "'pr_head_ref' input must be required so re-dispatch never runs on the wrong ref",
  );
});
