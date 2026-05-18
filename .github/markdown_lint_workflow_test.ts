// Tests for .github/workflows/markdown-lint.yml (Issue #435).
//
// The Markdown Lint workflow must trigger on push to the repository's
// default branch (`Develop`) as well as on every pull request. Without
// the `Develop` entry in the push trigger list, the workflow does not
// automatically run after a PR is merged into `Develop`, so drift
// introduced by a merge commit is never linted — the bug reported in
// Issue #435.

import { assert, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/markdown-lint.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

function triggers(wf: Workflow): Record<string, unknown> {
  // YAML 1.1 treats `on` as a boolean; @std/yaml uses YAML 1.2 and keeps
  // it as the string `on`. Accept both for safety.
  return (wf.on ?? wf["true"] ?? wf[true as unknown as string]) as Record<
    string,
    unknown
  >;
}

Deno.test("markdown-lint workflow — triggers on push to Develop", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  assertExists(t, "workflow must declare triggers");
  const push = t.push as { branches?: string[] } | undefined;
  assertExists(push, "workflow must trigger on push");
  assertExists(push.branches, "push trigger must declare branches");
  assert(
    push.branches.includes("Develop"),
    `push trigger must include the default branch 'Develop' so the workflow runs after merges (got ${
      JSON.stringify(push.branches)
    })`,
  );
});

Deno.test("markdown-lint workflow — triggers on pull_request to any branch", async () => {
  const wf = await loadWorkflow();
  const t = triggers(wf);
  const pr = t.pull_request as { branches?: string[] } | undefined;
  assertExists(pr, "workflow must trigger on pull_request");
  assertExists(pr.branches, "pull_request trigger must declare branches");
  assert(
    pr.branches.includes("*") || pr.branches.includes("**"),
    `pull_request must run for PRs against any branch (got ${JSON.stringify(pr.branches)})`,
  );
});
