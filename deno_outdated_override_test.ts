import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the Deno auto-bump workflow exposes an auditable emergency
 * override for the 24-hour supply-chain quarantine (Issue #603).
 *
 * SCR-QUARANTINE-OVERRIDE: the quarantine window deliberately delays
 * dependency bumps, but a documented fast-lane must exist for an
 * actively-exploited advisory. These are "what" tests — the workflow
 * YAML is the deliverable, so they parse it and assert on its structure
 * rather than grepping source text.
 */

const WORKFLOW_PATH = ".github/workflows/deno-outdated.yml";

// deno-lint-ignore no-explicit-any
function readWorkflow(): any {
  return parse(Deno.readTextFileSync(WORKFLOW_PATH));
}

Deno.test("deno-outdated workflow allows manual dispatch", () => {
  const wf = readWorkflow();
  // YAML parses the `on:` key as the boolean `true`, so read both forms.
  const triggers = wf.on ?? wf[true as unknown as string];
  assert(triggers, "Expected the workflow to declare triggers");
  assert(
    "workflow_dispatch" in triggers,
    "Expected a workflow_dispatch trigger so the override can be run manually",
  );
});

Deno.test("workflow_dispatch exposes a quarantine_hours override input", () => {
  const wf = readWorkflow();
  const triggers = wf.on ?? wf[true as unknown as string];
  const input = triggers.workflow_dispatch?.inputs?.quarantine_hours;
  assert(input, "Expected a quarantine_hours workflow_dispatch input");
  assertEquals(
    String(input.default),
    "24",
    "Expected the override input to default to the 24h quarantine window",
  );
  assert(
    typeof input.description === "string" && input.description.length > 0,
    "Expected the override input to be documented with a description",
  );
});

Deno.test("quarantine env honours the override input with a 24h fallback", () => {
  const wf = readWorkflow();
  const env = wf.jobs["auto-bump"].env;
  const quarantine = env.VIBE_BUMP_QUARANTINE_HOURS;
  assert(
    typeof quarantine === "string",
    "Expected VIBE_BUMP_QUARANTINE_HOURS to be set on the job",
  );
  assert(
    quarantine.includes("inputs.quarantine_hours"),
    "Expected the quarantine env to read the override input",
  );
  assert(
    quarantine.includes("'24'") || quarantine.includes('"24"'),
    "Expected the quarantine env to fall back to 24 when no override is given",
  );
});
