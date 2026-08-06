// Strict-mode policy for every committed workflow and composite action
// (Issue #750).
//
// GitHub's default shell for `run:` is `bash -e {0}` — `errexit` only. Without
// `set -euo pipefail`, an unset variable expands to an empty string and a
// failure mid-pipeline is masked by the exit status of the last command, so a
// broken step still exits 0. `deno-security-update.yml` carried exactly that
// hazard: its advisory gate ran under `set -uo pipefail`, where a failed
// `echo … >> "$GITHUB_OUTPUT"` would have left `steps.audit.outputs.advisory`
// empty, skipping both downstream patch steps while the daily run reported
// success.
//
// The convention was previously asserted for `gitleaks.yml` alone, so a
// non-compliant block in any other workflow was caught only by review. This
// suite enumerates `.github/workflows/*.yml` and `.github/actions/*/action.yml`
// from disk, so a new workflow is covered the moment it is committed. The
// policy lives in `missingStrictMode()` and is exercised directly against
// hand-built documents below, proving the gate catches a violation rather than
// merely passing on a tree that already complies.

import { assert, assertEquals } from "@std/assert";
import {
  compositeActionNames,
  loadCompositeAction,
  loadWorkflow,
  missingStrictMode,
  STRICT_MODE_PREAMBLE,
  workflowNames,
} from "./workflow_test_utils.ts";

const ADVICE = `multi-line run: blocks must open with '${STRICT_MODE_PREAMBLE}' — ` +
  "the default shell is 'bash -e {0}' (errexit only), so an unset variable or a " +
  "mid-pipeline failure would otherwise pass silently.";

Deno.test("strict mode — every workflow's multi-line run: blocks enable it", async (t) => {
  const names = await workflowNames();
  assert(names.length > 0, "expected at least one workflow under .github/workflows");
  for (const name of names) {
    await t.step(name, async () => {
      const wf = await loadWorkflow(name);
      assertEquals(missingStrictMode(wf), [], `${name}: the following ${ADVICE}`);
    });
  }
});

Deno.test("strict mode — every composite action's multi-line run: blocks enable it", async (t) => {
  const names = await compositeActionNames();
  assert(names.length > 0, "expected at least one composite action under .github/actions");
  for (const name of names) {
    await t.step(name, async () => {
      const action = await loadCompositeAction(name);
      assertEquals(missingStrictMode(action), [], `${name}: the following ${ADVICE}`);
    });
  }
});

Deno.test("strict mode — flags a block that omits -e", () => {
  const offenders = missingStrictMode({
    jobs: {
      audit: {
        steps: [{
          name: "Detect security advisories",
          run:
            'set -uo pipefail\nif deno audit --frozen; then\n  echo "advisory=false" >> "$GITHUB_OUTPUT"\nfi\n',
        }],
      },
    },
  });
  assertEquals(offenders, ["job 'audit' step 'Detect security advisories'"]);
});

Deno.test("strict mode — flags a block with no set line at all", () => {
  const offenders = missingStrictMode({
    jobs: {
      build: {
        steps: [{
          name: "Link sibling path",
          run: "if [ ! -e ../NEAT-AI-core ]; then\n  ln -s ./NEAT-AI-core ../NEAT-AI-core\nfi\n",
        }],
      },
    },
  });
  assertEquals(offenders, ["job 'build' step 'Link sibling path'"]);
});

Deno.test("strict mode — flags a composite step and reports every offender", () => {
  const offenders = missingStrictMode({
    runs: {
      using: "composite",
      steps: [
        { name: "Good", shell: "bash", run: `${STRICT_MODE_PREAMBLE}\ndeno install --frozen\n` },
        { name: "Bad", shell: "bash", run: "deno install --frozen\ndeno check .\n" },
        { name: "Also bad", shell: "bash", run: "set -e\ndeno lint\n" },
      ],
    },
  });
  assertEquals(offenders, ["composite step 'Bad'", "composite step 'Also bad'"]);
});

Deno.test("strict mode — accepts a compliant block with trailing blank lines", () => {
  const offenders = missingStrictMode({
    jobs: {
      lint: {
        steps: [{ name: "Lint", run: `${STRICT_MODE_PREAMBLE}\ndeno lint\n\n` }],
      },
    },
  });
  assertEquals(offenders, []);
});

Deno.test("strict mode — exempts single-line run: blocks", () => {
  // The default `bash -e {0}` already propagates a sole command's exit status.
  const offenders = missingStrictMode({
    jobs: {
      lint: { steps: [{ name: "Lint", run: "deno lint" }, { name: "Fmt", run: "deno fmt\n" }] },
    },
  });
  assertEquals(offenders, []);
});

Deno.test("strict mode — exempts non-POSIX shells", () => {
  const offenders = missingStrictMode({
    jobs: {
      report: {
        steps: [
          { name: "PowerShell", shell: "pwsh", run: "Write-Host 'a'\nWrite-Host 'b'\n" },
          { name: "Python", shell: "python", run: "import sys\nprint(sys.version)\n" },
        ],
      },
    },
  });
  assertEquals(offenders, []);
});

Deno.test("strict mode — a document with no jobs or steps yields no offenders", () => {
  assertEquals(missingStrictMode({}), []);
  assertEquals(missingStrictMode({ jobs: { empty: {} } }), []);
});
