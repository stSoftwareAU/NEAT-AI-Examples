/**
 * Behavioural checks for the native rust_scorer preamble — the scoped
 * `--allow-run` flag must reach Deno under `set -u` (issue: macOS bash 3.2
 * cannot `export` array assignments).
 */
import { assert, assertMatch } from "@std/assert";
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
