/**
 * Tests for the Deno Quality (lint, fmt, type-check, test+coverage) workflow.
 *
 * These tests parse the workflow YAML file and verify that it contains
 * the configuration required by issue #51 — a dedicated workflow that
 * runs Deno lint, format check, type check, and tests with coverage
 * uploaded to Codecov on every pull request.
 */
import { assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = ".github/workflows/deno-quality.yml";

/** Helper to load and parse the workflow file. */
function loadWorkflow(): Record<string, unknown> {
  const content = Deno.readTextFileSync(WORKFLOW_PATH);
  const parsed = parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Workflow file did not parse as an object");
  }
  return parsed as Record<string, unknown>;
}

/** Collect every step across every job in the workflow. */
function allSteps(
  workflow: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;
  const steps: Array<Record<string, unknown>> = [];
  for (const name of Object.keys(jobs)) {
    const jobSteps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (jobSteps) steps.push(...jobSteps);
  }
  return steps;
}

Deno.test("deno-quality workflow file exists and is valid YAML", () => {
  const workflow = loadWorkflow();
  assertExists(workflow, "Workflow should parse as a valid YAML object");
});

Deno.test("deno-quality workflow has a descriptive name", () => {
  const workflow = loadWorkflow();
  assertExists(workflow.name, "Workflow should have a name field");
  assertEquals(typeof workflow.name, "string");
});

Deno.test("deno-quality workflow triggers on pull_request events", () => {
  const workflow = loadWorkflow();
  // The 'on' key may be parsed as the boolean `true` by some YAML parsers
  // when unquoted, so we check for both 'on' and true as keys.
  const triggers = (workflow["on"] ?? workflow[String(true)]) as Record<
    string,
    unknown
  >;
  assertExists(triggers, "Workflow should have trigger configuration");
  assertExists(
    triggers["pull_request"],
    "Workflow should trigger on pull_request events",
  );
});

Deno.test("deno-quality workflow declares read-only contents permission", () => {
  const workflow = loadWorkflow();
  const permissions = workflow["permissions"] as Record<string, unknown>;
  assertExists(permissions, "Workflow should declare permissions");
  assertEquals(
    permissions["contents"],
    "read",
    "Workflow should grant read-only access to repository contents",
  );
});

Deno.test("deno-quality workflow defines at least one job", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, unknown>;
  assertExists(jobs, "Workflow should define jobs");
  assertEquals(
    Object.keys(jobs).length > 0,
    true,
    "Workflow should have at least one job",
  );
});

Deno.test("deno-quality workflow checks out the repository", () => {
  const workflow = loadWorkflow();
  const checksOut = allSteps(workflow).some((s) => {
    const uses = s["uses"] as string | undefined;
    return Boolean(uses && uses.startsWith("actions/checkout@"));
  });
  assertEquals(
    checksOut,
    true,
    "Workflow should check out the repository",
  );
});

Deno.test("deno-quality workflow installs Deno", () => {
  const workflow = loadWorkflow();
  const installsDeno = allSteps(workflow).some((s) => {
    const uses = s["uses"] as string | undefined;
    return Boolean(uses && uses.startsWith("denoland/setup-deno@"));
  });
  assertEquals(
    installsDeno,
    true,
    "Workflow should install Deno via setup-deno action",
  );
});

Deno.test("deno-quality workflow runs deno lint", () => {
  const workflow = loadWorkflow();
  const runsLint = allSteps(workflow).some((s) => {
    const run = s["run"] as string | undefined;
    return Boolean(run && /\bdeno lint\b/.test(run));
  });
  assertEquals(runsLint, true, "Workflow should run deno lint");
});

Deno.test("deno-quality workflow runs deno fmt --check", () => {
  const workflow = loadWorkflow();
  const runsFmt = allSteps(workflow).some((s) => {
    const run = s["run"] as string | undefined;
    return Boolean(run && run.includes("deno fmt --check"));
  });
  assertEquals(runsFmt, true, "Workflow should run deno fmt --check");
});

Deno.test("deno-quality workflow runs deno check (type checking)", () => {
  const workflow = loadWorkflow();
  const runsCheck = allSteps(workflow).some((s) => {
    const run = s["run"] as string | undefined;
    return Boolean(run && /\bdeno check\b/.test(run));
  });
  assertEquals(runsCheck, true, "Workflow should run deno check for type checking");
});

Deno.test("deno-quality workflow runs deno test with coverage", () => {
  const workflow = loadWorkflow();
  const steps = allSteps(workflow);

  const runsTestCoverage = steps.some((s) => {
    const run = s["run"] as string | undefined;
    return Boolean(run && run.includes("deno test") && run.includes("--coverage="));
  });
  assertEquals(
    runsTestCoverage,
    true,
    "Workflow should run deno test with --coverage to produce a profile",
  );

  const generatesLcov = steps.some((s) => {
    const run = s["run"] as string | undefined;
    return Boolean(run && run.includes("deno coverage") && run.includes("--lcov"));
  });
  assertEquals(
    generatesLcov,
    true,
    "Workflow should generate an lcov coverage report via deno coverage --lcov",
  );
});

Deno.test("deno-quality workflow uploads coverage to Codecov", () => {
  const workflow = loadWorkflow();
  const usesCodecov = allSteps(workflow).some((s) => {
    const uses = s["uses"] as string | undefined;
    return Boolean(uses && uses.startsWith("codecov/codecov-action@"));
  });
  assertEquals(
    usesCodecov,
    true,
    "Workflow should upload coverage via the codecov/codecov-action",
  );
});

Deno.test("deno-quality workflow pins actions to commit SHAs", () => {
  const workflow = loadWorkflow();
  const sha40 = /^[0-9a-f]{40}$/;

  for (const step of allSteps(workflow)) {
    const uses = step["uses"] as string | undefined;
    if (!uses) continue;
    const atIdx = uses.lastIndexOf("@");
    assertEquals(
      atIdx > 0,
      true,
      `Step '${uses}' should pin a version with '@'`,
    );
    const ref = uses.slice(atIdx + 1);
    assertEquals(
      sha40.test(ref),
      true,
      `Step '${uses}' should be pinned to a 40-character commit SHA, not '${ref}'`,
    );
  }
});
