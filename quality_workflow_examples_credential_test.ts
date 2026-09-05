import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `examples` job of the Quality Check workflow does not persist the
 * workflow `GITHUB_TOKEN` in the workspace (Issue #815).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. The `examples`
 * job only runs the demo scripts — it never pushes back to the repository and
 * fetches no private submodule — so the persisted credential buys nothing and
 * any later step (an example script, a compromised dependency) could read it
 * back and act as the token.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const QUALITY_PATH = ".github/workflows/quality.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function examplesJob(): Job {
  const wf = parse(Deno.readTextFileSync(QUALITY_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["examples"];
  assert(job, "Expected an `examples` job in quality.yml");
  return job;
}

function examplesSteps(): Step[] {
  return (examplesJob().steps ?? []) as Step[];
}

Deno.test("quality.yml examples job — checkout does not persist a credential", () => {
  const checkouts = examplesSteps().filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(checkouts.length > 0, "Expected at least one actions/checkout step in the examples job");
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

Deno.test("quality.yml examples job — no step pushes back to the repository", () => {
  for (const step of examplesSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #815 fix before allowing this`,
    );
  }
});
