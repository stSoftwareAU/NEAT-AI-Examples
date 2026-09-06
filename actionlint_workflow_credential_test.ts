import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `actionlint` job does not persist the workflow `GITHUB_TOKEN` in
 * the workspace (Issue #810).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. The `actionlint`
 * job only downloads the linter and runs it over the checked-out workflows —
 * it never pushes back to the repository and fetches no private submodule — so
 * the persisted credential buys nothing, while a compromised download or lint
 * rule could read it back and act as the token.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const ACTIONLINT_PATH = ".github/workflows/actionlint.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function actionlintJob(): Job {
  const wf = parse(Deno.readTextFileSync(ACTIONLINT_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["actionlint"];
  assert(job, "Expected an `actionlint` job in actionlint.yml");
  return job;
}

function actionlintSteps(): Step[] {
  return (actionlintJob().steps ?? []) as Step[];
}

Deno.test("actionlint.yml actionlint job — every checkout drops the credential", () => {
  const checkouts = actionlintSteps().filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(
    checkouts.length > 0,
    "Expected at least one actions/checkout step in the actionlint job",
  );
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job only ` +
        `lints the checked-out workflows and never pushes, so the GITHUB_TOKEN must not ` +
        `be left readable in .git/config (Issue #810)`,
    );
  }
});

Deno.test("actionlint.yml actionlint job — no step pushes back to the repository", () => {
  for (const step of actionlintSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #810 fix before allowing this`,
    );
  }
});
