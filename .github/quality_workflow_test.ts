// Tests for .github/workflows/quality.yml supply-chain hardening (Issue #552).
//
// Every third-party action in the repository must be pinned to an
// immutable 40-character commit SHA rather than a moving branch or tag
// (see the supply-chain hardening rules in AGENTS.md and GitHub's own
// guidance). A branch reference such as `@stable` is mutable: whoever
// controls the upstream repository can repoint the branch at malicious
// code, which then executes on the runner with the job's GITHUB_TOKEN
// and any secrets in scope (this job builds rust_scorer and reads
// CODECOV_TOKEN).
//
// These tests pin that contract for quality.yml so a future unpinned
// action fails the build instead of slipping through review.

import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/quality.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

Deno.test("quality workflow — every uses: pins a 40-char commit SHA", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const shaPattern = /@[0-9a-f]{40}\b/;
  for (const [jobKey, job] of Object.entries(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) {
      const uses = step.uses as string | undefined;
      if (!uses) continue;
      assert(
        shaPattern.test(uses),
        `job '${jobKey}' step '${step.name ?? uses}' must pin its action ` +
          `to a 40-character commit SHA (got '${uses}'). See the supply-chain ` +
          `hardening rules in AGENTS.md.`,
      );
    }
  }
});

Deno.test("quality workflow — rust-toolchain is SHA-pinned and keeps toolchain: stable", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  let found: Record<string, unknown> | undefined;
  for (const job of Object.values(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) {
      const uses = (step.uses as string | undefined) ?? "";
      if (uses.startsWith("dtolnay/rust-toolchain@")) {
        found = step;
        break;
      }
    }
    if (found) break;
  }
  assert(found, "quality workflow must install the Rust toolchain");
  const uses = found.uses as string;
  assert(
    /^dtolnay\/rust-toolchain@[0-9a-f]{40}\b/.test(uses),
    `dtolnay/rust-toolchain must pin a 40-character commit SHA (got '${uses}')`,
  );
  // When pinned to a SHA the action can no longer infer the toolchain
  // from the ref name (it did so for the `@stable` branch), so the
  // toolchain must be supplied explicitly to preserve behaviour.
  const withBlock = found.with as { toolchain?: string } | undefined;
  assertEquals(
    withBlock?.toolchain,
    "stable",
    "SHA-pinned rust-toolchain must set `with: toolchain: stable` to keep the stable toolchain",
  );
});
