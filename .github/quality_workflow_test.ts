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

// deno-lint-ignore no-explicit-any
function findStepByName(wf: Workflow, name: string): any {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  for (const job of Object.values(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) {
      if (step.name === name) return step;
    }
  }
  return undefined;
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

// CI runs the example steps in quick mode so the per-PR job stays well
// under its timeout cap (Issue #581).
Deno.test("quality workflow — Discovery example runs in quick mode and stays non-blocking", async () => {
  const wf = await loadWorkflow();
  const step = findStepByName(wf, "Run Discovery example");
  assert(step, "quality workflow must run the Discovery example");
  const env = step.env as Record<string, string> | undefined;
  assertEquals(
    env?.DISCOVERY_QUICK,
    "1",
    "Discovery step must set DISCOVERY_QUICK: '1' so it does not burn its full budget in CI",
  );
  assertEquals(
    step["continue-on-error"],
    true,
    "Discovery step must remain continue-on-error while the native FFI library is unavailable in CI",
  );
});

Deno.test("quality workflow — Suggest Improvements example runs in quick mode and stays blocking", async () => {
  const wf = await loadWorkflow();
  const step = findStepByName(wf, "Run Suggest Improvements example");
  assert(step, "quality workflow must run the Suggest Improvements example");
  const env = step.env as Record<string, string> | undefined;
  assertEquals(
    env?.SUGGEST_QUICK,
    "1",
    "Suggest Improvements step must set SUGGEST_QUICK: '1' to finish quickly in CI",
  );
  assert(
    step["continue-on-error"] === undefined ||
      step["continue-on-error"] === false,
    "Suggest Improvements step must remain blocking (no continue-on-error)",
  );
});

Deno.test("quality workflow — job timeout has headroom above the example budget", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const quality = jobs.quality as { "timeout-minutes"?: number } | undefined;
  assert(quality, "quality workflow must define a 'quality' job");
  assertEquals(
    quality["timeout-minutes"],
    45,
    "quality job timeout-minutes must be 45 to give the example steps headroom (Issue #581)",
  );
});
