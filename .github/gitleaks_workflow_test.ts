// Tests for .github/workflows/gitleaks.yml (Issues #423, #681).
//
// Hardening: the workflow must NOT interpolate `${{ ... }}` expressions
// directly into `run:` shell scripts. Untrusted values must be passed
// through an `env:` mapping so the runner exports them as ordinary
// shell variables, avoiding any chance of shell-injection via crafted
// expression values.
//
// Strict mode (Issue #681): GitHub's default shell for `run:` is
// `bash -e {0}` — `errexit` only. Every multi-line `run:` block must open
// with `set -euo pipefail` so an unset variable fails loudly instead of
// expanding to an empty string, and a failure anywhere in a pipeline is
// not masked by the exit status of its last command.

import { assert, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/gitleaks.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

function allSteps(wf: Workflow): Array<Record<string, unknown>> {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const steps: Array<Record<string, unknown>> = [];
  for (const job of Object.values(jobs)) {
    const js = (job.steps ?? []) as Array<Record<string, unknown>>;
    steps.push(...js);
  }
  return steps;
}

Deno.test("gitleaks workflow — no run: step interpolates ${{ ... }} directly", async () => {
  const wf = await loadWorkflow();
  const steps = allSteps(wf);
  for (const step of steps) {
    const run = step.run;
    if (typeof run !== "string") continue;
    assert(
      !/\$\{\{[^}]+\}\}/.test(run),
      `run: in step "${step.name}" must not interpolate \${{ ... }} directly; pass via env: instead. Got:\n${run}`,
    );
  }
});

Deno.test("gitleaks workflow — Run Gitleaks step passes base_ref via env:", async () => {
  const wf = await loadWorkflow();
  const steps = allSteps(wf);
  const runStep = steps.find((s) => s.name === "Run Gitleaks");
  assertExists(runStep, "must have a 'Run Gitleaks' step");

  const env = (runStep.env ?? {}) as Record<string, string>;
  // base_ref must be supplied via env mapping (not inlined).
  const baseRefEnv = Object.values(env).find((v) =>
    typeof v === "string" && v.includes("github.base_ref")
  );
  assertExists(
    baseRefEnv,
    "Run Gitleaks step must expose github.base_ref via an env: mapping",
  );

  // The run: script must reference the env var, not the raw expression.
  const run = String(runStep.run ?? "");
  const envName = Object.keys(env).find((k) => env[k].includes("github.base_ref"));
  assertExists(envName, "env mapping for github.base_ref must have a name");
  assert(
    run.includes(`${envName}`),
    `run: script must reference the env var ${envName}, got:\n${run}`,
  );
  assert(
    !run.includes("github.base_ref"),
    `run: script must NOT inline github.base_ref directly, got:\n${run}`,
  );
});

/** Steps whose `run:` script spans more than one line. */
function multiLineRunSteps(wf: Workflow): Array<Record<string, unknown>> {
  return allSteps(wf).filter((s) =>
    typeof s.run === "string" && String(s.run).trim().includes("\n")
  );
}

/** First non-blank line of a `run:` script. */
function firstLine(run: string): string {
  return run.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/**
 * Runs a shell script the way GitHub Actions does by default —
 * `bash -e {0}` — inside `cwd`, and returns the exit code.
 */
async function runAsAction(
  script: string,
  cwd: string,
  env: Record<string, string>,
): Promise<number> {
  const scriptPath = `${cwd}/step.sh`;
  await Deno.writeTextFile(scriptPath, script);
  const command = new Deno.Command("bash", {
    args: ["-e", scriptPath],
    cwd,
    env,
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  });
  const { code } = await command.output();
  return code;
}

/** Writes an executable stub script and returns its path. */
async function writeStub(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, `#!/bin/bash\n${body}\n`);
  await Deno.chmod(path, 0o755);
  return path;
}

Deno.test("gitleaks workflow — every multi-line run: block enables strict mode", async () => {
  const wf = await loadWorkflow();
  const steps = multiLineRunSteps(wf);
  assert(steps.length > 0, "expected at least one multi-line run: block");
  for (const step of steps) {
    assert(
      firstLine(String(step.run)) === "set -euo pipefail",
      `run: in step "${step.name}" must start with 'set -euo pipefail' — the ` +
        `default shell is 'bash -e {0}' (errexit only). Got first line: ` +
        `"${firstLine(String(step.run))}"`,
    );
  }
});

Deno.test("gitleaks workflow — Run Gitleaks aborts instead of scanning when BASE_REF is unset", async () => {
  const wf = await loadWorkflow();
  const step = allSteps(wf).find((s) => s.name === "Run Gitleaks");
  assertExists(step, "must have a 'Run Gitleaks' step");

  const dir = await Deno.makeTempDir({ prefix: "gitleaks-step-" });
  try {
    // Stand-in for the downloaded binary: records that it was invoked.
    await writeStub(dir, "gitleaks", `printf 'scanned' > "${dir}/scanned"`);

    // BASE_REF deliberately absent, as it would be if the env: mapping
    // were renamed or the resolve step were skipped.
    const code = await runAsAction(String(step.run), dir, { PATH: "/usr/bin:/bin" });

    assert(
      code !== 0,
      "step must fail loudly when BASE_REF is unset, but it exited 0",
    );
    const scanned = await Deno.stat(`${dir}/scanned`).then(() => true, () => false);
    assert(
      !scanned,
      "gitleaks must not run with an empty base ref — that scans the wrong commit set",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitleaks workflow — Run Gitleaks still scans when BASE_REF is set", async () => {
  const wf = await loadWorkflow();
  const step = allSteps(wf).find((s) => s.name === "Run Gitleaks");
  assertExists(step, "must have a 'Run Gitleaks' step");

  const dir = await Deno.makeTempDir({ prefix: "gitleaks-step-" });
  try {
    await writeStub(dir, "gitleaks", `printf '%s' "$*" > "${dir}/args"`);

    const code = await runAsAction(String(step.run), dir, {
      PATH: "/usr/bin:/bin",
      BASE_REF: "Develop",
    });

    assert(code === 0, `step should succeed with BASE_REF set, exited ${code}`);
    const args = await Deno.readTextFile(`${dir}/args`);
    assert(
      args.includes("origin/Develop..HEAD"),
      `gitleaks should scan the PR commit range, got args: ${args}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitleaks workflow — Install Gitleaks completes under strict mode", async () => {
  const wf = await loadWorkflow();
  const step = allSteps(wf).find((s) => s.name === "Install Gitleaks");
  assertExists(step, "must have an 'Install Gitleaks' step");

  const dir = await Deno.makeTempDir({ prefix: "gitleaks-install-" });
  const stubs = `${dir}/bin`;
  try {
    await Deno.mkdir(stubs);
    // curl writes the tarball named by -o; tar drops the extracted binary.
    await writeStub(
      stubs,
      "curl",
      'out=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\nprintf tarball > "${out}"',
    );
    await writeStub(stubs, "tar", "printf binary > gitleaks");

    const code = await runAsAction(String(step.run), dir, {
      PATH: `${stubs}:/usr/bin:/bin`,
    });

    assert(code === 0, `install step should succeed, exited ${code}`);
    const mode = (await Deno.stat(`${dir}/gitleaks`)).mode ?? 0;
    assert((mode & 0o111) !== 0, "extracted gitleaks binary must be executable");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
