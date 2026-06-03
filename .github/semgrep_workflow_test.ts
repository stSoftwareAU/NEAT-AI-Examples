// Tests for .github/workflows/semgrep.yml (Issue #555).
//
// The Semgrep SAST workflow runs inside a job-level container. A
// container image referenced by a mutable tag (e.g. `semgrep/semgrep`,
// which resolves to the floating `:latest` tag) carries the same
// supply-chain risk as an action pinned to a moving tag: the image
// behind the tag can be republished at any time and the next run will
// silently pull and execute the new layers — with the optional
// `SEMGREP_APP_TOKEN` secret in scope.
//
// These tests pin the contract:
//   * the job-level container image is pinned to an immutable
//     `@sha256:` digest (the focus of Issue #555),
//   * every `uses:` action is pinned to a 40-character commit SHA,
//   * the workflow runs on `ubuntu-latest` with read-only `contents`
//     permission, and
//   * it actually invokes the `semgrep` CLI so a regression fails CI

import { assert, assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = new URL("./workflows/semgrep.yml", import.meta.url);

// deno-lint-ignore no-explicit-any
type Workflow = any;

async function loadWorkflow(): Promise<Workflow> {
  const text = await Deno.readTextFile(WORKFLOW_PATH);
  return parse(text) as Workflow;
}

Deno.test("semgrep workflow — file exists and parses as YAML", async () => {
  const wf = await loadWorkflow();
  assertExists(wf, "workflow YAML must parse to an object");
  assertExists(wf.jobs, "workflow must declare at least one job");
});

Deno.test("semgrep workflow — job container image is pinned to a sha256 digest", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const digestPattern = /@sha256:[0-9a-f]{64}\b/;
  let containerCount = 0;
  for (const [jobKey, job] of Object.entries(jobs)) {
    const container = (job as { container?: unknown }).container;
    if (container === undefined) continue;
    containerCount++;
    // `container:` may be a bare string or an object with an `image:` key.
    const image = typeof container === "string"
      ? container
      : (container as { image?: string }).image;
    assertExists(
      image,
      `job '${jobKey}' container must declare an image`,
    );
    assert(
      digestPattern.test(image!),
      `job '${jobKey}' container image must be pinned to an immutable ` +
        `@sha256: digest, not a floating tag (got '${image}'). See ` +
        `Issue #555 and the supply-chain hardening rules in AGENTS.md.`,
    );
  }
  assert(
    containerCount > 0,
    "expected at least one job to run inside a container",
  );
});

Deno.test("semgrep workflow — every uses: pins a 40-char commit SHA", async () => {
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

Deno.test("semgrep workflow — runs on ubuntu-latest with read-only contents", async () => {
  const wf = await loadWorkflow();
  const perms = wf.permissions as Record<string, string> | undefined;
  assertExists(perms, "workflow must declare an explicit permissions block");
  assertEquals(
    perms.contents,
    "read",
    "semgrep only needs to read repository contents",
  );
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const jobKey = Object.keys(jobs)[0];
  assertEquals(
    jobs[jobKey]["runs-on"],
    "ubuntu-latest",
    `job '${jobKey}' must run on ubuntu-latest`,
  );
});

Deno.test("semgrep workflow — actually invokes the semgrep CLI", async () => {
  const wf = await loadWorkflow();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  let invokesSemgrep = false;
  for (const job of Object.values(jobs)) {
    const steps = (job as { steps?: Array<Record<string, unknown>> }).steps ??
      [];
    for (const step of steps) {
      const run = (step.run as string | undefined) ?? "";
      if (/\bsemgrep\b/.test(run)) {
        invokesSemgrep = true;
        break;
      }
    }
    if (invokesSemgrep) break;
  }
  assert(
    invokesSemgrep,
    "workflow must run the semgrep CLI so SAST regressions fail the build",
  );
});
