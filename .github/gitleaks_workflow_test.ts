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

import { assert, assertEquals, assertExists } from "@std/assert";
import { loadWorkflow, type Workflow } from "./workflow_test_utils.ts";

const WORKFLOW = "gitleaks.yml";

function allSteps(wf: Workflow): Array<Record<string, unknown>> {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const steps: Array<Record<string, unknown>> = [];
  for (const job of Object.values(jobs)) {
    const js = (job.steps ?? []) as Array<Record<string, unknown>>;
    steps.push(...js);
  }
  return steps;
}

// Issue #813: `actions/checkout` writes the job's `GITHUB_TOKEN` into
// `.git/config` as an auth header unless `persist-credentials: false` is set.
// This job only reads history (`gitleaks detect --log-opts`) — it never pushes
// and fetches no private submodule — so the persisted credential buys nothing
// and any later step, including a substituted binary, could read it back.
Deno.test("gitleaks workflow — checkout does not persist a credential in the workspace", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const checkouts = allSteps(wf).filter((s) =>
    typeof s.uses === "string" && s.uses.includes("actions/checkout")
  );
  assert(checkouts.length > 0, "expected at least one actions/checkout step");
  for (const step of checkouts) {
    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    assertEquals(
      withBlock["persist-credentials"],
      false,
      `checkout step "${step.name}" must set persist-credentials: false — the job never ` +
        `pushes, so the GITHUB_TOKEN must not be left readable in .git/config`,
    );
  }
});

Deno.test("gitleaks workflow — no step pushes back to the repository", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  for (const step of allSteps(wf)) {
    const run = String(step.run ?? "");
    assert(
      !/\bgit\s+push\b/.test(run),
      `step "${step.name}" pushes to the repository; dropping the persisted checkout ` +
        `credential would break it — re-assess the #813 fix before allowing this`,
    );
  }
});

Deno.test("gitleaks workflow — no run: step interpolates ${{ ... }} directly", async () => {
  const wf = await loadWorkflow(WORKFLOW);
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
  const wf = await loadWorkflow(WORKFLOW);
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
  const wf = await loadWorkflow(WORKFLOW);
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
  const wf = await loadWorkflow(WORKFLOW);
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
  const wf = await loadWorkflow(WORKFLOW);
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

// Issue #748 moved the download, digest check and extraction out of this
// `run:` block and into `.github/scripts/install_verified_tool.sh`, which is
// exercised end-to-end in `install_verified_tool_test.ts`. What is left to
// verify here is that the step still completes under strict mode and hands the
// verifier the right pinned arguments — so this test now stubs the verifier
// instead of stubbing `curl` and `tar`.
Deno.test("gitleaks workflow — Install Gitleaks completes under strict mode", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  const step = allSteps(wf).find((s) => s.name === "Install Gitleaks");
  assertExists(step, "must have an 'Install Gitleaks' step");

  const dir = await Deno.makeTempDir({ prefix: "gitleaks-install-" });
  try {
    await Deno.mkdir(`${dir}/.github/scripts`, { recursive: true });
    await writeStub(
      `${dir}/.github/scripts`,
      "install_verified_tool.sh",
      `printf '%s' "$*" > "${dir}/args"`,
    );

    const code = await runAsAction(String(step.run), dir, { PATH: "/usr/bin:/bin" });

    assert(code === 0, `install step should succeed, exited ${code}`);
    const args = (await Deno.readTextFile(`${dir}/args`)).split(/\s+/);
    assert(
      args.some((a) => a.includes("gitleaks_8.30.1_linux_x64.tar.gz")),
      `install step must fetch the pinned release asset, got args: ${args.join(" ")}`,
    );
    assert(
      args.some((a) => /^[0-9a-f]{64}$/.test(a)),
      `install step must pass a pinned 64-character SHA-256, got args: ${args.join(" ")}`,
    );
    assertEquals(
      args[args.length - 1],
      "gitleaks",
      `install step must extract the gitleaks binary, got args: ${args.join(" ")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
