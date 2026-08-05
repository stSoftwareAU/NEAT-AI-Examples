// Tests for the local composite action .github/actions/setup-deno-env
// (Issue #682).
//
// The checkout + `denoland/setup-deno` pair (same SHA pins,
// `deno-version: v2.x`) was copy-pasted across four workflows, and
// quality.yml additionally repeated the dependency cache +
// `deno install --frozen` block in each of its three parallel jobs. This
// action collapses that duplication to one file, so the version pin,
// cache key, and install policy have a single source of truth.
//
// These are "what" tests: they parse the committed YAML and assert on its
// structure and on how the four workflows wire the action in — the
// contract that keeps the six former copies from drifting apart.

import { assert, assertEquals } from "@std/assert";
import { loadCompositeAction, loadWorkflow, type Workflow } from "./workflow_test_utils.ts";

// The four workflows that consumed the duplicated setup block.
const CONSUMER_WORKFLOWS = [
  "quality.yml",
  "deno-audit.yml",
  "deno-outdated.yml",
  "deno-security-update.yml",
] as const;

const COMPOSITE_USES = "./.github/actions/setup-deno-env";

function loadAction(): Promise<Workflow> {
  return loadCompositeAction("setup-deno-env");
}

// deno-lint-ignore no-explicit-any
function actionSteps(action: Workflow): Array<Record<string, any>> {
  return (action.runs?.steps ?? []) as Array<Record<string, unknown>>;
}

// deno-lint-ignore no-explicit-any
function stepByUsesPrefix(steps: Array<Record<string, any>>, prefix: string) {
  return steps.find((s) => (s.uses as string | undefined)?.startsWith(prefix));
}

Deno.test("setup-deno-env — parses and is a composite action", async () => {
  const action = await loadAction();
  assertEquals(
    action.runs?.using,
    "composite",
    "the shared setup must be a composite action so workflows can `uses:` it",
  );
  assert(
    Array.isArray(action.runs?.steps) && action.runs.steps.length > 0,
    "composite action must declare at least one step",
  );
});

Deno.test("setup-deno-env — declares the install-deps input defaulting to false", async () => {
  const action = await loadAction();
  const input = action.inputs?.["install-deps"];
  assert(input, "action must declare an `install-deps` input");
  assertEquals(
    String(input.default),
    "false",
    "`install-deps` must default to false so Deno-only jobs need no `with:`",
  );
});

// The SHA pins on this action's own steps are asserted alongside every
// other workflow in `workflow_pin_policy_test.ts` (Issue #744).
Deno.test("setup-deno-env — always installs Deno at v2.x", async () => {
  const action = await loadAction();
  const steps = actionSteps(action);
  const setup = stepByUsesPrefix(steps, "denoland/setup-deno@");
  assert(setup, "action must install Deno via denoland/setup-deno");
  assertEquals(
    (setup.with as { "deno-version"?: string })["deno-version"],
    "v2.x",
    "Deno version policy must stay v2.x in the single source of truth",
  );
  // The Deno install is unconditional — every consumer needs the runtime.
  assertEquals(
    setup.if,
    undefined,
    "the Deno install step must not be gated on install-deps",
  );
});

Deno.test("setup-deno-env — cache and frozen install are gated on install-deps == 'true'", async () => {
  const action = await loadAction();
  const steps = actionSteps(action);

  const cache = stepByUsesPrefix(steps, "actions/cache@");
  assert(cache, "action must cache Deno dependencies");
  assertEquals(
    String(cache.if),
    "inputs.install-deps == 'true'",
    "the dependency cache must only run when install-deps is true",
  );
  const cacheKey = (cache.with as { key?: string }).key ?? "";
  assert(
    cacheKey.includes("hashFiles('deno.json', 'deno.lock')"),
    "cache key must hash deno.json + deno.lock so the recipe has one home",
  );

  const frozen = steps.find((s) => /deno\s+install\s+--frozen/.test(String(s.run ?? "")));
  assert(frozen, "action must run `deno install --frozen` (Issue #418)");
  assertEquals(
    String(frozen.if),
    "inputs.install-deps == 'true'",
    "the frozen install must only run when install-deps is true",
  );
  assertEquals(
    frozen.shell,
    "bash",
    "a composite `run:` step must declare its shell",
  );
});

Deno.test("setup-deno-env — all four consumer workflows use the composite action, none inline denoland/setup-deno", async () => {
  for (const file of CONSUMER_WORKFLOWS) {
    const wf = await loadWorkflow(file);
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    let usesComposite = false;
    for (const job of Object.values(jobs)) {
      const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
        [];
      for (const step of steps) {
        const uses = (step.uses as string | undefined) ?? "";
        if (uses === COMPOSITE_USES) usesComposite = true;
        assert(
          !uses.startsWith("denoland/setup-deno@"),
          `${file} must not inline denoland/setup-deno — the setup moved to ${COMPOSITE_USES} (Issue #682)`,
        );
      }
    }
    assert(
      usesComposite,
      `${file} must set up Deno via ${COMPOSITE_USES} (Issue #682)`,
    );
  }
});

Deno.test("setup-deno-env — Deno-only workflows do not request install-deps", async () => {
  // deno-audit / deno-outdated / deno-security-update need the runtime
  // only (they run `deno audit` / `bump-deps.sh`), so they must not opt
  // into the dependency cache + frozen install.
  for (const file of ["deno-audit.yml", "deno-outdated.yml", "deno-security-update.yml"]) {
    const wf = await loadWorkflow(file);
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    for (const job of Object.values(jobs)) {
      const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
        [];
      for (const step of steps) {
        if ((step.uses as string | undefined) !== COMPOSITE_USES) continue;
        const installDeps = (step.with as { "install-deps"?: string } | undefined)
          ?.["install-deps"];
        assert(
          installDeps === undefined || installDeps === "false",
          `${file} is Deno-only and must not pass install-deps: "true"`,
        );
      }
    }
  }
});
