import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * Verify the Codecov upload step does not run on a withdrawn Actions runtime
 * (Issue #746).
 *
 * `codecov/codecov-action` v4.6.0 declares `runs.using: 'node20'`. GitHub
 * removes the node20 runner on 2026-09-16, after which the step fails and
 * takes the required `Run quality checks` aggregate job down with it. v7 is a
 * `composite` action, so it carries no Node runtime and cannot expire the same
 * way. A SHA pin freezes the commit, not the runtime, so the pin alone is no
 * defence.
 *
 * These are "what" tests: the workflow YAML is the deliverable, so they parse
 * it and assert on the step's effective configuration.
 */

const QUALITY_PATH = ".github/workflows/quality.yml";

/** Pinned SHAs known to declare a withdrawn `runs.using` runtime. */
const DEPRECATED_RUNTIME_SHAS = new Map<string, string>([
  ["b9fd7d16f6d7d1b5d2bec1a2887e65ceed900238", "codecov/codecov-action v4.6.0 (node20)"],
]);

/** First major version of `codecov/codecov-action` published as a composite action. */
const MIN_CODECOV_MAJOR = 7;

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

function readWorkflowText(): string {
  return Deno.readTextFileSync(QUALITY_PATH);
}

function allSteps(text: string): Step[] {
  const wf = parse(text) as { jobs: Record<string, { steps?: Step[] }> };
  return Object.values(wf.jobs).flatMap((job) => job.steps ?? []);
}

function codecovSteps(text: string): Step[] {
  return allSteps(text).filter((s) => s.uses?.startsWith("codecov/codecov-action@"));
}

Deno.test("the Codecov upload step is pinned to a composite-action major", () => {
  const text = readWorkflowText();
  const steps = codecovSteps(text);
  assertEquals(steps.length, 1, "expected exactly one codecov/codecov-action step");

  const ref = steps[0].uses!.split("@")[1];
  assert(/^[0-9a-f]{40}$/.test(ref), `codecov/codecov-action must stay SHA-pinned, got: ${ref}`);

  // The human-readable version lives in the trailing comment on the `uses:` line.
  const line = text.split("\n").find((l) => l.includes(`codecov/codecov-action@${ref}`));
  const version = line?.match(/#\s*v(\d+)\.\d+\.\d+/)?.[1];
  assert(version !== undefined, `the codecov pin must carry a "# vX.Y.Z" version comment`);
  assert(
    Number(version) >= MIN_CODECOV_MAJOR,
    `codecov/codecov-action must be >= v${MIN_CODECOV_MAJOR} (composite, no Node runtime), ` +
      `got v${version}`,
  );
});

Deno.test("no workflow step pins an action known to use a withdrawn runtime", () => {
  const text = readWorkflowText();
  for (const step of allSteps(text)) {
    const ref = step.uses?.split("@")[1];
    if (ref === undefined) continue;
    const deprecated = DEPRECATED_RUNTIME_SHAS.get(ref);
    assertEquals(
      deprecated,
      undefined,
      `Step "${step.name ?? step.uses}" pins ${deprecated} — that runtime is being withdrawn`,
    );
  }
});

Deno.test("the Codecov upload step keeps its inputs after the bump", () => {
  const step = codecovSteps(readWorkflowText())[0];
  const inputs = step.with ?? {};
  assertEquals(inputs.files, ".coverage/coverage.lcov");
  assertEquals(inputs.fail_ci_if_error, false);
  assert(
    typeof inputs.token === "string" && inputs.token.includes("secrets.CODECOV_TOKEN"),
    `the upload step must keep passing the CODECOV_TOKEN secret, got: ${inputs.token}`,
  );
});
