/**
 * Tests for CI workflow Deno permission flags.
 *
 * The @stsoftware/neat-ai WASM activation module fetches its remote
 * payload from jsr.io at runtime, so any `deno test` invocation that
 * exercises it must pass --allow-net. Without that flag, every test
 * that constructs a creature dies with `NotCapable: Requires net
 * access to "jsr.io:443"` and the CI run fails wholesale (Issue #73).
 *
 * These tests parse the workflow YAML as text and assert the test
 * step retains both --allow-net and --allow-ffi, so a future edit
 * cannot silently re-introduce the regression.
 */

import { assert, assertStringIncludes } from "@std/assert";

const WORKFLOWS: { path: string; testStep: string }[] = [
  {
    path: ".github/workflows/quality.yml",
    testStep: "Run unit tests with coverage",
  },
];

/** Extract the `run:` line that follows a step with the given name. */
function findRunCommand(yaml: string, stepName: string): string {
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`name: ${stepName}`)) {
      // Look ahead for the next `run:` line within the same step.
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const match = lines[j].match(/^\s*run:\s*(.*)$/);
        if (match) return match[1];
      }
    }
  }
  throw new Error(`Could not find run command for step "${stepName}"`);
}

for (const { path, testStep } of WORKFLOWS) {
  Deno.test(`${path} test step includes --allow-net`, () => {
    const yaml = Deno.readTextFileSync(path);
    const command = findRunCommand(yaml, testStep);
    assert(
      command.startsWith("deno test"),
      `Expected '${testStep}' to invoke 'deno test', got: ${command}`,
    );
    assertStringIncludes(command, "--allow-net");
  });

  Deno.test(`${path} test step includes --allow-ffi`, () => {
    const yaml = Deno.readTextFileSync(path);
    const command = findRunCommand(yaml, testStep);
    assertStringIncludes(command, "--allow-ffi");
  });
}

Deno.test("quality.sh test invocation retains --allow-net and --allow-ffi", () => {
  const script = Deno.readTextFileSync("quality.sh");
  // Locate the deno test command in quality.sh.
  const match = script.match(/deno test[^\n]*/);
  assert(match, "quality.sh should invoke 'deno test'");
  assertStringIncludes(match[0], "--allow-net");
  assertStringIncludes(match[0], "--allow-ffi");
});
