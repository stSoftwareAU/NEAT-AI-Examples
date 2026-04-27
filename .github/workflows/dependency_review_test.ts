/**
 * Tests for the Dependency Review workflow configuration.
 *
 * These tests parse the workflow YAML file and verify that it
 * contains the required configuration to scan pull requests for
 * vulnerable dependencies via the GitHub Dependency Review action.
 */
import { assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = ".github/workflows/dependency-review.yml";

/** Helper to load and parse the workflow file. */
function loadWorkflow(): Record<string, unknown> {
  const content = Deno.readTextFileSync(WORKFLOW_PATH);
  const parsed = parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Workflow file did not parse as an object");
  }
  return parsed as Record<string, unknown>;
}

Deno.test("dependency-review workflow file exists and is valid YAML", () => {
  const workflow = loadWorkflow();
  assertExists(workflow, "Workflow should parse as a valid YAML object");
});

Deno.test("dependency-review workflow has a descriptive name", () => {
  const workflow = loadWorkflow();
  assertExists(workflow.name, "Workflow should have a name field");
  assertEquals(typeof workflow.name, "string");
});

Deno.test("dependency-review workflow triggers on pull_request events", () => {
  const workflow = loadWorkflow();

  // The 'on' key may be parsed as the boolean `true` by some YAML parsers
  // when unquoted, so we check for both 'on' and true as keys.
  const triggers = (workflow["on"] ?? workflow[String(true)]) as Record<
    string,
    unknown
  >;
  assertExists(triggers, "Workflow should have trigger configuration");

  const pr = triggers["pull_request"];
  assertExists(pr, "Workflow should trigger on pull_request events");
});

Deno.test("dependency-review workflow declares read-only contents permission", () => {
  const workflow = loadWorkflow();
  const permissions = workflow["permissions"] as Record<string, unknown>;
  assertExists(permissions, "Workflow should declare permissions");
  assertEquals(
    permissions["contents"],
    "read",
    "Workflow should grant read-only access to repository contents",
  );
});

Deno.test("dependency-review workflow defines a dependency-review job", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, unknown>;
  assertExists(jobs, "Workflow should define jobs");
  assertEquals(
    Object.keys(jobs).length > 0,
    true,
    "Workflow should have at least one job",
  );
});

Deno.test("dependency-review workflow checks out the repository", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let checksOut = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("actions/checkout@")) {
        checksOut = true;
        break;
      }
    }
    if (checksOut) break;
  }
  assertEquals(
    checksOut,
    true,
    "Workflow should check out the repository before reviewing dependencies",
  );
});

Deno.test("dependency-review workflow runs the dependency-review-action", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let runsAction = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("actions/dependency-review-action@")) {
        runsAction = true;
        break;
      }
    }
    if (runsAction) break;
  }
  assertEquals(
    runsAction,
    true,
    "Workflow should invoke actions/dependency-review-action to scan dependencies",
  );
});

Deno.test("dependency-review workflow pins actions to commit SHAs", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  // Per the project's supply-chain rules, third-party actions should be
  // pinned to a 40-character commit SHA rather than a moving tag.
  const sha40 = /^[0-9a-f]{40}$/;

  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
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
  }
});
