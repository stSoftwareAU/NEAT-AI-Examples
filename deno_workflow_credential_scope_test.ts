import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the org `ACTIONS_PUSH` PAT is never persisted in the workspace
 * while PR-controlled code runs (Issue #678).
 *
 * Root cause: `actions/checkout` with `token:` writes the credential into
 * `.git/config`, where it stays readable for the whole job. The auto-bump
 * job then executes `bump-deps.sh` — a script taken from the PR branch —
 * so any same-repo PR author could read the org service PAT back out with
 * a single `git config --get http.https://github.com/.extraheader`.
 *
 * The fix keeps the credential out of the workspace (`persist-credentials:
 * false`) and supplies it only to a dedicated push step that runs after
 * the PR-authored script has finished.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they
 * parse it and assert on its structure rather than grepping source text.
 */

const OUTDATED_PATH = ".github/workflows/deno-outdated.yml";
const SECURITY_PATH = ".github/workflows/deno-security-update.yml";

// deno-lint-ignore no-explicit-any
type Step = any;

function readWorkflow(path: string): Record<string, Step> {
  return parse(Deno.readTextFileSync(path)) as Record<string, Step>;
}

function stepByUses(steps: Step[], needle: string): Step {
  return steps.find((s) => typeof s.uses === "string" && s.uses.includes(needle));
}

function stepByName(steps: Step[], needle: string): Step {
  return steps.find((s) => typeof s.name === "string" && s.name.includes(needle));
}

/** Every secret reference reachable from a step (its `env` and its `run` body). */
function secretsInStep(step: Step): string {
  return JSON.stringify({ env: step.env ?? {}, run: step.run ?? "", with: step.with ?? {} });
}

function outdatedSteps(): Step[] {
  return readWorkflow(OUTDATED_PATH).jobs["auto-bump"].steps;
}

function securitySteps(): Step[] {
  return readWorkflow(SECURITY_PATH).jobs["security-update"].steps;
}

Deno.test("deno-outdated checkout does not persist a credential in the workspace", () => {
  const checkout = stepByUses(outdatedSteps(), "actions/checkout");
  assert(checkout, "Expected an actions/checkout step");
  assertEquals(
    checkout.with["persist-credentials"],
    false,
    "checkout must not leave a credential in .git/config while PR code runs",
  );
  assertEquals(
    checkout.with.token,
    undefined,
    "checkout must not receive the ACTIONS_PUSH PAT — it would be persisted for the whole job",
  );
});

Deno.test("deno-outdated runs the PR-controlled bump script with no PAT in scope", () => {
  const steps = outdatedSteps();
  const bump = steps.find((s: Step) => typeof s.run === "string" && s.run.includes("bump-deps.sh"));
  assert(bump, "Expected a step that runs bump-deps.sh");
  assert(
    !secretsInStep(bump).includes("ACTIONS_PUSH"),
    "The step executing PR-authored bump-deps.sh must have no ACTIONS_PUSH in scope",
  );
  assert(
    !String(bump.run).includes("git push"),
    "Pushing must happen in a separate, secret-bearing step after the PR script has finished",
  );
});

Deno.test("deno-outdated pushes from a dedicated step scoped to the PAT", () => {
  const steps = outdatedSteps();
  const push = steps.find((s: Step) => typeof s.run === "string" && s.run.includes("git push"));
  assert(push, "Expected a dedicated push step");
  assert(
    secretsInStep(push).includes("ACTIONS_PUSH"),
    "The push must still authenticate as the org PAT so required checks start automatically (#651)",
  );
  assert(
    !secretsInStep(push).includes("bump-deps.sh"),
    "The push step must not execute PR-authored code",
  );
  assert(
    String(push.run).includes("hooksPath"),
    "Clear core.hooksPath before pushing so a PR-planted git hook cannot read the PAT",
  );
});

Deno.test("deno-outdated push step is gated on the bump having produced a commit", () => {
  const steps = outdatedSteps();
  const push = steps.find((s: Step) => typeof s.run === "string" && s.run.includes("git push"));
  assert(
    typeof push.if === "string" && push.if.includes("pushed"),
    "The push step must only run when the bump step reported a commit",
  );
});

Deno.test("deno-security-update checkout does not persist a credential", () => {
  const checkout = stepByUses(securitySteps(), "actions/checkout");
  assert(checkout, "Expected an actions/checkout step");
  assertEquals(
    checkout.with["persist-credentials"],
    false,
    "Same shape as deno-outdated: no credential left in .git/config",
  );
  assertEquals(checkout.with.token, undefined, "checkout must not receive the PAT");
});

Deno.test("deno-security-update pushes the advisory branch from a PAT-scoped step", () => {
  const steps = securitySteps();
  const bump = steps.find((s: Step) => typeof s.run === "string" && s.run.includes("bump-deps.sh"));
  assert(bump, "Expected the fast-track bump step");
  assert(
    !secretsInStep(bump).includes("ACTIONS_PUSH"),
    "The bump step must not carry the PAT",
  );
  const push = steps.find((s: Step) => typeof s.run === "string" && s.run.includes("git push"));
  assert(push, "Expected a dedicated push step");
  assert(
    secretsInStep(push).includes("ACTIONS_PUSH"),
    "The advisory branch push must still be a write-access event (#651)",
  );
});

Deno.test("the PAT reaches only push and PR-creation steps", () => {
  for (const steps of [outdatedSteps(), securitySteps()]) {
    for (const step of steps) {
      if (!secretsInStep(step).includes("ACTIONS_PUSH")) continue;
      const run = String(step.run ?? "");
      assert(
        run.includes("git push") || run.includes("gh pr create"),
        `Only the push / PR-creation steps may see the PAT, found it in: ${step.name}`,
      );
    }
  }
});

Deno.test("the security-update PR step still opens its PR with the PAT", () => {
  const prStep = stepByName(securitySteps(), "Open security-update PR");
  assert(prStep, "Expected the Open security-update PR step");
  assert(String(prStep.env.GH_TOKEN).includes("ACTIONS_PUSH"));
});
