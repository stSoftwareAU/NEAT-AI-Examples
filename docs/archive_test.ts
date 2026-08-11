import { assert, assertEquals } from "@std/assert";

/**
 * Verify the PR-summary archive is a single corpus under
 * `docs/archive/pr-summaries/` (Issue #792).
 *
 * The archive used to be split across two undocumented locations — flat
 * `docs/archive/pr-summary-*.md` files for PRs #5–#447 and
 * `docs/archive/pr-summaries/pr-summary-*.md` from #457 on — so any glob over
 * either path silently missed most of the corpus. These are "what" tests: they
 * assert on the published artefacts (where the files live, whether their links
 * resolve, whether the convention is written down), never on how a script
 * produces them.
 */

const ARCHIVE_DIR = "docs/archive";
const SUMMARY_DIR = `${ARCHIVE_DIR}/pr-summaries`;
const SUMMARY_PATTERN = /^pr-summary-\d+\.md$/;

function summaryFiles(dir: string): string[] {
  return [...Deno.readDirSync(dir)]
    .filter((entry) => entry.isFile && entry.name.startsWith("pr-summary-"))
    .map((entry) => entry.name);
}

/**
 * Strip fenced code blocks and inline code spans so quoted markdown inside
 * backticks is not mistaken for a live link.
 */
function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function relativeLinks(markdown: string): string[] {
  return [...stripCode(markdown).matchAll(/\]\((\.\.?\/[^)\s]+)\)/g)]
    .map((match) => match[1].split("#")[0])
    .filter((target) => target.length > 0);
}

Deno.test("PR summaries live in docs/archive/pr-summaries/", () => {
  const summaries = summaryFiles(SUMMARY_DIR);

  assert(
    summaries.length > 250,
    `Expected the whole archive (295+ summaries) under ${SUMMARY_DIR}, found ${summaries.length}`,
  );
  for (const name of summaries) {
    assert(SUMMARY_PATTERN.test(name), `Unexpected file name in ${SUMMARY_DIR}: ${name}`);
    assertEquals(
      Deno.statSync(`${SUMMARY_DIR}/${name}`).isFile,
      true,
      `Expected ${SUMMARY_DIR}/${name} to be a file`,
    );
  }
});

Deno.test("No PR summary files remain loose in docs/archive/", () => {
  const stray = summaryFiles(ARCHIVE_DIR);

  assertEquals(
    stray,
    [],
    `PR summaries must live in ${SUMMARY_DIR}/, found loose in ${ARCHIVE_DIR}/: ${
      stray.join(", ")
    }`,
  );
});

Deno.test("No PR summary files remain in docs/ root", () => {
  const stray = summaryFiles("docs");

  assertEquals(
    stray,
    [],
    `PR summaries must live in ${SUMMARY_DIR}/, found in docs/: ${stray.join(", ")}`,
  );
});

Deno.test("Relative links in archived PR summaries resolve", () => {
  const broken: string[] = [];

  for (const name of summaryFiles(SUMMARY_DIR)) {
    const path = `${SUMMARY_DIR}/${name}`;
    const base = new URL(path, `file://${Deno.cwd()}/`);
    for (const target of relativeLinks(Deno.readTextFileSync(path))) {
      const resolved = new URL(target, base);
      try {
        Deno.statSync(resolved);
      } catch {
        broken.push(`${path} → ${target}`);
      }
    }
  }

  assertEquals(broken, [], `Broken relative links in archived PR summaries:\n${broken.join("\n")}`);
});

Deno.test("CONTRIBUTING.md documents the PR-summary archive location", () => {
  const text = Deno.readTextFileSync("CONTRIBUTING.md");

  assert(
    text.includes("docs/archive/pr-summaries/pr-summary-"),
    "Expected CONTRIBUTING.md to name docs/archive/pr-summaries/pr-summary-<PR>.md as the canonical path",
  );
});
