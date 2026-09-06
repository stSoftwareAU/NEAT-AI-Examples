import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the `dependency-review` job does not persist the workflow
 * `GITHUB_TOKEN` in the workspace (Issue #812).
 *
 * Root cause: `actions/checkout` writes the job's token into `.git/config` as
 * an auth header unless `persist-credentials: false` is set. This job only
 * resolves the PR comparison refs and runs `dependency-review-action` over the
 * dependency-graph diff — it never pushes back to the repository and fetches no
 * private submodule — so the persisted credential buys nothing, while a
 * compromised step could read it back and act as the token. The action receives
 * its own token through `repo-token` (defaulting to `github.token`), not
 * through `.git/config`.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its structure rather than grepping source text.
 */

const DEPENDENCY_REVIEW_PATH = ".github/workflows/dependency-review.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

function dependencyReviewJob(): Job {
  const wf = parse(Deno.readTextFileSync(DEPENDENCY_REVIEW_PATH)) as Record<string, unknown>;
  const jobs = wf.jobs as Record<string, Job>;
  const job = jobs["dependency-review"];
  assert(job, "Expected a `dependency-review` job in dependency-review.yml");
  return job;
}

function dependencyReviewSteps(): Step[] {
  return (dependencyReviewJob().steps ?? []) as Step[];
}

Deno.test("dependency-review.yml dependency-review job — every checkout drops the credential", () => {
  const checkouts = dependencyReviewSteps().filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(
    checkouts.length > 0,
    "Expected at least one actions/checkout step in the dependency-review job",
  );
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job only ` +
        `reviews the dependency diff and never pushes, so the GITHUB_TOKEN must not be ` +
        `left readable in .git/config (Issue #812)`,
    );
  }
});

Deno.test("dependency-review.yml dependency-review job — no step pushes back to the repository", () => {
  for (const step of dependencyReviewSteps()) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #812 fix before allowing this`,
    );
  }
});
