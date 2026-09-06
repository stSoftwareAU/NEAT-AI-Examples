import { assert } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the Quality Check workflow runs on pull requests targeting a
 * milestone branch, not only the default `Develop` branch (Issue #677).
 *
 * Root cause: `pull_request.branches` was restricted to `Develop`, so the
 * repository's test/lint/type-check/examples gate — and the required
 * `Run quality checks` status — never ran on milestone sub-issue PRs,
 * which target a shared `milestone/<slug>` branch. Every other PR-gating
 * workflow was widened to `branches: ["**"]` for exactly this reason
 * (Issue #435); `quality.yml` missed the change.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they
 * parse it and assert on its behaviour (which branches trigger a run)
 * rather than grepping source text.
 */

const QUALITY_PATH = ".github/workflows/quality.yml";

// deno-lint-ignore no-explicit-any
function readWorkflow(path: string): any {
  return parse(Deno.readTextFileSync(path));
}

// YAML 1.1 parses the bare key `on` as the boolean `true`, but @std/yaml
// preserves it as the string "on"; read it defensively either way.
// deno-lint-ignore no-explicit-any
function triggers(wf: any): any {
  return wf["on"] ?? wf[true as unknown as string];
}

/**
 * Minimal emulation of GitHub's branch-filter glob semantics for the
 * cases that matter here: a single `*` matches any run of characters
 * except `/`, while `**` matches across `/`. This lets the tests assert
 * on real triggering behaviour rather than on a literal array value.
 *
 * Matching is done directly against the pattern rather than by compiling
 * a dynamic `RegExp`, which Semgrep's `detect-non-literal-regexp` rule
 * flags as a ReDoS risk (SAST scan) and which is unnecessary for these
 * trusted, committed workflow patterns.
 */
function branchMatches(pattern: string, branch: string): boolean {
  return globMatch(pattern, 0, branch, 0);
}

/**
 * Recursively match a branch-filter glob against a branch name. `*` matches
 * any run of characters except `/`; `**` matches any run including `/`.
 */
function globMatch(
  pattern: string,
  pi: number,
  branch: string,
  bi: number,
): boolean {
  while (pi < pattern.length) {
    if (pattern[pi] === "*") {
      const doubleStar = pattern[pi + 1] === "*";
      const nextPi = pi + (doubleStar ? 2 : 1);
      // Try consuming zero or more characters at the current position.
      for (let k = bi; k <= branch.length; k++) {
        if (globMatch(pattern, nextPi, branch, k)) return true;
        // A single `*` must not consume a path separator.
        if (!doubleStar && branch[k] === "/") break;
      }
      return false;
    }
    if (bi >= branch.length || branch[bi] !== pattern[pi]) return false;
    pi++;
    bi++;
  }
  return bi === branch.length;
}

function anyBranchMatches(patterns: string[], branch: string): boolean {
  return patterns.some((p) => branchMatches(p, branch));
}

Deno.test("pull_request triggers on milestone branch PRs", () => {
  const wf = readWorkflow(QUALITY_PATH);
  const branches: string[] = triggers(wf).pull_request.branches;
  assert(Array.isArray(branches), "pull_request.branches must be a list");
  assert(
    anyBranchMatches(branches, "milestone/refresh-2026-05"),
    `Quality Check must run on milestone/<slug> PRs, got branches: ${JSON.stringify(branches)}`,
  );
});

Deno.test("pull_request still triggers on Develop PRs", () => {
  const wf = readWorkflow(QUALITY_PATH);
  const branches: string[] = triggers(wf).pull_request.branches;
  assert(
    anyBranchMatches(branches, "Develop"),
    `Quality Check must still run on Develop PRs, got branches: ${JSON.stringify(branches)}`,
  );
});

// Business-logic change (Issue #809): Quality Check is a PR gate, so it no
// longer runs on push to the default branch. The previous test here asserted
// the opposite (`push.branches` must include `Develop`); that post-merge run
// only duplicated the run that already gated the pull request — the most
// expensive duplicate in the repository, since it rebuilds rust_scorer and
// re-runs the whole Deno suite — and could leave a red tick on `Develop` for
// a check that had already passed. The assertion is inverted rather than
// deleted so the trigger stays pinned in both directions.
Deno.test("push does not re-run the gate on Develop", () => {
  const wf = readWorkflow(QUALITY_PATH);
  const push = triggers(wf).push as { branches?: string[] } | undefined;
  if (push === undefined || push === null) return; // no push trigger at all — the expected shape.
  const branches: string[] = push.branches ?? [];
  assert(
    !anyBranchMatches(branches, "Develop"),
    `push must not reach the default branch 'Develop' — the PR run already gated it ` +
      `(got ${JSON.stringify(branches)}). See Issue #809.`,
  );
  assert(
    !anyBranchMatches(branches, "milestone/refresh-2026-05"),
    `push should not fan out to milestone branches, got: ${JSON.stringify(branches)}`,
  );
});
