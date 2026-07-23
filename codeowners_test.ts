import { assert } from "@std/assert";

/**
 * Verify the repository ships a CODEOWNERS file covering its privileged
 * surfaces (Issue #654).
 *
 * The ten workflows under `.github/workflows/` run with secrets beyond the
 * default `GITHUB_TOKEN` — the write-capable `ACTIONS_PUSH` PAT plus the
 * Semgrep and Codecov tokens. Without a CODEOWNERS rule covering that path,
 * a self-approving account can merge a workflow edit that then executes with
 * those secrets in scope. CODEOWNERS is the mechanism GitHub branch
 * protection uses to *require* a designated owner's review on exactly these
 * high-blast-radius paths. The supply-chain scripts (`bump-deps.sh`,
 * `bump_deps.ts`, `quality.sh`) carry the same blast radius and must be
 * owned too.
 *
 * These are "what" tests — they assert on the published artefact's content,
 * which is the deliverable. Enabling the "Require review from Code Owners"
 * branch-protection rule is a repo-level GitHub setting that is not
 * statically visible from the clone and so is out of scope for these tests.
 */

const CODEOWNERS_PATH = ".github/CODEOWNERS";

/** A GitHub team owner reference, e.g. `@stSoftwareAU/developers`. */
const OWNER_PATTERN = /@[A-Za-z0-9-]+\/[A-Za-z0-9-]+/;

function readCodeowners(): string {
  return Deno.readTextFileSync(CODEOWNERS_PATH);
}

/** Return the non-empty, non-comment rule lines. */
function ruleLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Find the rule whose pattern (first token) equals `pattern`. */
function ruleFor(text: string, pattern: string): string | undefined {
  return ruleLines(text).find((line) => line.split(/\s+/)[0] === pattern);
}

Deno.test("CODEOWNERS exists under .github/", () => {
  assert(
    Deno.statSync(CODEOWNERS_PATH).isFile,
    "Expected .github/CODEOWNERS to be a file",
  );
});

Deno.test("CODEOWNERS assigns an owner to every rule", () => {
  const lines = ruleLines(readCodeowners());
  assert(lines.length > 0, "Expected at least one CODEOWNERS rule");
  for (const line of lines) {
    assert(
      OWNER_PATTERN.test(line),
      `Expected rule to name a team owner: ${line}`,
    );
  }
});

Deno.test("CODEOWNERS covers the privileged .github/workflows/ path", () => {
  const rule = ruleFor(readCodeowners(), "/.github/workflows/");
  assert(
    rule !== undefined,
    "Expected a CODEOWNERS rule for /.github/workflows/",
  );
  assert(
    OWNER_PATTERN.test(rule),
    "Expected the /.github/workflows/ rule to name a team owner",
  );
});

// Issue #682 moved the shared Deno setup out of the four workflow bodies
// and into a local composite action. That action runs inside every one of
// those jobs, so it executes with exactly the same secrets in scope
// (ACTIONS_PUSH, CODECOV_TOKEN). Leaving `.github/actions/` unowned would
// reopen the poisoned-pipeline path the `/.github/workflows/` rule closes,
// by letting privileged CI code be edited one directory across.
Deno.test("CODEOWNERS covers the privileged .github/actions/ path", () => {
  const rule = ruleFor(readCodeowners(), "/.github/actions/");
  assert(
    rule !== undefined,
    "Expected a CODEOWNERS rule for /.github/actions/ — local composite " +
      "actions run with the same secrets as the workflows that call them",
  );
  assert(
    OWNER_PATTERN.test(rule),
    "Expected the /.github/actions/ rule to name a team owner",
  );
});

Deno.test("CODEOWNERS covers the supply-chain scripts", () => {
  const text = readCodeowners();
  for (const path of ["/bump-deps.sh", "/bump_deps.ts", "/quality.sh"]) {
    const rule = ruleFor(text, path);
    assert(rule !== undefined, `Expected a CODEOWNERS rule for ${path}`);
    assert(
      OWNER_PATTERN.test(rule),
      `Expected the ${path} rule to name a team owner`,
    );
  }
});

Deno.test("CODEOWNERS owns itself so ownership cannot be quietly changed", () => {
  const rule = ruleFor(readCodeowners(), "/.github/CODEOWNERS");
  assert(
    rule !== undefined,
    "Expected a CODEOWNERS rule for /.github/CODEOWNERS itself",
  );
});
