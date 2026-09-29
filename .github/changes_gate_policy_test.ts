// Fail-safe changed-paths gate policy for every committed workflow
// (Issue #888).
//
// Six workflows behind required status checks (actionlint, semgrep,
// shellcheck, deno-audit, dependency-review, markdown-lint) and the
// quality workflow's examples / unit-tests jobs skip work when a `changes`
// job classifies a pull request as docs-only. A job skipped by `if:`
// reports success, so a required check is satisfied without running. The
// skip is safe only while it needs a positive `'false'` verdict: rewriting
// one gate to `== 'true'`, or dropping `!cancelled()`, would let a flaky
// `changes` job (checkout failure, unmergeable PR) turn SAST, shellcheck or
// dependency review green without them having run.
//
// The contract was first asserted for quality.yml's examples job alone.
// This suite enumerates `.github/workflows/*.yml` from disk, so every job
// that `needs: changes` — today's and any added later — is covered. The
// policy lives in `changesGateViolations()` and is exercised directly
// against hand-built documents below, proving the gate catches a violation
// rather than merely passing on a tree that already complies.

import { assert, assertEquals } from "@std/assert";
import {
  CHANGES_JOB,
  changesGateViolations,
  DETECT_CHANGES_ACTION,
  loadWorkflow,
  type Workflow,
  workflowNames,
} from "./workflow_test_utils.ts";

// The workflows that gate a required check on `changes` (Issue #888). Pinned
// so a workflow cannot silently drop out of the policy by losing its gate.
const GATED_WORKFLOWS = [
  "actionlint.yml",
  "deno-audit.yml",
  "dependency-review.yml",
  "markdown-lint.yml",
  "quality.yml",
  "semgrep.yml",
  "shellcheck.yml",
];

function needsChanges(wf: Workflow): boolean {
  const jobs = (wf?.jobs ?? {}) as Record<string, { needs?: string | string[] }>;
  return Object.values(jobs).some((job) =>
    (job?.needs === undefined ? [] : [job.needs].flat()).includes(CHANGES_JOB)
  );
}

/** A compliant workflow; tests mutate a copy to introduce one violation. */
function compliant(): Workflow {
  return {
    jobs: {
      semgrep: {
        needs: CHANGES_JOB,
        if: "${{ !cancelled() && needs.changes.outputs.code_changed != 'false' }}",
        steps: [{ run: "semgrep ci" }],
      },
      [CHANGES_JOB]: {
        outputs: { code_changed: "${{ steps.detect.outputs.changed }}" },
        steps: [
          {
            uses: `actions/checkout@${"a".repeat(40)}`,
            with: { "fetch-depth": 2, "persist-credentials": false },
          },
          { id: "detect", uses: DETECT_CHANGES_ACTION, with: { mode: "code" } },
        ],
      },
    },
  };
}

Deno.test("changes gate — every workflow that needs 'changes' keeps the fail-safe contract", async (t) => {
  const names = await workflowNames();
  assert(names.length > 0, "expected at least one workflow under .github/workflows");
  for (const name of names) {
    await t.step(name, async () => {
      const wf = await loadWorkflow(name);
      assertEquals(changesGateViolations(wf), [], `${name}: fail-safe gate violations`);
    });
  }
});

Deno.test("changes gate — the required-check workflows are all gated", async () => {
  const gated: string[] = [];
  for (const name of await workflowNames()) {
    if (needsChanges(await loadWorkflow(name))) gated.push(name);
  }
  assertEquals(gated, GATED_WORKFLOWS);
});

Deno.test("changes gate — accepts the compliant shape", () => {
  assertEquals(changesGateViolations(compliant()), []);
});

Deno.test("changes gate — a workflow with no 'changes' dependency is out of scope", () => {
  assertEquals(changesGateViolations({ jobs: { lint: { steps: [{ run: "deno lint" }] } } }), []);
  assertEquals(changesGateViolations({}), []);
});

Deno.test("changes gate — flags a gated job rewritten to == 'true'", () => {
  const wf = compliant();
  wf.jobs.semgrep.if = "${{ !cancelled() && needs.changes.outputs.code_changed == 'true' }}";
  assertEquals(changesGateViolations(wf), [
    "job 'semgrep' compares needs.changes.outputs.code_changed == 'true'; a 'changes' output may only be compared with \"!= 'false'\"",
  ]);
});

Deno.test("changes gate — flags a gated job that drops !cancelled()", () => {
  const wf = compliant();
  wf.jobs.semgrep.if = "${{ needs.changes.outputs.code_changed != 'false' }}";
  const violations = changesGateViolations(wf);
  assertEquals(violations.length, 1);
  assert(violations[0].includes("must include '!cancelled()'"), violations[0]);
});

Deno.test("changes gate — flags a gated job with no if: at all", () => {
  const wf = compliant();
  delete wf.jobs.semgrep.if;
  const violations = changesGateViolations(wf);
  assertEquals(violations.length, 1);
  assert(violations[0].includes("must include '!cancelled()'"), violations[0]);
});

Deno.test("changes gate — accepts always() on the aggregate gate", () => {
  const wf = compliant();
  wf.jobs.gate = {
    needs: [CHANGES_JOB, "semgrep"],
    if: "${{ always() }}",
    steps: [{ env: { CODE_CHANGED: "${{ needs.changes.outputs.code_changed }}" }, run: "true" }],
  };
  assertEquals(changesGateViolations(wf), []);
});

Deno.test("changes gate — flags an unsafe comparison in a step if: or expression", () => {
  const wf = compliant();
  wf.jobs.semgrep.if = "${{ !cancelled() }}";
  wf.jobs.semgrep.steps = [
    { if: "${{ needs.changes.outputs.code_changed == 'true' }}", run: "cargo build" },
    { if: "${{ 'true' == needs.changes.outputs.code_changed }}", run: "cargo test" },
    { if: "${{ needs.changes.outputs.code_changed != 'false' }}", run: "ok" },
  ];
  assertEquals(changesGateViolations(wf), [
    "job 'semgrep' compares needs.changes.outputs.code_changed == 'true'; a 'changes' output may only be compared with \"!= 'false'\"",
    "job 'semgrep' compares == needs.changes.outputs.code_changed; put the 'changes' output first and compare with \"!= 'false'\"",
  ]);
});

Deno.test("changes gate — flags a reference to an undeclared output", () => {
  const wf = compliant();
  wf.jobs.semgrep.if = "${{ !cancelled() && needs.changes.outputs.code_chnaged != 'false' }}";
  assertEquals(changesGateViolations(wf), [
    "job 'semgrep' reads undeclared output 'needs.changes.outputs.code_chnaged'",
  ]);
});

Deno.test("changes gate — flags a missing 'changes' job", () => {
  const wf = compliant();
  delete wf.jobs[CHANGES_JOB];
  assertEquals(changesGateViolations(wf), [
    "jobs 'needs: changes' but no 'changes' job is defined",
  ]);
});

Deno.test("changes gate — flags a 'changes' job that bypasses the shared classifier or shallow-clones", () => {
  const wf = compliant();
  wf.jobs[CHANGES_JOB].steps = [
    { uses: `actions/checkout@${"a".repeat(40)}`, with: { "fetch-depth": 1 } },
    { id: "detect", run: "echo changed=false >> $GITHUB_OUTPUT" },
  ];
  assertEquals(changesGateViolations(wf), [
    `job 'changes' must classify with '${DETECT_CHANGES_ACTION}'`,
    "job 'changes' must check out with 'fetch-depth: 2'",
    "job 'changes' must check out with 'persist-credentials: false'",
  ]);
});
