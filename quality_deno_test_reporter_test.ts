import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the quality gate's `deno test` runs print a quiet summary on
 * success yet keep full failure detail (Issue #885).
 *
 * Both `quality.sh` and the CI unit-test step build a shared
 * `DENO_TEST_FLAGS` array. These "what" tests evaluate that array with
 * bash, run `deno test` with the resulting flags against throwaway test
 * files, and assert on the output a reader actually sees.
 */

const QUALITY_SCRIPT = "quality.sh";
const QUALITY_WORKFLOW = ".github/workflows/quality.yml";

/** Pull the `DENO_TEST_FLAGS=( … )` block out of a bash script. */
function flagsBlock(script: string, source: string): string {
  const match = script.match(/^[ \t]*DENO_TEST_FLAGS=\([\s\S]*?^[ \t]*\)$/m);
  assert(match, `${source} must define a DENO_TEST_FLAGS array`);
  return match[0];
}

/** Evaluate the array in bash and return its elements. */
function evaluateFlags(block: string): string[] {
  const out = new Deno.Command("bash", {
    args: ["-c", `set -euo pipefail\n${block}\nprintf '%s\\0' "\${DENO_TEST_FLAGS[@]}"`],
    env: { DENO_TEST_ALLOW_RUN: "deno" },
    stdin: "null",
  }).outputSync();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).split("\0").filter((f) => f !== "");
}

function scriptFlags(): string[] {
  return evaluateFlags(flagsBlock(Deno.readTextFileSync(QUALITY_SCRIPT), QUALITY_SCRIPT));
}

function workflowFlags(): string[] {
  // deno-lint-ignore no-explicit-any
  const wf: any = parse(Deno.readTextFileSync(QUALITY_WORKFLOW));
  const runs: string[] = Object.values(wf.jobs)
    // deno-lint-ignore no-explicit-any
    .flatMap((job: any) => job.steps ?? [])
    // deno-lint-ignore no-explicit-any
    .map((step: any) => step.run)
    .filter((run: unknown): run is string =>
      typeof run === "string" && run.includes("DENO_TEST_FLAGS=(")
    );
  assertEquals(runs.length, 1, "exactly one workflow step should build DENO_TEST_FLAGS");
  return evaluateFlags(flagsBlock(runs[0], QUALITY_WORKFLOW));
}

/** Run `deno test` with the gate's flags over the given scratch tests. */
function runDenoTest(
  flags: string[],
  files: Record<string, string>,
): { code: number; output: string } {
  const dir = Deno.makeTempDirSync({ prefix: "reporter_test_" });
  try {
    for (const [name, body] of Object.entries(files)) {
      Deno.writeTextFileSync(`${dir}/${name}`, body);
    }
    const out = new Deno.Command(Deno.execPath(), {
      args: ["test", ...flags, ...Object.keys(files)],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdin: "null",
    }).outputSync();
    const decoder = new TextDecoder();
    return {
      code: out.code,
      output: decoder.decode(out.stdout) + decoder.decode(out.stderr),
    };
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

const PASSING = {
  "passing_test.ts": `Deno.test("alpha quietly passes", () => {});
Deno.test("beta quietly passes", () => {});
`,
};

const FAILING = {
  "failing_test.ts": `Deno.test("gamma deliberately fails", () => {
  throw new Error("expected 1 to equal 2");
});
`,
};

for (
  const [label, flagsOf] of [["quality.sh", scriptFlags], ["CI workflow", workflowFlags]] as const
) {
  Deno.test(`${label}: passing tests print a summary, not a line per test`, () => {
    const { code, output } = runDenoTest(flagsOf(), PASSING);
    assertEquals(code, 0, output);
    assertStringIncludes(output, "2 passed");
    assert(
      !output.includes("alpha quietly passes") && !output.includes("beta quietly passes"),
      `passing test names must not be listed one per line:\n${output}`,
    );
  });

  Deno.test(`${label}: a failing test keeps its name, message and stack`, () => {
    const { code, output } = runDenoTest(flagsOf(), FAILING);
    assert(code !== 0, "a failing test must fail the run");
    assertStringIncludes(output, "gamma deliberately fails");
    assertStringIncludes(output, "expected 1 to equal 2");
    assertStringIncludes(output, "failing_test.ts:2:9");
  });
}
