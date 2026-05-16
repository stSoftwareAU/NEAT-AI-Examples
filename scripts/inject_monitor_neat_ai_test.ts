// Unit tests for scripts/inject-monitor-neat-ai.sh.
//
// The shell script under test is exercised end-to-end via a mock `gh`
// binary that records every invocation and returns canned bodies. The
// tests cover:
//   - First run injects the snippet at the end of `## Acceptance Criteria`.
//   - Re-running is idempotent (skipped (already present)).
//   - When no `## Acceptance Criteria` block exists, a new section is added.
//   - `gh issue edit` failure propagates as a non-zero exit.
//
// Tests run via `deno test` from the project root; the shared
// `quality.sh` already type-checks every `*.ts` and runs the full test
// suite, so no additional wiring is required.

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = new URL("../", import.meta.url).pathname;
const SCRIPT_PATH = `${SCRIPT_DIR}inject-monitor-neat-ai.sh`;
const SNIPPET_SOURCE = `${REPO_ROOT}docs/monitoring-neat-ai.md`;

const START_MARKER = "<!-- MONITOR-NEAT-AI-START -->";
const END_MARKER = "<!-- MONITOR-NEAT-AI-END -->";

/**
 * Write a mock `gh` shell script into `dir` that returns the contents of
 * `bodyFile` from `gh issue view`, records every invocation into
 * `${dir}/calls.log`, and writes the body passed to `gh issue edit
 * --body-file` into `${dir}/edited-<NUM>.md`. If `editExitCode` is non-zero
 * the edit subcommand fails with that exit code.
 */
async function writeMockGh(
  dir: string,
  bodyFile: string,
  editExitCode = 0,
): Promise<string> {
  const ghPath = `${dir}/gh`;
  const script = `#!/bin/bash
set -euo pipefail
echo "$@" >> "${dir}/calls.log"
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  cat "${bodyFile}"
  exit 0
fi
if [[ "$1" == "issue" && "$2" == "edit" ]]; then
  num="$3"
  # Locate --body-file <path>
  body_path=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--body-file" ]]; then
      body_path="$2"
      break
    fi
    shift
  done
  if [[ -n "\${body_path}" ]]; then
    cp "\${body_path}" "${dir}/edited-\${num}.md"
  fi
  exit ${editExitCode}
fi
exit 99
`;
  await Deno.writeTextFile(ghPath, script);
  await Deno.chmod(ghPath, 0o755);
  return ghPath;
}

async function runScript(
  ghBin: string,
  issues: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    env: {
      GH_BIN: ghBin,
      REPO: "stSoftwareAU/NEAT-AI-Examples",
      ISSUES: issues,
      SNIPPET_SOURCE,
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("inject-monitor-neat-ai: first run injects snippet into Acceptance Criteria", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const bodyFile = `${tmp}/body.md`;
    const initial = [
      "## Summary",
      "Demo issue.",
      "",
      "## Acceptance Criteria",
      "- [ ] First criterion.",
      "- [ ] Second criterion.",
      "",
      "## Dependencies",
      "Depends on #1",
      "",
    ].join("\n");
    await Deno.writeTextFile(bodyFile, initial);
    const ghBin = await writeMockGh(tmp, bodyFile);

    const { code, stdout } = await runScript(ghBin, "100");
    assertEquals(code, 0, `stdout: ${stdout}`);
    assert(stdout.includes("#100: injected"), `stdout: ${stdout}`);

    const updated = await Deno.readTextFile(`${tmp}/edited-100.md`);
    assert(updated.includes(START_MARKER));
    assert(updated.includes(END_MARKER));
    // The snippet must sit at the end of the Acceptance Criteria block —
    // i.e. before the next H2 heading.
    const markerIdx = updated.indexOf(START_MARKER);
    const depsIdx = updated.indexOf("## Dependencies");
    assert(markerIdx > 0, "snippet should be present");
    assert(
      markerIdx < depsIdx,
      "snippet should appear before ## Dependencies",
    );
    // The existing criteria are preserved.
    assert(updated.includes("- [ ] First criterion."));
    assert(updated.includes("- [ ] Second criterion."));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("inject-monitor-neat-ai: second run is idempotent (skipped)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const bodyFile = `${tmp}/body.md`;
    const already = [
      "## Summary",
      "Demo issue.",
      "",
      "## Acceptance Criteria",
      "- [ ] Existing criterion.",
      "",
      START_MARKER,
      "",
      "- [ ] Monitor NEAT-AI behaviour during this run.",
      "",
      END_MARKER,
      "",
      "## Dependencies",
      "Depends on #1",
      "",
    ].join("\n");
    await Deno.writeTextFile(bodyFile, already);
    const ghBin = await writeMockGh(tmp, bodyFile);

    const { code, stdout } = await runScript(ghBin, "200");
    assertEquals(code, 0, `stdout: ${stdout}`);
    assert(
      stdout.includes("#200: skipped (already present)"),
      `stdout: ${stdout}`,
    );

    // gh issue edit must NOT have been called.
    let editCalled = false;
    try {
      await Deno.stat(`${tmp}/edited-200.md`);
      editCalled = true;
    } catch (_e) {
      // expected — no edit file
    }
    assertEquals(editCalled, false, "gh issue edit should not be invoked");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("inject-monitor-neat-ai: appends new Acceptance Criteria section when none exists", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const bodyFile = `${tmp}/body.md`;
    const initial = [
      "## Summary",
      "Issue without an Acceptance Criteria section.",
      "",
    ].join("\n");
    await Deno.writeTextFile(bodyFile, initial);
    const ghBin = await writeMockGh(tmp, bodyFile);

    const { code, stdout } = await runScript(ghBin, "300");
    assertEquals(code, 0, `stdout: ${stdout}`);
    assert(stdout.includes("#300: injected"));

    const updated = await Deno.readTextFile(`${tmp}/edited-300.md`);
    assert(updated.includes("## Acceptance Criteria"));
    assert(updated.includes(START_MARKER));
    assert(updated.includes(END_MARKER));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("inject-monitor-neat-ai: gh edit failure produces non-zero exit", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const bodyFile = `${tmp}/body.md`;
    const initial = [
      "## Summary",
      "Demo issue.",
      "",
      "## Acceptance Criteria",
      "- [ ] One criterion.",
      "",
    ].join("\n");
    await Deno.writeTextFile(bodyFile, initial);
    // editExitCode = 1 simulates a failed `gh issue edit` invocation.
    const ghBin = await writeMockGh(tmp, bodyFile, 1);

    const { code, stdout } = await runScript(ghBin, "400");
    assert(code !== 0, `expected non-zero exit, got ${code}`);
    assert(stdout.includes("#400: error"), `stdout: ${stdout}`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("inject-monitor-neat-ai: exactly one START marker after injection", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const bodyFile = `${tmp}/body.md`;
    const initial = [
      "## Summary",
      "Demo issue.",
      "",
      "## Acceptance Criteria",
      "- [ ] Existing.",
      "",
    ].join("\n");
    await Deno.writeTextFile(bodyFile, initial);
    const ghBin = await writeMockGh(tmp, bodyFile);

    const { code } = await runScript(ghBin, "500");
    assertEquals(code, 0);
    const updated = await Deno.readTextFile(`${tmp}/edited-500.md`);
    const occurrences = updated.split(START_MARKER).length - 1;
    assertEquals(occurrences, 1, "exactly one START marker expected");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
