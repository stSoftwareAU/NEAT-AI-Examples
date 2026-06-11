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
// jobs (Issue #582). The tests below pin that split: the three work job
// keys exist, none depends on another (so they run in parallel), each
// carries its own timeout with headroom, and the expensive Rust build
// lives only in the unit-tests job.
//
// A fourth job, the aggregate `quality` gate, was kept so the required
// branch-protection status context "Run quality checks" still reports
// after the split (PR #585). It is a pure gate: it `needs:` the three
// work jobs and runs no checkout/build steps, so it is excluded from the
// per-work-job invariants below.

// The three real work jobs that run in parallel.
const WORK_JOBS = ["static-checks", "unit-tests", "examples"] as const;

// The aggregate gate job that fans in on the work jobs to report the
// required status context.
const GATE_JOB = "quality";

// deno-lint-ignore no-explicit-any
function stepNames(job: any): string[] {
  const steps = (job?.steps ?? []) as Array<Record<string, unknown>>;
  return steps.map((s) => (s.name as string) ?? (s.uses as string) ?? "");
}

Deno.test("quality workflow — three parallel work jobs with no inter-job needs", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const keys = Object.keys(jobs).sort();
  assertEquals(
    keys,
    ["examples", "quality", "static-checks", "unit-tests"],
    "quality workflow must define the static-checks, unit-tests, and examples work jobs plus the aggregate 'quality' gate (Issues #582, PR #585)",
  );
  // None of the work jobs declares `needs:` — they run in parallel so
  // the critical path is the slowest job, not the sum of all steps.
  for (const key of WORK_JOBS) {
    assertEquals(
      (jobs[key] as { needs?: unknown }).needs,
      undefined,
      `work job '${key}' must not declare 'needs:' so the jobs run in parallel`,
    );
  }
});

Deno.test("quality workflow — aggregate 'quality' gate fans in on the three work jobs", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const gate = jobs[GATE_JOB];
  assert(
    gate,
    `quality workflow must keep the aggregate '${GATE_JOB}' gate so the required "Run quality checks" status context still reports (PR #585)`,
  );
  // The gate reports under the former single-job name so existing branch
  // protection keeps gating PRs after the split.
  assertEquals(
    gate.name,
    "Run quality checks",
    "aggregate gate must keep the required status-context name 'Run quality checks'",
  );
  // It depends on every work job so it cannot pass unless they all do.
  const needs = [...((gate.needs as string[] | undefined) ?? [])].sort();
  assertEquals(
    needs,
    [...WORK_JOBS].sort(),
    "aggregate gate must 'needs:' exactly the three work jobs",
  );
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

// The rust_scorer release build costs ~2m03s cold (Issue #583). The
// unit-tests job caches the cargo registry, git index, and the scorer
// target dir so warm-cache runs skip most of that. The cache must:
//   - live in the unit-tests job (the only job that builds rust_scorer),
//   - run before the build so a restored cache seeds it,
//   - cover the cargo registry/git and NEAT-AI-scorer/target,
//   - key on the Cargo.lock hash with a restore-keys prefix fallback so a
//     slightly stale cache from a moving Develop ref still seeds an
//     incremental rebuild.
Deno.test("quality workflow — unit-tests job caches the cargo build before building rust_scorer", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const steps = (jobs["unit-tests"].steps ?? []) as Array<
    Record<string, unknown>
  >;

  const cacheIndex = steps.findIndex((s) => {
    const uses = (s.uses as string | undefined) ?? "";
    const path = ((s.with as { path?: string } | undefined)?.path) ?? "";
    return (uses.startsWith("actions/cache@") &&
      path.includes("NEAT-AI-scorer/target")) ||
      uses.startsWith("Swatinem/rust-cache@");
  });
  assert(
    cacheIndex !== -1,
    "unit-tests job must cache the cargo registry and rust_scorer build artefacts (Issue #583)",
  );

  const buildIndex = steps.findIndex((s) => s.name === "Build rust_scorer");
  assert(buildIndex !== -1, "unit-tests job must build rust_scorer");
  assert(
    cacheIndex < buildIndex,
    "the cargo cache step must run before 'Build rust_scorer' so a restored cache seeds the build",
  );

  const cacheStep = steps[cacheIndex];
  const uses = cacheStep.uses as string;
  if (uses.startsWith("actions/cache@")) {
    const withBlock = cacheStep.with as {
      path?: string;
      key?: string;
      "restore-keys"?: string;
    };
    const path = withBlock.path ?? "";
    assert(
      path.includes("~/.cargo/registry") && path.includes("~/.cargo/git"),
      "actions/cache must cover the cargo registry and git index",
    );
    assert(
      path.includes("NEAT-AI-scorer/target"),
      "actions/cache must cover the rust_scorer target directory",
    );
    assert(
      (withBlock.key ?? "").includes("NEAT-AI-scorer/Cargo.lock"),
      "cache key must reflect the rust_scorer lockfile (hashFiles('NEAT-AI-scorer/Cargo.lock'))",
    );
    assert(
      typeof withBlock["restore-keys"] === "string" &&
        withBlock["restore-keys"].trim().length > 0,
      "cache must declare a restore-keys prefix fallback so a stale cache still seeds an incremental rebuild",
    );
  } else {
    // Swatinem/rust-cache variant — must scope to the scorer workspace.
    const workspaces = (cacheStep.with as { workspaces?: string } | undefined)?.workspaces ?? "";
    assert(
      workspaces.includes("NEAT-AI-scorer"),
      "Swatinem/rust-cache must set workspaces: NEAT-AI-scorer",
    );
  }
});

Deno.test("quality workflow — the cargo build cache lives only in the unit-tests job", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  for (const key of ["static-checks", "examples"]) {
    const steps = (jobs[key].steps ?? []) as Array<Record<string, unknown>>;
    for (const s of steps) {
      const uses = (s.uses as string | undefined) ?? "";
      const path = ((s.with as { path?: string } | undefined)?.path) ?? "";
      assert(
        !uses.startsWith("Swatinem/rust-cache@") &&
          !(uses.startsWith("actions/cache@") &&
            path.includes("NEAT-AI-scorer/target")),
        `job '${key}' must not cache the cargo build — the Rust build belongs only to unit-tests (Issue #583)`,
      );
    }
  }
});

Deno.test("quality workflow — every work job preserves the bump-aware checkout ref and frozen install", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  // Only the work jobs run the suite; the aggregate gate is a pure
  // fan-in with no checkout/install steps and is excluded here.
  for (const key of WORK_JOBS) {
    const job = jobs[key];
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
