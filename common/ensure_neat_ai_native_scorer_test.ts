/**
 * Behavioural checks for the native rust_scorer preamble — the scoped
 * `--allow-run` flag must reach Deno under `set -u` (issue: macOS bash 3.2
 * cannot `export` array assignments).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));
const SCORER_REPO = join(REPO_ROOT, "..", "NEAT-AI-scorer");

async function scorerSiblingPresent(): Promise<boolean> {
  try {
    await Deno.stat(SCORER_REPO);
    return true;
  } catch {
    return false;
  }
}

Deno.test("example runner preamble sets scoped --allow-run for rust_scorer under set -u", async () => {
  if (!(await scorerSiblingPresent())) {
    console.log("skip: NEAT-AI-scorer sibling repo not present");
    return;
  }
  const bashScript = [
    'REPO_ROOT="$(pwd)"',
    'source "${REPO_ROOT}/common/example_runner_preamble.sh"',
    "if ((${#ALLOW_RUN_ARGS[@]} != 1)); then",
    '  echo "ALLOW_RUN_ARGS length=${#ALLOW_RUN_ARGS[@]}"',
    "  exit 1",
    "fi",
    "printf '%s\\n' \"${ALLOW_RUN_ARGS[0]}\"",
  ].join("\n");

  const cmd = new Deno.Command("bash", {
    cwd: REPO_ROOT,
    args: ["-euo", "pipefail", "-c", bashScript],
    stdout: "piped",
    stderr: "null",
  });
  const { code, stdout } = await cmd.output();
  const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((line) =>
    line.startsWith("--allow-run=")
  );
  const line = lines.at(-1);
  if (code !== 0 || line === undefined) {
    throw new Error(
      `preamble failed (exit ${code}); ALLOW_RUN_ARGS=${line ?? "empty"}`,
    );
  }
  assertMatch(line, /^--allow-run=.*\/rust_scorer$/);
  assert(line.includes("NEAT-AI-scorer"), `expected sibling scorer path, got ${line}`);
});

// ---------------------------------------------------------------------------
// ensure_rust_scorer_supports_cost — probe helper introduced for issue #502
// (MNIST native scorer requires rust_scorer CATEGORICAL_ERROR support).
//
// The helper sources cleanly under `set -u` and we exercise it against a
// fake rust_scorer binary (a tiny bash script that prints a curated
// `--help`) so the test runs without the sibling NEAT-AI-scorer repo or
// a real Rust toolchain.
// ---------------------------------------------------------------------------

interface ProbeRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProbe(
  helpOutput: string,
  cost: string,
  env: Record<string, string> = {},
  helpExitCode = 0,
): Promise<ProbeRun & { binary: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "rust-scorer-probe-" });
  try {
    const binary = join(tmp, "rust_scorer");
    // The fake binary echoes a curated help payload to stdout for
    // success runs, or writes to stderr and exits non-zero for the
    // "older binary" simulation. Either way it never tries to score.
    const script = helpExitCode === 0
      ? `#!/bin/bash\nif [[ "\${1:-}" == "--help" ]]; then\n  cat <<'HELP'\n${helpOutput}\nHELP\n  exit 0\nfi\nexit 0\n`
      : `#!/bin/bash\necho "unknown flag" >&2\nexit ${helpExitCode}\n`;
    await Deno.writeTextFile(binary, script);
    await Deno.chmod(binary, 0o755);

    const bashScript = [
      "set -euo pipefail",
      `source "${REPO_ROOT}common/ensure_neat_ai_native_scorer.sh"`,
      `export NEAT_AI_RUST_SCORER_BINARY_PATH="${binary}"`,
      "export NEAT_AI_RUST_SCORER_ENABLED=true",
      `ensure_rust_scorer_supports_cost ${cost}`,
    ].join("\n");

    const cmd = new Deno.Command("bash", {
      cwd: REPO_ROOT,
      args: ["-c", bashScript],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    return {
      binary,
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("ensure_rust_scorer_supports_cost — returns 0 silently when cost is advertised", async () => {
  const result = await runProbe(
    "Usage: rust_scorer --cost <COST>\nSupported costs: MSE, MAE, CATEGORICAL_ERROR, BINARY_CROSS_ENTROPY",
    "CATEGORICAL_ERROR",
    { PATH: Deno.env.get("PATH") ?? "" },
  );
  assertEquals(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
  // No native-scorer chatter when the cost is supported.
  assert(
    !result.stderr.includes("does NOT advertise"),
    `did not expect warning, got: ${result.stderr}`,
  );
});

Deno.test("ensure_rust_scorer_supports_cost — warns and falls back when cost is missing", async () => {
  const result = await runProbe(
    "Usage: rust_scorer --cost <COST>\nSupported costs: MSE, MAE",
    "CATEGORICAL_ERROR",
    { PATH: Deno.env.get("PATH") ?? "" },
  );
  assertEquals(result.code, 0);
  assertStringIncludes(result.stderr, "does NOT advertise cost CATEGORICAL_ERROR");
  assertStringIncludes(result.stderr, "NEAT-AI-scorer#134");
  assertStringIncludes(result.stderr, "[native-scorer] unavailable");
});

Deno.test("ensure_rust_scorer_supports_cost — fails fast when NEAT_AI_REQUIRE_NATIVE_SCORER=1", async () => {
  const result = await runProbe(
    "Usage: rust_scorer --cost <COST>\nSupported costs: MSE, MAE",
    "CATEGORICAL_ERROR",
    {
      PATH: Deno.env.get("PATH") ?? "",
      NEAT_AI_REQUIRE_NATIVE_SCORER: "1",
    },
  );
  assert(result.code !== 0, `expected non-zero exit, got ${result.code}`);
  assertStringIncludes(result.stderr, "failing fast");
});

Deno.test("ensure_rust_scorer_supports_cost — soft warning when --help fails (older binary)", async () => {
  const result = await runProbe(
    "",
    "CATEGORICAL_ERROR",
    { PATH: Deno.env.get("PATH") ?? "" },
    2,
  );
  assertEquals(result.code, 0);
  assertStringIncludes(result.stderr, "could not probe");
  assertStringIncludes(result.stderr, "support unverified");
});

Deno.test("ensure_rust_scorer_supports_cost — no-op when scorer binary path is unset", async () => {
  const bashScript = [
    "set -euo pipefail",
    `source "${REPO_ROOT}common/ensure_neat_ai_native_scorer.sh"`,
    "unset NEAT_AI_RUST_SCORER_BINARY_PATH || true",
    "unset NEAT_AI_RUST_SCORER_ENABLED || true",
    "ensure_rust_scorer_supports_cost CATEGORICAL_ERROR",
    'echo "exit=$?"',
  ].join("\n");
  const cmd = new Deno.Command("bash", {
    cwd: REPO_ROOT,
    args: ["-c", bashScript],
    env: { PATH: Deno.env.get("PATH") ?? "" },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  assertEquals(code, 0, `expected silent success; stderr=${new TextDecoder().decode(stderr)}`);
  assertStringIncludes(new TextDecoder().decode(stdout), "exit=0");
});

Deno.test("ensure_rust_scorer_supports_cost — does not match cost as a substring of unrelated tokens", async () => {
  // PRECATEGORICAL_ERRORX must NOT count as advertising CATEGORICAL_ERROR.
  const result = await runProbe(
    "Usage: rust_scorer\nSupported costs: MSE, MAE, PRECATEGORICAL_ERRORX",
    "CATEGORICAL_ERROR",
    { PATH: Deno.env.get("PATH") ?? "" },
  );
  assertEquals(result.code, 0);
  assertStringIncludes(result.stderr, "does NOT advertise cost CATEGORICAL_ERROR");
});
