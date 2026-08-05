import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the auto-bump and security-update workflows grant `GITHUB_TOKEN`
 * read-only scopes (Issue #679).
 *
 * Root cause: both workflows declared write scopes that no step ever
 * exercises. Every write in these jobs rides the org `ACTIONS_PUSH` PAT by
 * design (#651) — the push authenticates via a PAT-bearing remote URL and
 * `gh pr create` runs with `GH_TOKEN: secrets.ACTIONS_PUSH`. An unused
 * `contents: write` / `pull-requests: write` grant widens the blast radius
 * of any compromised step (in `deno-outdated.yml` the job runs PR-authored
 * `bump-deps.sh`) for zero functional benefit.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they
 * parse it and assert on its structure rather than grepping source text.
 */

const OUTDATED_PATH = ".github/workflows/deno-outdated.yml";
const SECURITY_PATH = ".github/workflows/deno-security-update.yml";

// deno-lint-ignore no-explicit-any
type Workflow = any;

function readWorkflow(path: string): Workflow {
  return parse(Deno.readTextFileSync(path)) as Workflow;
}

/**
 * Every step of the workflow, across all jobs. Issue #747 split the auto-bump
 * push into its own `push-bump` job, so the least-privilege sweep below covers
 * the whole workflow rather than one named job.
 */
// deno-lint-ignore no-explicit-any
function stepsOf(wf: Workflow): any[] {
  // deno-lint-ignore no-explicit-any
  return Object.values(wf.jobs as Record<string, any>).flatMap((job) => job.steps ?? []);
}

/** Everything a step can read a token from: its `env`, `with` and `run` body. */
// deno-lint-ignore no-explicit-any
function surfaceOf(step: any): string {
  return JSON.stringify({ env: step.env ?? {}, with: step.with ?? {}, run: step.run ?? "" });
}

Deno.test("deno-outdated grants GITHUB_TOKEN read-only contents", () => {
  const perms = readWorkflow(OUTDATED_PATH).permissions;
  assertEquals(
    perms.contents,
    "read",
    "The bump commit is pushed with the ACTIONS_PUSH PAT, so GITHUB_TOKEN needs read only",
  );
});

Deno.test("deno-outdated grants no write scope at all", () => {
  const perms = readWorkflow(OUTDATED_PATH).permissions as Record<string, string>;
  const writes = Object.entries(perms).filter(([, v]) => v === "write");
  assertEquals(
    writes,
    [],
    `No step uses GITHUB_TOKEN for a write, so no write scope may be granted: ${
      JSON.stringify(writes)
    }`,
  );
});

Deno.test("deno-security-update grants GITHUB_TOKEN read-only contents", () => {
  const perms = readWorkflow(SECURITY_PATH).permissions;
  assertEquals(
    perms.contents,
    "read",
    "The advisory branch is pushed with the ACTIONS_PUSH PAT, so GITHUB_TOKEN needs read only",
  );
});

Deno.test("deno-security-update no longer requests pull-requests: write", () => {
  const perms = readWorkflow(SECURITY_PATH).permissions as Record<string, string>;
  assert(
    !("pull-requests" in perms),
    "gh pr create authenticates with GH_TOKEN: secrets.ACTIONS_PUSH, so the grant is unused",
  );
  const writes = Object.entries(perms).filter(([, v]) => v === "write");
  assertEquals(writes, [], `No write scope may be granted: ${JSON.stringify(writes)}`);
});

Deno.test("no step in either workflow uses GITHUB_TOKEN for a write", () => {
  for (const path of [OUTDATED_PATH, SECURITY_PATH]) {
    for (const step of stepsOf(readWorkflow(path))) {
      const surface = surfaceOf(step);
      if (!surface.includes("GITHUB_TOKEN")) continue;
      const run = String(step.run ?? "");
      assert(
        !run.includes("git push") && !run.includes("gh pr create"),
        `${path}: writes must ride the ACTIONS_PUSH PAT, found GITHUB_TOKEN in: ${step.name}`,
      );
    }
  }
});
