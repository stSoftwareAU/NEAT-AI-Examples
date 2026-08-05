// Supply-chain pin policy for every committed workflow (Issue #744).
//
// The identical "every `uses:` pins a 40-char commit SHA" test body was
// copy-pasted into five per-workflow suites, so a workflow with no suite
// of its own was never checked and a policy change had to be applied by
// hand five times. This suite enumerates `.github/workflows/*.yml` and
// `.github/actions/*/action.yml` from disk, so a new workflow is covered
// the moment it is committed.
//
// The policy itself lives in `unpinnedUses()` (workflow_test_utils.ts)
// and is exercised directly below against hand-built documents, so the
// gate is proven to catch an unpinned action rather than merely passing
// on a tree that already complies.

import { assert, assertEquals } from "@std/assert";
import {
  compositeActionNames,
  loadCompositeAction,
  loadWorkflow,
  unpinnedUses,
  usesRefs,
  workflowNames,
} from "./workflow_test_utils.ts";

const PIN_ADVICE = "must pin its action to a 40-character commit SHA. " +
  "See the supply-chain hardening rules in AGENTS.md.";

Deno.test("pin policy — every workflow pins each uses: to a 40-char commit SHA", async (t) => {
  const names = await workflowNames();
  assert(names.length > 0, "expected at least one workflow under .github/workflows");
  for (const name of names) {
    await t.step(name, async () => {
      const wf = await loadWorkflow(name);
      assertEquals(unpinnedUses(wf), [], `${name}: the following ${PIN_ADVICE}`);
    });
  }
});

Deno.test("pin policy — every local composite action pins each uses: to a 40-char commit SHA", async (t) => {
  const names = await compositeActionNames();
  assert(names.length > 0, "expected at least one composite action under .github/actions");
  for (const name of names) {
    await t.step(name, async () => {
      const action = await loadCompositeAction(name);
      assertEquals(unpinnedUses(action), [], `${name}: the following ${PIN_ADVICE}`);
    });
  }
});

Deno.test("pin policy — flags a tag-pinned action in a workflow job", () => {
  const offenders = unpinnedUses({
    jobs: {
      build: {
        steps: [
          { name: "Checkout", uses: `actions/checkout@${"a".repeat(40)}` },
          { name: "Setup", uses: "denoland/setup-deno@v2" },
          { name: "Build", run: "deno task build" },
        ],
      },
    },
  });
  assertEquals(offenders.length, 1, `expected only the tag pin to be flagged, got ${offenders}`);
  assert(
    offenders[0].includes("denoland/setup-deno@v2") && offenders[0].includes("Setup"),
    `offender must name the step and the unpinned ref, got: ${offenders[0]}`,
  );
});

Deno.test("pin policy — flags a branch pin and a short SHA in a composite action", () => {
  const offenders = unpinnedUses({
    runs: {
      using: "composite",
      steps: [
        { name: "Branch", uses: "someone/action@main" },
        { name: "Short", uses: "someone/action@abc1234" },
        { name: "Full", uses: `someone/action@${"0".repeat(40)}` },
      ],
    },
  });
  assertEquals(offenders.length, 2, `expected both weak pins to be flagged, got ${offenders}`);
  assert(offenders.every((o) => o.startsWith("composite step")), `got: ${offenders}`);
});

Deno.test("pin policy — exempts local ./ composite actions and steps with no uses:", () => {
  const offenders = unpinnedUses({
    jobs: {
      build: {
        steps: [
          { name: "Setup env", uses: "./.github/actions/setup-deno-env" },
          { name: "Test", run: "deno test" },
        ],
      },
    },
  });
  assertEquals(offenders, [], "local composite actions and run-only steps are exempt");
});

Deno.test("pin policy — a document with no jobs or steps yields no references", () => {
  assertEquals(usesRefs({}), []);
  assertEquals(usesRefs({ jobs: { empty: {} } }), []);
  assertEquals(unpinnedUses({}), []);
});
