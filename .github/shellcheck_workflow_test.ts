// Behavioural tests for the ShellCheck lint gate (Issue #751).
//
// The gate used to run through the third-party `ludeeus/action-shellcheck`
// wrapper, which is dormant — no release since 2023-01 and no push since
// 2024-06 — so the SHA it was pinned to could never receive a fix. The wrapper
// is gone: the job now invokes the `shellcheck` binary preinstalled on the
// `ubuntu-latest` runner directly, which removes the orphaned dependency
// instead of swapping it for another one.
//
// These tests execute the workflow's own `run:` body — the real gate — rather
// than inspecting its text, so they keep proving the behaviour that matters:
// every shell script in the tree is linted recursively, warning-and-above
// findings fail the job, info-level findings do not, and a discovery pattern
// that matches nothing fails loud rather than reporting a clean run.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadWorkflow, runSteps, usesRefs } from "./workflow_test_utils.ts";

const WORKFLOW = "shellcheck.yml";

/** Repository root, i.e. the parent of this `.github` directory. */
const REPO_ROOT = new URL("../", import.meta.url).pathname;

/** True when a `shellcheck` binary is on PATH (it is, on `ubuntu-latest`). */
async function shellcheckAvailable(): Promise<boolean> {
  try {
    const { code } = await new Deno.Command("bash", {
      args: ["-c", "command -v shellcheck"],
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
}

const HAS_SHELLCHECK = await shellcheckAvailable();

/** The workflow's lint step body — the gate under test. */
async function lintStepBody(): Promise<string> {
  const linting = runSteps(await loadWorkflow(WORKFLOW))
    .filter(({ run }) => run.includes("shellcheck"));
  assertEquals(
    linting.length,
    1,
    `${WORKFLOW}: expected exactly one run: step invoking shellcheck, found ${linting.length}`,
  );
  return linting[0].run;
}

/** Runs the gate body with `cwd` as the scan root. */
async function runGate(cwd: string): Promise<{ code: number; output: string }> {
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: ["-c", await lintStepBody()],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, output: decoder.decode(stdout) + decoder.decode(stderr) };
}

Deno.test("shellcheck gate — depends on no third-party shellcheck wrapper action", async () => {
  const wrappers = usesRefs(await loadWorkflow(WORKFLOW))
    .filter(({ uses }) => /action-shellcheck/i.test(uses))
    .map(({ location, uses }) => `${location} uses '${uses}'`);
  assertEquals(
    wrappers,
    [],
    `${WORKFLOW}: the shellcheck wrapper actions are orphaned (Issue #751) — invoke the ` +
      "shellcheck binary preinstalled on the runner directly instead.",
  );
});

Deno.test({
  name: "shellcheck gate — every shell script in the repository passes",
  ignore: !HAS_SHELLCHECK,
  fn: async () => {
    const { code, output } = await runGate(REPO_ROOT);
    assertEquals(code, 0, `expected a clean repository to pass, got exit ${code}:\n${output}`);
    assertStringIncludes(output, "Linting ");
  },
});

Deno.test({
  name: "shellcheck gate — fails on a warning-level finding in a nested directory",
  ignore: !HAS_SHELLCHECK,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "shellcheck_gate_" });
    try {
      await Deno.writeTextFile(`${dir}/clean.sh`, "#!/bin/bash\nset -euo pipefail\necho ok\n");
      await Deno.mkdir(`${dir}/deep/nested`, { recursive: true });
      // SC2164 — `cd` without a failure guard — is a warning-level finding.
      await Deno.writeTextFile(`${dir}/deep/nested/bad.sh`, "#!/bin/bash\ncd /tmp\necho hi\n");

      const { code, output } = await runGate(dir);
      assert(code !== 0, `expected a warning-level finding to fail the gate:\n${output}`);
      assertStringIncludes(output, "SC2164");
      assertStringIncludes(output, "bad.sh");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "shellcheck gate — info-level findings do not fail the gate",
  ignore: !HAS_SHELLCHECK,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "shellcheck_gate_" });
    try {
      // SC2086 — an unquoted expansion — is info level, below the gate's
      // `severity=warning` threshold, exactly as the retired wrapper behaved.
      await Deno.writeTextFile(`${dir}/info.sh`, "#!/bin/bash\nfoo=$1\necho $foo\n");

      const { code, output } = await runGate(dir);
      assertEquals(code, 0, `expected an info-level finding to pass, got exit ${code}:\n${output}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "shellcheck gate — fails loud when discovery finds no shell scripts",
  ignore: !HAS_SHELLCHECK,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "shellcheck_gate_" });
    try {
      const { code, output } = await runGate(dir);
      assert(code !== 0, `an empty scan must fail loud, not report success:\n${output}`);
      assertStringIncludes(output, "No shell scripts");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
