import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { join } from "@std/path";

/**
 * Verify the committed `bash -n` syntax gate (Issue #768).
 *
 * Bash has no compile step, so a syntax error in a `*.sh` file only
 * surfaces when the script is executed. ShellCheck runs in CI but is a
 * linter, not a parser gate, so the repository had no check that every
 * committed script parses. `quality/bash_syntax.sh` is that gate, and
 * the ShellCheck workflow invokes it on every pull request.
 *
 * The behaviour tests below run the real gate script against fixture
 * directories and assert on its exit code and output; the workflow test
 * parses the YAML deliverable rather than grepping source text.
 */

const GATE = "quality/bash_syntax.sh";
const SHELLCHECK_WORKFLOW = ".github/workflows/shellcheck.yml";

type GateResult = { code: number; stdout: string; stderr: string };

/** Run the gate script over `root` and capture its exit code and output. */
async function runGate(root?: string): Promise<GateResult> {
  const cmd = new Deno.Command("bash", {
    args: root === undefined ? [GATE] : [GATE, root],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

/** Create a temporary directory seeded with the given `name -> contents` scripts. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "bash_syntax_gate_" });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, contents);
  }
  return dir;
}

const VALID_SCRIPT = `#!/bin/bash
set -euo pipefail
echo "hello"
`;

// `fi` with no `if` — bash rejects this at parse time.
const BROKEN_SCRIPT = `#!/bin/bash
set -euo pipefail
echo "oops"
fi
`;

Deno.test("bash syntax gate passes when every script parses", async () => {
  const dir = await fixture({
    "good.sh": VALID_SCRIPT,
    "nested/also_good.sh": VALID_SCRIPT,
  });
  try {
    const { code, stdout } = await runGate(dir);
    assertEquals(code, 0, `Expected a clean pass, got exit ${code}`);
    assert(
      /2 script\(s\)/.test(stdout),
      `Expected the gate to report 2 checked scripts, got: ${stdout}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash syntax gate fails loud on a syntax error", async () => {
  const dir = await fixture({
    "good.sh": VALID_SCRIPT,
    "broken.sh": BROKEN_SCRIPT,
  });
  try {
    const { code, stderr } = await runGate(dir);
    assert(code !== 0, "Expected a non-zero exit for a script with a syntax error");
    assert(
      stderr.includes("broken.sh"),
      `Expected the failure to name the offending script, got: ${stderr}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash syntax gate reports every broken script, not just the first", async () => {
  const dir = await fixture({
    "broken_one.sh": BROKEN_SCRIPT,
    "broken_two.sh": BROKEN_SCRIPT,
  });
  try {
    const { code, stderr } = await runGate(dir);
    assert(code !== 0, "Expected a non-zero exit when two scripts are broken");
    assert(
      stderr.includes("broken_one.sh") && stderr.includes("broken_two.sh"),
      `Expected both broken scripts to be reported, got: ${stderr}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash syntax gate fails loud when discovery finds no scripts", async () => {
  const dir = await fixture({ "notes.md": "no scripts here\n" });
  try {
    const { code, stderr } = await runGate(dir);
    assert(
      code !== 0,
      "An empty scan means the discovery pattern is broken — it must not pass",
    );
    assert(
      /no shell scripts/i.test(stderr),
      `Expected an explicit empty-scan failure, got: ${stderr}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash syntax gate fails loud when the root does not exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bash_syntax_gate_missing_" });
  await Deno.remove(dir, { recursive: true });
  const { code, stderr } = await runGate(dir);
  assert(code !== 0, "A missing root directory must fail rather than pass vacuously");
  assert(
    stderr.includes(dir),
    `Expected the failure to name the missing root, got: ${stderr}`,
  );
});

Deno.test("bash syntax gate skips vendored and VCS directories", async () => {
  const dir = await fixture({
    "good.sh": VALID_SCRIPT,
    ".git/hooks/broken.sh": BROKEN_SCRIPT,
    "node_modules/pkg/broken.sh": BROKEN_SCRIPT,
    "NEAT-AI-core/broken.sh": BROKEN_SCRIPT,
    "NEAT-AI-scorer/broken.sh": BROKEN_SCRIPT,
  });
  try {
    const { code, stdout } = await runGate(dir);
    assertEquals(code, 0, "Vendored and .git scripts must not fail the gate");
    assert(
      /1 script\(s\)/.test(stdout),
      `Expected only the one committed script to be checked, got: ${stdout}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every committed shell script parses", async () => {
  const { code, stdout, stderr } = await runGate();
  assertEquals(code, 0, `Committed scripts failed the syntax gate:\n${stderr}`);
  assert(
    /Syntax-checking \d+ script\(s\)/.test(stdout),
    `Expected the gate to report the scripts it checked, got: ${stdout}`,
  );
});

Deno.test("CI invokes the bash syntax gate on pull requests", () => {
  // deno-lint-ignore no-explicit-any
  const wf: any = parse(Deno.readTextFileSync(SHELLCHECK_WORKFLOW));
  assert(wf.on?.pull_request, "The gate workflow must run on pull requests");

  // deno-lint-ignore no-explicit-any
  const steps: any[] = Object.values(wf.jobs)
    // deno-lint-ignore no-explicit-any
    .flatMap((job: any) => job.steps ?? []);
  const step = steps.find(
    (s) => typeof s.run === "string" && s.run.includes(GATE),
  );
  assert(
    step,
    `Expected a CI step invoking ${GATE}; found: ${steps.map((s) => s.name).join(", ")}`,
  );
});
