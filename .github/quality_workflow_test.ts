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

// The single `quality` job was split into three independent parallel
// jobs (Issue #582). The tests below pin that split: the three job keys
// exist, none depends on another (so they run in parallel), each carries
// its own timeout with headroom, and the expensive Rust build lives only
// in the unit-tests job.

// deno-lint-ignore no-explicit-any
function stepNames(job: any): string[] {
  const steps = (job?.steps ?? []) as Array<Record<string, unknown>>;
  return steps.map((s) => (s.name as string) ?? (s.uses as string) ?? "");
}

Deno.test("quality workflow — split into three parallel jobs with no inter-job needs", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const keys = Object.keys(jobs).sort();
  assertEquals(
    keys,
    ["examples", "static-checks", "unit-tests"],
    "quality workflow must define exactly the static-checks, unit-tests, and examples jobs (Issue #582)",
  );
  // No `needs:` between them — the three jobs run in parallel so the
  // critical path is the slowest job, not the sum of all steps.
  for (const [key, job] of Object.entries(jobs)) {
    assertEquals(
      (job as { needs?: unknown }).needs,
      undefined,
      `job '${key}' must not declare 'needs:' so the jobs run in parallel`,
    );
  }
});

Deno.test("quality workflow — each job sets its own timeout with headroom", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, { "timeout-minutes"?: number }>;
  for (const key of ["static-checks", "unit-tests", "examples"]) {
    const timeout = jobs[key]?.["timeout-minutes"];
    assert(
      typeof timeout === "number" && timeout >= 10,
      `job '${key}' must set a 'timeout-minutes' of at least 10 for reliability headroom (Issue #582)`,
    );
  }
});

Deno.test("quality workflow — rust_scorer build lives only in the unit-tests job", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  // The Rust build, scorer/core checkouts, and sibling symlink are only
  // needed by the unit-tests job (the sole consumer of the
  // NEAT_AI_RUST_SCORER_* env vars). They must not be duplicated into the
  // examples job, which runs the JS path with Deno alone.
  assert(
    stepNames(jobs["unit-tests"]).includes("Build rust_scorer"),
    "unit-tests job must build rust_scorer",
  );
  for (const key of ["static-checks", "examples"]) {
    assert(
      !stepNames(jobs[key]).includes("Build rust_scorer"),
      `job '${key}' must not build rust_scorer — the Rust build belongs only to unit-tests (Issue #582)`,
    );
  }
});

Deno.test("quality workflow — every job preserves the bump-aware checkout ref and frozen install", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  for (const [key, job] of Object.entries(jobs)) {
    const steps = (job.steps ?? []) as Array<Record<string, unknown>>;
    const checkout = steps.find((s) =>
      (s.uses as string | undefined)?.startsWith("actions/checkout@") &&
      (s.with as { repository?: string } | undefined)?.repository === undefined
    );
    assert(checkout, `job '${key}' must check out the repository`);
    assertEquals(
      (checkout.with as { ref?: string }).ref,
      "${{ inputs.pr_head_ref || github.ref }}",
      `job '${key}' must preserve the workflow_dispatch auto-bump checkout ref`,
    );
    assert(
      stepNames(job).includes("Install dependencies with frozen lockfile"),
      `job '${key}' must install dependencies with the frozen lockfile (#418)`,
    );
  }
});
