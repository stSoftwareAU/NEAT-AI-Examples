/**
 * Tests for the Gitleaks Secrets Detection workflow configuration.
 *
 * These tests parse the workflow YAML file and verify that it
 * contains the required configuration to scan pull requests for
 * accidentally committed secrets.
 */
import { assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = ".github/workflows/gitleaks.yml";

/** Helper to load and parse the workflow file. */
function loadWorkflow(): Record<string, unknown> {
  const content = Deno.readTextFileSync(WORKFLOW_PATH);
  const parsed = parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Workflow file did not parse as an object");
  }
  return parsed as Record<string, unknown>;
}

Deno.test("gitleaks workflow file exists and is valid YAML", () => {
  const workflow = loadWorkflow();
  assertExists(workflow, "Workflow should parse as a valid YAML object");
});

Deno.test("gitleaks workflow has a descriptive name", () => {
  const workflow = loadWorkflow();
  assertExists(workflow.name, "Workflow should have a name field");
  assertEquals(typeof workflow.name, "string");
});

Deno.test("gitleaks workflow triggers on pull_request events", () => {
  const workflow = loadWorkflow();

  // The 'on' key may be parsed as the boolean `true` by some YAML parsers
  // when unquoted, so we check for both 'on' and true as keys.
  const triggers = (workflow["on"] ?? workflow[String(true)]) as Record<
    string,
    unknown
  >;
  assertExists(triggers, "Workflow should have trigger configuration");

  const pr = triggers["pull_request"] as Record<string, unknown>;
  assertExists(pr, "Workflow should trigger on pull_request events");
});

Deno.test("gitleaks workflow declares read-only contents permission", () => {
  const workflow = loadWorkflow();
  const permissions = workflow["permissions"] as Record<string, unknown>;
  assertExists(permissions, "Workflow should declare permissions");
  assertEquals(
    permissions["contents"],
    "read",
    "Workflow should grant read-only access to repository contents",
  );
});

Deno.test("gitleaks workflow defines a gitleaks job", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, unknown>;
  assertExists(jobs, "Workflow should define jobs");
  assertEquals(
    Object.keys(jobs).length > 0,
    true,
    "Workflow should have at least one job",
  );
});

Deno.test("gitleaks workflow checks out the full git history", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let fullHistory = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("actions/checkout@")) {
        const withCfg = step["with"] as Record<string, unknown> | undefined;
        if (withCfg && Number(withCfg["fetch-depth"]) === 0) {
          fullHistory = true;
        }
      }
    }
  }
  assertEquals(
    fullHistory,
    true,
    "Workflow should check out the full git history (fetch-depth: 0) so gitleaks can scan all commits",
  );
});

Deno.test("gitleaks workflow runs the gitleaks-action", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let usesGitleaks = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("gitleaks/gitleaks-action@")) {
        usesGitleaks = true;
        break;
      }
    }
  }
  assertEquals(
    usesGitleaks,
    true,
    "Workflow should run the gitleaks/gitleaks-action step",
  );
});
