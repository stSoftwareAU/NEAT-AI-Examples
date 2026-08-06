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
  INSTALL_VERIFIED_TOOL,
  loadCompositeAction,
  loadWorkflow,
  unpinnedUses,
  unverifiedDownloads,
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

// --- Downloaded-binary integrity (Issue #748) -------------------------------
//
// A version pin says which release is fetched, not which bytes arrive: a
// release asset can be deleted and re-uploaded under an existing tag. Any
// workflow that pulls an executable must therefore verify a pinned SHA-256
// before running it.

const DOWNLOAD_ADVICE = `must fetch through ${INSTALL_VERIFIED_TOOL} with a pinned ` +
  "64-character SHA-256 digest, so a substituted asset fails the job instead of executing.";

Deno.test("download policy — no workflow runs an unverified downloaded binary", async (t) => {
  const names = await workflowNames();
  assert(names.length > 0, "expected at least one workflow under .github/workflows");
  for (const name of names) {
    await t.step(name, async () => {
      const wf = await loadWorkflow(name);
      assertEquals(unverifiedDownloads(wf), [], `${name}: the following ${DOWNLOAD_ADVICE}`);
    });
  }
});

Deno.test("download policy — flags a hand-rolled curl of a release tarball", () => {
  const offenders = unverifiedDownloads({
    jobs: {
      lint: {
        steps: [
          { name: "Install tool", run: 'curl -sSfL "https://example.test/tool.tar.gz" -o t.tgz' },
          { name: "Run tool", run: "./tool --check" },
        ],
      },
    },
  });
  assertEquals(offenders, ["job 'lint' step 'Install tool'"]);
});

Deno.test("download policy — flags a wget that skips the digest check", () => {
  const offenders = unverifiedDownloads({
    jobs: { lint: { steps: [{ name: "Fetch", run: "wget https://example.test/tool.tar.gz" }] } },
  });
  assertEquals(offenders.length, 1, `expected the unverified wget to be flagged, got ${offenders}`);
});

Deno.test("download policy — flags a download whose digest is not pinned in the step", () => {
  const offenders = unverifiedDownloads({
    jobs: {
      lint: {
        steps: [{
          name: "Install tool",
          // Uses the helper, but resolves the digest from a fetched checksums
          // file rather than pinning it — the same origin as the tarball.
          run: `curl -sSfL https://example.test/checksums.txt -o c.txt\n` +
            `${INSTALL_VERIFIED_TOOL} https://example.test/tool.tar.gz "$(cut -d' ' -f1 c.txt)" tool`,
        }],
      },
    },
  });
  assertEquals(offenders, ["job 'lint' step 'Install tool'"]);
});

Deno.test("download policy — accepts a helper call with a pinned digest", () => {
  const offenders = unverifiedDownloads({
    jobs: {
      lint: {
        steps: [{
          name: "Install tool",
          run: `${INSTALL_VERIFIED_TOOL} https://example.test/tool.tar.gz ${"a".repeat(64)} tool`,
        }],
      },
    },
  });
  assertEquals(offenders, [], "a pinned digest routed through the helper is compliant");
});

Deno.test("download policy — ignores steps that never touch the network", () => {
  assertEquals(unverifiedDownloads({}), []);
  assertEquals(
    unverifiedDownloads({ jobs: { lint: { steps: [{ name: "Test", run: "deno test" }] } } }),
    [],
  );
});
