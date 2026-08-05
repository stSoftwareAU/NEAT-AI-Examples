import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify no workflow job both executes pull-request-authored code and holds a
 * repository secret (Issue #747).
 *
 * Root cause: Issue #678 closed the direct path — the org `ACTIONS_PUSH` PAT
 * is no longer persisted into `.git/config` while PR code runs — but one
 * step-boundary-crossing primitive survived. Anything an earlier step appends
 * to `$GITHUB_PATH` (or `$GITHUB_ENV`) is applied to *every subsequent step in
 * the same job*, and neither file is on the runner's blocked list. PR code
 * could therefore prepend a directory holding a shim named `git` (auto-bump)
 * or `node` (the `node20` Codecov action), and that shim would execute inside
 * the later, secret-bearing step with `ACTIONS_PUSH` / `CODECOV_TOKEN` in its
 * own process environment.
 *
 * The fix breaks the shared-job boundary rather than patching the same job: a
 * fresh job gets a fresh runner environment, so neither `$GITHUB_PATH` nor
 * `$GITHUB_ENV` carries over. The bump commit and the coverage report are
 * handed between jobs as artefacts.
 *
 * These are "what" tests — the workflow YAML is the deliverable, so they parse
 * it and assert on its effective structure rather than grepping source text.
 */

const OUTDATED_PATH = ".github/workflows/deno-outdated.yml";
const QUALITY_PATH = ".github/workflows/quality.yml";

// deno-lint-ignore no-explicit-any
type Step = any;
// deno-lint-ignore no-explicit-any
type Job = any;

function readWorkflow(path: string): Record<string, Job> {
  return parse(Deno.readTextFileSync(path)) as Record<string, Job>;
}

function jobsOf(path: string): Array<[string, Job]> {
  return Object.entries(readWorkflow(path).jobs as Record<string, Job>);
}

function stepsOf(job: Job): Step[] {
  return (job.steps ?? []) as Step[];
}

/**
 * Commands that execute code taken from the checked-out working tree. A pull
 * request author controls every one of them, so any step matching this list
 * can append to `$GITHUB_PATH` on the PR's behalf.
 */
const WORKSPACE_CODE_MARKERS = [
  "bump-deps.sh",
  "deno test",
  "quality.sh",
  "run.sh",
  'source "common/',
];

/** Does this step execute code that the pull request controls? */
function runsPullRequestCode(step: Step): boolean {
  // A local `./…` composite action is loaded from the PR head checkout.
  if (typeof step.uses === "string" && step.uses.startsWith("./")) return true;
  const run = String(step.run ?? "");
  return WORKSPACE_CODE_MARKERS.some((marker) => run.includes(marker));
}

/** Everywhere a step can read a secret from: its `env`, `with` and `run` body. */
function surfaceOf(step: Step): string {
  return JSON.stringify({ env: step.env ?? {}, with: step.with ?? {}, run: step.run ?? "" });
}

function referencesSecret(step: Step): boolean {
  return surfaceOf(step).includes("secrets.");
}

function namesOf(steps: Step[]): string[] {
  return steps.map((s) => String(s.name ?? s.uses ?? "<unnamed>"));
}

for (const path of [OUTDATED_PATH, QUALITY_PATH]) {
  Deno.test(`${path}: no job runs PR code and a secret-bearing step together`, () => {
    for (const [id, job] of jobsOf(path)) {
      const steps = stepsOf(job);
      const untrusted = steps.filter(runsPullRequestCode);
      const secretBearing = steps.filter(referencesSecret);
      if (untrusted.length === 0 || secretBearing.length === 0) continue;
      assert(
        false,
        `Job "${id}" in ${path} runs PR-authored code (${namesOf(untrusted).join(", ")}) ` +
          `in the same runner environment as secret-bearing steps ` +
          `(${namesOf(secretBearing).join(", ")}). PR code can hijack the later step via ` +
          `$GITHUB_PATH — split the secret-bearing step into its own job (#747).`,
      );
    }
  });
}

Deno.test("deno-outdated pushes from a job that never runs PR code", () => {
  const jobs = jobsOf(OUTDATED_PATH);
  const pushJobs = jobs.filter(([, job]) =>
    stepsOf(job).some((s) => String(s.run ?? "").includes("git push"))
  );
  assertEquals(pushJobs.length, 1, "Expected exactly one job that pushes the bump commit");
  const [pushId, pushJob] = pushJobs[0];
  assertEquals(
    stepsOf(pushJob).filter(runsPullRequestCode).map((s) => String(s.name ?? s.uses)),
    [],
    `The PAT-bearing job "${pushId}" must not execute any pull-request-authored code`,
  );
  assert(
    stepsOf(pushJob).some((s) => referencesSecret(s)),
    "The push job must still authenticate with the org ACTIONS_PUSH PAT (#651)",
  );
});

Deno.test("deno-outdated hands the bump between jobs as an artefact", () => {
  const jobs = jobsOf(OUTDATED_PATH);
  const bumpJob = jobs.find(([, job]) =>
    stepsOf(job).some((s) => String(s.run ?? "").includes("bump-deps.sh"))
  );
  assert(bumpJob, "Expected a job that runs bump-deps.sh");
  const pushJob = jobs.find(([, job]) =>
    stepsOf(job).some((s) => String(s.run ?? "").includes("git push"))
  );
  assert(pushJob, "Expected a job that pushes the bump commit");
  assert(
    bumpJob[0] !== pushJob[0],
    "The bump and the push must run in separate jobs so $GITHUB_PATH cannot carry over",
  );
  assert(
    stepsOf(bumpJob[1]).some((s) => String(s.uses ?? "").includes("actions/upload-artifact")),
    "The bump job must upload the bumped manifests for the push job to consume",
  );
  assert(
    stepsOf(pushJob[1]).some((s) => String(s.uses ?? "").includes("actions/download-artifact")),
    "The push job must take the bumped manifests from the artefact, not re-run the PR script",
  );
  const needs = [pushJob[1].needs ?? []].flat().map(String);
  assert(
    needs.includes(bumpJob[0]),
    `The push job must depend on "${bumpJob[0]}", got: ${JSON.stringify(needs)}`,
  );
  assert(
    String(pushJob[1].if ?? "").includes("pushed"),
    "The push job must only run when the bump job reported a commit",
  );
});

Deno.test("quality uploads coverage from a job that never runs the PR test suite", () => {
  const jobs = jobsOf(QUALITY_PATH);
  const codecovJobs = jobs.filter(([, job]) =>
    stepsOf(job).some((s) => String(s.uses ?? "").includes("codecov/codecov-action"))
  );
  assertEquals(codecovJobs.length, 1, "Expected exactly one job that uploads to Codecov");
  const [codecovId, codecovJob] = codecovJobs[0];
  assertEquals(
    stepsOf(codecovJob).filter(runsPullRequestCode).map((s) => String(s.name ?? s.uses)),
    [],
    `The CODECOV_TOKEN-bearing job "${codecovId}" must not execute pull-request-authored code`,
  );
  const testJob = jobs.find(([, job]) =>
    stepsOf(job).some((s) => String(s.run ?? "").includes("deno test"))
  );
  assert(testJob, "Expected a job that runs the test suite");
  assert(
    testJob[0] !== codecovId,
    "The Codecov upload must not share a runner environment with the PR's own test suite",
  );
  assert(
    stepsOf(testJob[1]).some((s) => String(s.uses ?? "").includes("actions/upload-artifact")),
    "The unit-tests job must publish the lcov report as an artefact",
  );
  assert(
    stepsOf(codecovJob).some((s) => String(s.uses ?? "").includes("actions/download-artifact")),
    "The Codecov job must consume the coverage artefact",
  );
  const needs = [codecovJob.needs ?? []].flat().map(String);
  assert(
    needs.includes(testJob[0]),
    `The Codecov job must depend on "${testJob[0]}", got: ${JSON.stringify(needs)}`,
  );
});

Deno.test("every secret-bearing checkout keeps credentials out of the workspace", () => {
  for (const path of [OUTDATED_PATH, QUALITY_PATH]) {
    for (const [id, job] of jobsOf(path)) {
      const steps = stepsOf(job);
      if (!steps.some(referencesSecret)) continue;
      for (
        const checkout of steps.filter((s) => String(s.uses ?? "").includes("actions/checkout"))
      ) {
        assertEquals(
          checkout.with?.["persist-credentials"],
          false,
          `${path} job "${id}": a checkout in a secret-bearing job must not persist a credential`,
        );
      }
    }
  }
});
