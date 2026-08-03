import { assert } from "@std/assert";

/**
 * Verify the repository ships a CHANGELOG.md in Keep a Changelog format (Issue #721).
 *
 * The changelog is the single chronological record of notable behaviour changes
 * across the example suite, which otherwise live only in issue threads and
 * AGENTS.md exception notes. These are "what" tests — they assert on the
 * published artefact, which is the deliverable.
 */

const CHANGELOG_PATH = "CHANGELOG.md";

function readChangelog(): string {
  return Deno.readTextFileSync(CHANGELOG_PATH);
}

Deno.test("CHANGELOG.md exists at the repository root", () => {
  assert(Deno.statSync(CHANGELOG_PATH).isFile, "Expected CHANGELOG.md to be a file");
});

Deno.test("CHANGELOG.md follows the Keep a Changelog format", () => {
  const text = readChangelog();
  assert(/^# Changelog/m.test(text), "Expected a top-level '# Changelog' heading");
  assert(
    text.includes("https://keepachangelog.com/"),
    "Expected CHANGELOG.md to cite the Keep a Changelog format",
  );
  assert(
    /^## \[Unreleased\]/m.test(text),
    "Expected an '## [Unreleased]' section for pending changes",
  );
});

Deno.test("CHANGELOG.md is back-filled with issue-referenced entries", () => {
  const text = readChangelog();
  // Entries are bullets that may wrap over several indented continuation lines.
  const entries = text.split(/\n(?=- )/).slice(1);
  assert(entries.length > 0, "Expected at least one changelog entry");
  assert(
    entries.every((entry) => /\(#\d+\)/.test(entry)),
    "Expected every changelog entry to reference the issue that drove the change",
  );
});

Deno.test("CONTRIBUTING.md PR checklist keeps the changelog current", () => {
  const text = Deno.readTextFileSync("CONTRIBUTING.md");
  const checklistItems = text.split("\n").filter((line) => line.startsWith("- [ ]"));
  assert(
    checklistItems.some((item) => item.toLowerCase().includes("changelog")),
    "Expected the PR checklist to include a changelog item",
  );
});
