import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `shellcheck` job of the ShellCheck workflow does not persist the
 * workflow `GITHUB_TOKEN` in the workspace (Issue #821).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. The `shellcheck`
 * job only lints the checked-out shell scripts — it never pushes back to the
 * repository and fetches no private submodule — so the persisted credential
 * buys nothing, while a compromised step could read it back and act as the
 * token.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const SHELLCHECK_PATH = ".github/workflows/shellcheck.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function shellcheckJob(): Job {
  const wf = parse(Deno.readTextFileSync(SHELLCHECK_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["shellcheck"];
  assert(job, "Expected a `shellcheck` job in shellcheck.yml");
  return job;
}

function shellcheckSteps(): Step[] {
  return (shellcheckJob().steps ?? []) as Step[];
}

Deno.test("shellcheck.yml shellcheck job — every checkout drops the credential", () => {
  const checkouts = shellcheckSteps().filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(
    checkouts.length > 0,
    "Expected at least one actions/checkout step in the shellcheck job",
  );
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job only ` +
        `lints the checked-out shell scripts and never pushes, so the GITHUB_TOKEN must ` +
        `not be left readable in .git/config (Issue #821)`,
    );
  }
});

Deno.test("shellcheck.yml shellcheck job — no step pushes back to the repository", () => {
  for (const step of shellcheckSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #821 fix before allowing this`,
    );
  }
});
