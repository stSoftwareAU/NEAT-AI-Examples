// Tests for .github/workflows/gitleaks.yml (Issue #423).
//
// Hardening: the workflow must NOT interpolate `${{ ... }}` expressions
// directly into `run:` shell scripts. Untrusted values must be passed
// through an `env:` mapping so the runner exports them as ordinary
// shell variables, avoiding any chance of shell-injection via crafted
// expression values.

import { assert, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/gitleaks.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

function allSteps(wf: Workflow): Array<Record<string, unknown>> {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const steps: Array<Record<string, unknown>> = [];
  for (const job of Object.values(jobs)) {
    const js = (job.steps ?? []) as Array<Record<string, unknown>>;
    steps.push(...js);
  }
  return steps;
}

Deno.test("gitleaks workflow — no run: step interpolates ${{ ... }} directly", async () => {
  const wf = await loadWorkflow();
  const steps = allSteps(wf);
  for (const step of steps) {
    const run = step.run;
    if (typeof run !== "string") continue;
    assert(
      !/\$\{\{[^}]+\}\}/.test(run),
      `run: in step "${step.name}" must not interpolate \${{ ... }} directly; pass via env: instead. Got:\n${run}`,
    );
  }
});

Deno.test("gitleaks workflow — Run Gitleaks step passes base_ref via env:", async () => {
  const wf = await loadWorkflow();
  const steps = allSteps(wf);
  const runStep = steps.find((s) => s.name === "Run Gitleaks");
  assertExists(runStep, "must have a 'Run Gitleaks' step");

  const env = (runStep.env ?? {}) as Record<string, string>;
  // base_ref must be supplied via env mapping (not inlined).
  const baseRefEnv = Object.values(env).find((v) =>
    typeof v === "string" && v.includes("github.base_ref")
  );
  assertExists(
    baseRefEnv,
    "Run Gitleaks step must expose github.base_ref via an env: mapping",
  );

  // The run: script must reference the env var, not the raw expression.
  const run = String(runStep.run ?? "");
  const envName = Object.keys(env).find((k) => env[k].includes("github.base_ref"));
  assertExists(envName, "env mapping for github.base_ref must have a name");
  assert(
    run.includes(`${envName}`),
    `run: script must reference the env var ${envName}, got:\n${run}`,
  );
  assert(
    !run.includes("github.base_ref"),
    `run: script must NOT inline github.base_ref directly, got:\n${run}`,
  );
});
