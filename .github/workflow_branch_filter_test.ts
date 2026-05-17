// Tests for .github/workflows/*.yml branch filters (Issue #435).
//
// Bug: workflows declaring `pull_request.branches: ["*"]` do NOT trigger
// for PRs whose base branch contains a `/` — the glob `*` matches any
// branch name segment but NOT a `/`. That caused PRs against
// `milestone/refresh-2026-05` and `milestone/idle-task-security-scan`
// to receive zero workflow runs (see issue #435 and PR #424 with no
// reported checks).
//
// Fix: workflows that should run on every PR must use `["**"]`
// (or omit the filter entirely). `**` matches any branch name
// including segments separated by `/`.

import { assert } from "@std/assert";
import { parse } from "@std/yaml";

// deno-lint-ignore no-explicit-any
type Workflow = any;

const WORKFLOW_DIR = new URL("./workflows/", import.meta.url);

// Workflows that should run on every PR regardless of base branch.
// `quality.yml` and `deno-outdated.yml` deliberately restrict to
// `Develop` and are excluded.
const ALL_BRANCH_WORKFLOWS = [
  "dependency-review.yml",
  "gitleaks.yml",
  "markdown-lint.yml",
  "semgrep.yml",
  "shellcheck.yml",
];

async function loadWorkflow(name: string): Promise<Workflow> {
  const path = new URL(name, WORKFLOW_DIR);
  const text = await Deno.readTextFile(path);
  return parse(text) as Workflow;
}

function prBranches(wf: Workflow): unknown {
  // YAML parser may decode the top-level `on` key as the boolean `true`
  // (yaml 1.1 quirk) — try both keys.
  // deno-lint-ignore no-explicit-any
  const w = wf as Record<string, any>;
  const on = (w.on ?? w["true"]) as Record<string, unknown> | undefined;
  if (!on) return undefined;
  const pr = on.pull_request as Record<string, unknown> | undefined;
  if (!pr) return undefined;
  return pr.branches;
}

for (const wf of ALL_BRANCH_WORKFLOWS) {
  Deno.test(
    `${wf} — pull_request.branches matches branches containing slashes`,
    async () => {
      const doc = await loadWorkflow(wf);
      const branches = prBranches(doc);

      // Acceptable forms: undefined (no filter — fires on all branches),
      // or a list containing `**` (matches branches with `/`).
      if (branches === undefined) return;

      assert(
        Array.isArray(branches),
        `${wf}: pull_request.branches must be a list, got ${typeof branches}`,
      );
      const patterns = branches as string[];

      // `["*"]` is the bug — `*` does not match `/`, so PRs against
      // `milestone/...` are silently skipped.
      assert(
        !patterns.includes("*") || patterns.includes("**"),
        `${wf}: pull_request.branches includes "*" which does NOT match ` +
          `branches with slashes (e.g. milestone/refresh-2026-05). ` +
          `Use "**" instead. Got: ${JSON.stringify(patterns)}`,
      );

      // Positive assertion: at least one pattern must match a slashed branch.
      const hasSlashMatcher = patterns.some((p) =>
        p === "**" || p.includes("**") || p.includes("/")
      );
      assert(
        hasSlashMatcher,
        `${wf}: pull_request.branches must include a pattern that ` +
          `matches branches with slashes (e.g. "**"). Got: ${JSON.stringify(patterns)}`,
      );
    },
  );
}
