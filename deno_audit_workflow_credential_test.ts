import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `audit` job of the Deno audit workflow does not persist the
 * workflow `GITHUB_TOKEN` in the workspace (Issue #811).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. The `audit` job
 * only runs `deno audit --frozen` over the checked-out lockfile — it never
 * pushes back to the repository and fetches no private submodule — so the
 * persisted credential buys nothing, while a compromised dependency read
 * during the audit could read it back and act as the token.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const AUDIT_PATH = ".github/workflows/deno-audit.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function auditJob(): Job {
  const wf = parse(Deno.readTextFileSync(AUDIT_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["audit"];
  assert(job, "Expected an `audit` job in deno-audit.yml");
  return job;
}

function auditSteps(): Step[] {
  return (auditJob().steps ?? []) as Step[];
}

Deno.test("deno-audit.yml audit job — every checkout drops the credential", () => {
  const checkouts = auditSteps().filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(
    checkouts.length > 0,
    "Expected at least one actions/checkout step in the audit job",
  );
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job only ` +
        `audits the checked-out lockfile and never pushes, so the GITHUB_TOKEN must not ` +
        `be left readable in .git/config (Issue #811)`,
    );
  }
});

Deno.test("deno-audit.yml audit job — no step pushes back to the repository", () => {
  for (const step of auditSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #811 fix before allowing this`,
    );
  }
});
