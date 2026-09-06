import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `semgrep` job of the Semgrep SAST workflow does not persist the
 * workflow `GITHUB_TOKEN` in the workspace (Issue #820).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. The `semgrep` job
 * only runs `semgrep ci` over the checked-out tree — it never pushes back to
 * the repository and fetches no private submodule — so the persisted
 * credential buys nothing, while a compromised ruleset or dependency inside
 * the scanner container could read it back and act as the token.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const SEMGREP_PATH = ".github/workflows/semgrep.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function semgrepJob(): Job {
  const wf = parse(Deno.readTextFileSync(SEMGREP_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["semgrep"];
  assert(job, "Expected a `semgrep` job in semgrep.yml");
  return job;
}

function semgrepSteps(): Step[] {
  return (semgrepJob().steps ?? []) as Step[];
}

Deno.test("semgrep.yml semgrep job — every checkout drops the credential", () => {
  const checkouts = semgrepSteps().filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(
    checkouts.length > 0,
    "Expected at least one actions/checkout step in the semgrep job",
  );
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job only ` +
        `scans the checked-out tree and never pushes, so the GITHUB_TOKEN must not be ` +
        `left readable in .git/config (Issue #820)`,
    );
  }
});

Deno.test("semgrep.yml semgrep job — no step pushes back to the repository", () => {
  for (const step of semgrepSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #820 fix before allowing this`,
    );
  }
});
