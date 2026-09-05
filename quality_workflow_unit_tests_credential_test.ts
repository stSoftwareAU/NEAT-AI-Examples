import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `unit-tests` job of the Quality Check workflow does not persist
 * the workflow `GITHUB_TOKEN` in the workspace (Issue #817).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. The `unit-tests`
 * job never pushes back to the repository and fetches no private submodule, so
 * the persisted credential buys nothing — and this job runs the PR's own test
 * suite with `--allow-run=...,git,...`, so any test could read the token back
 * with a single `git config --get http.https://github.com/.extraheader`.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const QUALITY_PATH = ".github/workflows/quality.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function unitTestsJob(): Job {
  const wf = parse(Deno.readTextFileSync(QUALITY_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["unit-tests"];
  assert(job, "Expected a `unit-tests` job in quality.yml");
  return job;
}

function unitTestsSteps(): Step[] {
  return (unitTestsJob().steps ?? []) as Step[];
}

/** Checkout steps that clone this repository (no explicit `repository:` input). */
function ownCheckouts(): Step[] {
  return unitTestsSteps().filter((s) => {
    if (typeof s.uses !== "string" || !s.uses.includes("actions/checkout")) return false;
    const withBlock = (s.with ?? {}) as Record<string, unknown>;
    return withBlock["repository"] === undefined;
  });
}

Deno.test("quality.yml unit-tests job — checkout does not persist a credential", () => {
  const checkouts = ownCheckouts();
  assert(checkouts.length > 0, "Expected at least one actions/checkout step in the unit-tests job");
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job never ` +
        `pushes, so the GITHUB_TOKEN must not be left readable in .git/config`,
    );
  }
});

Deno.test("quality.yml unit-tests job — no step pushes back to the repository", () => {
  for (const step of unitTestsSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #817 fix before allowing this`,
    );
  }
});
