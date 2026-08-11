import { assert } from "@std/assert";

/**
 * Verify docs/monitoring-neat-ai.md stays live guidance rather than a stale
 * record of a finished campaign (Issue #791).
 *
 * These are "what" tests — the published document is the deliverable, so the
 * assertions are on its content:
 *
 * 1. Every GitHub blob link into an `stSoftwareAU/*` repo must target a branch
 *    that exists. NEAT-AI's default branch is `Develop`; it has no `main`, so a
 *    `/blob/main/` link 404s.
 * 2. Any hard-coded issue range must be marked as history. A live procedure
 *    anchored to a closed campaign reads as current guidance long after the
 *    campaign ends.
 */

const DOC_PATH = "docs/monitoring-neat-ai.md";

function readDoc(): string {
  return Deno.readTextFileSync(DOC_PATH);
}

/** Matches an issue range such as `#371–#390` (en dash) or `#371-#390`. */
const ISSUE_RANGE = /#\d+\s*[–—-]\s*#\d+/g;

/** Wording that marks a range as a past application rather than live scope. */
const HISTORY_MARKER = /first application|historic|closed|originally|were the/i;

Deno.test("monitoring doc links to NEAT-AI's deno.json on an existing branch", () => {
  const text = readDoc();
  assert(
    text.includes("https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/deno.json"),
    "Expected the deno.json link to target NEAT-AI's default branch (Develop)",
  );
  assert(
    !/stSoftwareAU\/NEAT-AI[\w-]*\/blob\/main\//.test(text),
    "NEAT-AI has no `main` branch — /blob/main/ links 404",
  );
});

Deno.test("monitoring doc does not anchor live scope to a hard-coded issue range", () => {
  // Compare against a single-spaced copy so the check survives line rewrapping.
  const text = readDoc().replace(/\s+/g, " ");
  const offenders = [...text.matchAll(ISSUE_RANGE)]
    .map((match) => text.slice(Math.max(0, match.index - 160), match.index + 160))
    .filter((context) => !HISTORY_MARKER.test(context));

  assert(
    offenders.length === 0,
    `Hard-coded issue ranges must be marked as history, found:\n${offenders.join("\n---\n")}`,
  );
});

Deno.test("monitoring doc keeps the de-duplication procedure and defect template", () => {
  const text = readDoc();
  assert(text.includes("gh issue list"), "Expected the de-duplication search command");
  assert(/## 4\. Defect issue template/.test(text), "Expected the defect issue template section");
  assert(
    text.includes("<!-- MONITOR-NEAT-AI-START -->"),
    "Expected the injectable checklist block",
  );
});
