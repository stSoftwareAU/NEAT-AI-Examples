// Tests for .github/scripts/detect_code_changes.sh (Issue #888).
//
// The script decides whether a pull request's changed paths need the
// expensive PR-gate jobs. These "what" tests feed it path lists on stdin
// and assert on the verdict it prints and its exit code.

import { assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";

const SCRIPT = new URL("./scripts/detect_code_changes.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the classifier under `bash` with `paths` joined onto stdin. */
async function classify(args: string[], paths: string[]): Promise<RunResult> {
  const child = new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(paths.join("\n")));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("code mode — a docs-only change needs no code checks", async () => {
  const result = await classify(["code"], [
    "README.md",
    "docs/archive/pr-summaries/pr-summary-1.md",
    "docs/screenshots/chart.svg",
    "docs/evidence/after.png",
    "LICENSE",
  ]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "false");
});

Deno.test("code mode — any source file among docs needs the code checks", async () => {
  for (
    const codePath of [
      "common/chart_scale.ts",
      "quality.sh",
      "deno.json",
      ".github/workflows/quality.yml",
      "LICENSE.txt",
    ]
  ) {
    const result = await classify(["code"], ["README.md", codePath]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "true", `${codePath} must count as code`);
  }
});

Deno.test("code mode — an empty change list fails safe to running the checks", async () => {
  const result = await classify(["code"], ["", ""]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "true");
});

Deno.test("markdown mode — a Markdown or lint-config change needs markdown-lint", async () => {
  for (
    const path of [
      "docs/factory_adoption.md",
      ".markdownlint-cli2.jsonc",
      ".github/workflows/markdown-lint.yml",
      ".github/scripts/detect_code_changes.sh",
      ".github/actions/detect-changes/action.yml",
    ]
  ) {
    const result = await classify(["markdown"], ["common/chart_scale.ts", path]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "true", `${path} must trigger markdown-lint`);
  }
});

Deno.test("markdown mode — a code-only change needs no markdown-lint", async () => {
  const result = await classify(["markdown"], [
    "common/chart_scale.ts",
    "docs/screenshots/chart.svg",
  ]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "false");
});

Deno.test("markdown mode — an empty change list fails safe to running markdown-lint", async () => {
  const result = await classify(["markdown"], []);
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "true");
});

Deno.test("a missing or unknown mode fails loud", async () => {
  for (const args of [[], ["docs"]]) {
    const result = await classify(args, ["README.md"]);
    assertNotEquals(result.code, 0, `mode ${JSON.stringify(args)} must fail`);
    assertEquals(result.stdout, "");
    assertStringIncludes(result.stderr, "usage:");
  }
});
