import { assert } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the CI quality gate enforces formatting drift with
 * `deno fmt --check` rather than applying the formatter in write mode
 * (Issue #663).
 *
 * Root cause: the `static-checks` job's formatting step ran plain
 * `deno fmt`, which reformats files only in the ephemeral runner and
 * never fails the job. Committed formatting drift therefore passed CI
 * unnoticed. Running `deno fmt --check` makes drift fail the pull
 * request, matching the already-enforced `deno lint` gate.
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
function staticCheckSteps(): any[] {
  const wf = readWorkflow(QUALITY_PATH);
  const job = wf.jobs["static-checks"];
  assert(job, "Expected a static-checks job in quality.yml");
  return job.steps;
}

// deno-lint-ignore no-explicit-any
function fmtStep(steps: any[]): any {
  return steps.find(
    (s) => typeof s.run === "string" && /(^|\s)deno fmt(\s|$)/.test(s.run),
  );
}

Deno.test("static-checks runs deno fmt in check mode", () => {
  const step = fmtStep(staticCheckSteps());
  assert(step, "Expected a step that runs deno fmt in static-checks");
  const run = String(step.run);
  assert(
    /deno fmt --check/.test(run),
    `Formatter step must run 'deno fmt --check' to fail on drift, got: ${run}`,
  );
});

Deno.test("static-checks never applies the formatter in write mode", () => {
  const step = fmtStep(staticCheckSteps());
  assert(step, "Expected a step that runs deno fmt in static-checks");
  const run = String(step.run);
  // A bare `deno fmt` (write mode) would silently fix drift in the
  // runner and never fail the PR — reject it.
  assert(
    !/(^|\s|&&|;)\s*deno fmt(?!\s+--check)(\s|$)/.test(run),
    `Formatter step must not run write-mode 'deno fmt', got: ${run}`,
  );
});

Deno.test("committed tree has no deno fmt drift", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["fmt", "--check"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  assert(
    code === 0,
    `deno fmt --check reported drift:\n${new TextDecoder().decode(stderr)}`,
  );
});
