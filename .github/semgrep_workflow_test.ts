// Tests for .github/workflows/semgrep.yml (Issue #555)
//
// The Semgrep SAST workflow runs inside a job-level container. A
// container image referenced by a mutable tag (e.g. `semgrep/semgrep`,
// which resolves to the floating `:latest` tag) carries the same
// supply-chain risk as an action pinned to a moving tag: the image
// behind the tag can be republished at any time and the next run will
// silently pull and execute the new layers — with the optional
// `SEMGREP_APP_TOKEN` secret in scope.
//
// A digest with no tag beside it is immutable but untrackable: the
// dependency updaters (Renovate's `docker` manager, Dependabot's
// `docker` ecosystem) resolve a bump from the *tag* and then rewrite
// the digest, so a tagless pin freezes the image forever and no scan
// notices it has drifted (Issue #825).
//
// These tests pin the contract:
//   * the job-level container image is pinned to an immutable
//     `@sha256:` digest (the focus of Issue #555),
//   * that digest carries an explicit release tag so updaters can raise
//     bump PRs against it (Issue #825),
//   * the workflow runs on `ubuntu-latest` with read-only `contents`
//     permission, and
//   * it actually invokes the `semgrep` CLI so a regression fails CI
//
// The 40-character SHA-pin policy for `uses:` is asserted for every
// workflow at once in `workflow_pin_policy_test.ts` (Issue #744).

import { assert, assertEquals, assertExists } from "@std/assert";
import { loadWorkflow } from "./workflow_test_utils.ts";

const WORKFLOW = "semgrep.yml";

/**
 * Every job-level container image declared by the workflow, as
 * `[jobKey, image]` pairs. `container:` may be a bare string or an
 * object with an `image:` key — both spellings are collected.
 */
async function containerImages(): Promise<Array<[string, string]>> {
  const wf = await loadWorkflow(WORKFLOW);
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const images: Array<[string, string]> = [];
  for (const [jobKey, job] of Object.entries(jobs)) {
    const container = (job as { container?: unknown }).container;
    if (container === undefined) continue;
    const image = typeof container === "string"
      ? container
      : (container as { image?: string }).image;
    assertExists(image, `job '${jobKey}' container must declare an image`);
    images.push([jobKey, image!]);
  }
  return images;
}

/**
 * The tag of an image reference, or `undefined` when it carries none.
 * The tag lives in the final path segment before any `@digest`, so a
 * registry port (`registry:5000/image@sha256:…`) is not mistaken for one.
 */
function imageTag(image: string): string | undefined {
  const name = image.split("@")[0];
  const lastSegment = name.slice(name.lastIndexOf("/") + 1);
  const colon = lastSegment.indexOf(":");
  if (colon === -1) return undefined;
  const tag = lastSegment.slice(colon + 1);
  return tag === "" ? undefined : tag;
}

Deno.test("semgrep workflow — file exists and parses as YAML", async () => {
  const wf = await loadWorkflow(WORKFLOW);
  assertExists(wf, "workflow YAML must parse to an object");
  assertExists(wf.jobs, "workflow must declare at least one job");
});

Deno.test("semgrep workflow — job container image is pinned to a sha256 digest", async () => {
  const images = await containerImages();
  const digestPattern = /@sha256:[0-9a-f]{64}$/;
  for (const [jobKey, image] of images) {
    assert(
      digestPattern.test(image),
      `job '${jobKey}' container image must be pinned to an immutable ` +
        `@sha256: digest, not a floating tag (got '${image}'). See ` +
        `Issue #555 and the supply-chain hardening rules in AGENTS.md.`,
    );
  }
  assert(
    images.length > 0,
    "expected at least one job to run inside a container",
  );
});

Deno.test("semgrep workflow — digest pin carries a trackable release tag", async () => {
  const images = await containerImages();
  for (const [jobKey, image] of images) {
    const tag = imageTag(image);
    assertExists(
      tag,
      `job '${jobKey}' container image '${image}' pins a digest with no tag ` +
        `beside it. Dependency updaters resolve bumps from the tag and then ` +
        `rewrite the digest, so a tagless pin is frozen forever — write it as ` +
        `name:<release-tag>@sha256:<digest> (Issue #825).`,
    );
    assert(
      tag !== "latest",
      `job '${jobKey}' container image '${image}' pins the floating 'latest' ` +
        `tag. Updaters cannot resolve a version bump from 'latest' — use the ` +
        `explicit release tag the digest corresponds to (Issue #825).`,
    );
  }
  assert(
    images.length > 0,
    "expected at least one job to run inside a container",
  );
});

Deno.test("semgrep workflow — runs on ubuntu-latest with read-only contents", async () => {
  const wf = await loadWorkflow(WORKFLOW);
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
  const wf = await loadWorkflow(WORKFLOW);
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
