/**
 * Tests for the GitHub Actions CI/CD workflow configuration.
 *
 * These tests parse the workflow YAML file and verify that it contains
 * the required configuration for automated quality checks.
 */
import { assertEquals, assertExists } from "@std/assert";
import { parse } from "jsr:@std/yaml@1.0.5";

const WORKFLOW_PATH = ".github/workflows/quality.yml";

/** Helper to load and parse the workflow file. */
function loadWorkflow(): Record<string, unknown> {
  const content = Deno.readTextFileSync(WORKFLOW_PATH);
  const parsed = parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Workflow file did not parse as an object");
  }
  return parsed as Record<string, unknown>;
}

Deno.test("workflow file exists and is valid YAML", () => {
  const workflow = loadWorkflow();
  assertExists(workflow, "Workflow should parse as a valid YAML object");
});

Deno.test("workflow has a descriptive name", () => {
  const workflow = loadWorkflow();
  assertExists(workflow.name, "Workflow should have a name field");
  assertEquals(typeof workflow.name, "string");
});

Deno.test("workflow triggers on push and pull_request to Develop", () => {
  const workflow = loadWorkflow();

  // The 'on' key may be parsed as 'true' by some YAML parsers when unquoted,
  // so we check for both 'on' and true as keys.
  const triggers = (workflow["on"] ?? workflow[String(true)]) as Record<
    string,
    unknown
  >;
  assertExists(triggers, "Workflow should have trigger configuration");

  // Check push trigger targets Develop
  const push = triggers["push"] as Record<string, unknown>;
  assertExists(push, "Workflow should trigger on push events");
  const pushBranches = push["branches"] as string[];
  assertExists(pushBranches, "Push trigger should specify branches");
  assertEquals(
    pushBranches.includes("Develop"),
    true,
    "Push trigger should include the Develop branch",
  );

  // Check pull_request trigger targets Develop
  const pr = triggers["pull_request"] as Record<string, unknown>;
  assertExists(pr, "Workflow should trigger on pull_request events");
  const prBranches = pr["branches"] as string[];
  assertExists(prBranches, "Pull request trigger should specify branches");
  assertEquals(
    prBranches.includes("Develop"),
    true,
    "Pull request trigger should include the Develop branch",
  );
});

Deno.test("workflow defines at least one job", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, unknown>;
  assertExists(jobs, "Workflow should define jobs");
  assertEquals(
    Object.keys(jobs).length > 0,
    true,
    "Workflow should have at least one job",
  );
});

Deno.test("workflow installs Deno", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;
  const jobNames = Object.keys(jobs);

  // Find a job that has steps installing Deno
  let denoInstalled = false;
  for (const name of jobNames) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("denoland/setup-deno@")) {
        denoInstalled = true;
        break;
      }
    }
  }
  assertEquals(denoInstalled, true, "Workflow should install Deno via setup-deno action");
});

Deno.test("workflow runs unit tests", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  // Check that at least one job step runs deno test
  let runsTests = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const run = step["run"] as string | undefined;
      if (run && run.includes("deno test")) {
        runsTests = true;
        break;
      }
    }
  }
  assertEquals(runsTests, true, "Workflow should run deno test");
});

Deno.test("workflow runs example programs", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  // Check that example runner scripts are executed
  let runsIntelligentDesign = false;
  let runsDiscovery = false;
  let runsSuggestImprovements = false;

  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const run = step["run"] as string | undefined;
      if (!run) continue;
      if (run.includes("intelligent_design/run.sh")) {
        runsIntelligentDesign = true;
      }
      if (run.includes("discovery/run.sh")) {
        runsDiscovery = true;
      }
      if (run.includes("suggest_improvements/run.sh")) {
        runsSuggestImprovements = true;
      }
    }
  }

  assertEquals(
    runsIntelligentDesign,
    true,
    "Workflow should run the Intelligent Design example",
  );
  assertEquals(
    runsDiscovery,
    true,
    "Workflow should run the Discovery example",
  );
  assertEquals(
    runsSuggestImprovements,
    true,
    "Workflow should run the Suggest Improvements example",
  );
});
