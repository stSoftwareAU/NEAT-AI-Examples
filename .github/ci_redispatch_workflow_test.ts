// Tests for workflow_dispatch re-dispatch inputs on CI workflows (#485).
//
// When the Deno auto-bump job pushes via GITHUB_TOKEN, downstream
// `pull_request` workflows do not re-run. Each required workflow must
// accept `pr_head_ref` via `workflow_dispatch` so auto-bump can
// re-dispatch them on the updated PR head.

import { assert, assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

// deno-lint-ignore no-explicit-any
type Workflow = any;

const WORKFLOW_DIR = new URL("./workflows/", import.meta.url);

const REDISPATCH_WORKFLOWS = [
  "quality.yml",
  "shellcheck.yml",
  "markdown-lint.yml",
  "semgrep.yml",
  "gitleaks.yml",
  "dependency-review.yml",
];

async function loadWorkflow(name: string): Promise<Workflow> {
  const path = new URL(name, WORKFLOW_DIR);
  const text = await Deno.readTextFile(path);
  return parse(text) as Workflow;
}

function triggers(wf: Workflow): Record<string, unknown> {
  return (wf.on ?? wf["true"] ?? wf[true as unknown as string]) as Record<string, unknown>;
}

for (const wfName of REDISPATCH_WORKFLOWS) {
  Deno.test(`${wfName} — supports workflow_dispatch with pr_head_ref (#485)`, async () => {
    const wf = await loadWorkflow(wfName);
    const t = triggers(wf);
    assertExists(t.workflow_dispatch, `${wfName} must declare workflow_dispatch`);

    const dispatch = t.workflow_dispatch as { inputs?: Record<string, unknown> };
    const inputs = dispatch.inputs ?? {};
    const prHead = inputs.pr_head_ref as { required?: boolean; type?: string } | undefined;
    assertExists(prHead, `${wfName} must declare workflow_dispatch.inputs.pr_head_ref`);
    assertEquals(prHead.required, true, "pr_head_ref must be required");
    assertEquals(prHead.type, "string", "pr_head_ref must be a string input");
  });

  Deno.test(`${wfName} — checks out pr_head_ref on workflow_dispatch (#485)`, async () => {
    const wf = await loadWorkflow(wfName);
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const job = jobs[Object.keys(jobs)[0]];
    const steps = job.steps as Array<Record<string, unknown>>;

    const checkout = steps.find((s) =>
      typeof s.uses === "string" && (s.uses as string).startsWith("actions/checkout@")
    );
    assertExists(checkout, `${wfName} must check out the repository`);
    const withBlock = checkout.with as Record<string, unknown> | undefined;
    assertExists(withBlock?.ref, `${wfName} checkout must set ref`);
    assert(
      String(withBlock?.ref).includes("inputs.pr_head_ref"),
      `${wfName} checkout ref must honour workflow_dispatch pr_head_ref`,
    );
  });
}
