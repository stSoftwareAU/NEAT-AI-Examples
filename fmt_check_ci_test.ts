import { assert } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the quality workflow enforces formatting drift in check mode
 * rather than silently reformatting in the ephemeral runner (Issue #663).
 *
 * Root cause: the `static-checks` job ran `deno fmt` (write mode), whose
 * reformatting is never committed back, so committed formatting drift
 * passed CI unnoticed. Switching to `deno fmt --check` makes drift fail
 * the status check on a pull request.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they
 * parse it and assert on its structure rather than grepping source text.
 */

const QUALITY_PATH = ".github/workflows/quality.yml";

// deno-lint-ignore no-explicit-any
function readWorkflow(path: string): any {
  return parse(Deno.readTextFileSync(path));
}

// deno-lint-ignore no-explicit-any
function fmtStep(steps: any[]): any {
  return steps.find((s) => typeof s.run === "string" && /\bdeno fmt\b/.test(s.run));
}

Deno.test("static-checks runs deno fmt in check mode", () => {
  const wf = readWorkflow(QUALITY_PATH);
  const step = fmtStep(wf.jobs["static-checks"].steps);
  assert(step, "Expected a deno fmt step in the static-checks job");
  const run = String(step.run);
  assert(
    /\bdeno fmt\b[^\n]*--check/.test(run),
    `deno fmt must run with --check so drift fails CI, got: ${run}`,
  );
});

Deno.test("static-checks does not apply formatting in write mode", () => {
  const wf = readWorkflow(QUALITY_PATH);
  const step = fmtStep(wf.jobs["static-checks"].steps);
  assert(step, "Expected a deno fmt step in the static-checks job");
  const run = String(step.run).trim();
  // A bare `deno fmt` (no --check) rewrites files only in the runner and
  // is discarded, so committed drift slips through. Reject it.
  assert(
    run.includes("--check"),
    `deno fmt must not run in write mode in CI, got: ${run}`,
  );
});
