import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `static-checks` job of the Quality Check workflow does not persist
 * the workflow `GITHUB_TOKEN` in the workspace (Issue #816).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. The `static-checks`
 * job only runs `deno lint`, `deno fmt --check` and `deno check` — it never
 * pushes back to the repository and fetches no private submodule — so the
 * persisted credential buys nothing and any later step (a compromised
 * dependency, an injected script) could read it back and act as the token.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const QUALITY_PATH = ".github/workflows/quality.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function staticChecksJob(): Job {
  const wf = parse(Deno.readTextFileSync(QUALITY_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["static-checks"];
  assert(job, "Expected a `static-checks` job in quality.yml");
  return job;
}

function staticChecksSteps(): Step[] {
  return (staticChecksJob().steps ?? []) as Step[];
}

Deno.test("quality.yml static-checks job — checkout does not persist a credential", () => {
  const checkouts = staticChecksSteps().filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(
    checkouts.length > 0,
    "Expected at least one actions/checkout step in the static-checks job",
  );
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

Deno.test("quality.yml static-checks job — no step pushes back to the repository", () => {
  for (const step of staticChecksSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #816 fix before allowing this`,
    );
  }
});
