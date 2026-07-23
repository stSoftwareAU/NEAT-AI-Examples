import { assert } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify every job in the Quality Check workflow declares a job-level
 * `timeout-minutes` (Issue #680).
 *
 * Root cause: the `quality` aggregate job (`name: Run quality checks`) had
 * no `timeout-minutes`, so it inherited GitHub's 360-minute default. That
 * job is the required `Run quality checks` branch-protection context — a
 * wedged runner would occupy a slot for six hours and hang every PR queued
 * behind it on "Expected — waiting for status".
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they
 * parse it and assert on its effective configuration (each job's timeout
 * bound) rather than grepping source text.
 */

const QUALITY_PATH = ".github/workflows/quality.yml";

// deno-lint-ignore no-explicit-any
function readWorkflow(path: string): any {
  return parse(Deno.readTextFileSync(path));
}

Deno.test("every job declares a positive timeout-minutes", () => {
  const wf = readWorkflow(QUALITY_PATH);
  const jobs = wf.jobs as Record<string, { "timeout-minutes"?: unknown }>;
  for (const [id, job] of Object.entries(jobs)) {
    const timeout = job["timeout-minutes"];
    assert(
      typeof timeout === "number" && timeout > 0,
      `Job "${id}" must declare a positive timeout-minutes, got: ${JSON.stringify(timeout)}`,
    );
  }
});

Deno.test("the aggregate quality job has a small timeout bound", () => {
  const wf = readWorkflow(QUALITY_PATH);
  const job = wf.jobs.quality as { "timeout-minutes"?: unknown };
  const timeout = job["timeout-minutes"];
  assert(
    typeof timeout === "number" && timeout > 0 && timeout <= 15,
    `The aggregate quality job only compares three needs results, so it ` +
      `should carry a small timeout bound (<=15), got: ${JSON.stringify(timeout)}`,
  );
});
