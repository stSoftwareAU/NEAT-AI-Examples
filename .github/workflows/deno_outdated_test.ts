/**
 * Tests for the Deno Dependency Updates workflow configuration.
 *
 * These tests parse the workflow YAML file and verify that it
 * automates checking for outdated Deno dependencies and opens a
 * pull request with the updates.
 */
import { assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = ".github/workflows/deno-outdated.yml";

/** Helper to load and parse the workflow file. */
function loadWorkflow(): Record<string, unknown> {
  const content = Deno.readTextFileSync(WORKFLOW_PATH);
  const parsed = parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Workflow file did not parse as an object");
  }
  return parsed as Record<string, unknown>;
}

Deno.test("deno-outdated workflow file exists and is valid YAML", () => {
  const workflow = loadWorkflow();
  assertExists(workflow, "Workflow should parse as a valid YAML object");
});

Deno.test("deno-outdated workflow has a descriptive name", () => {
  const workflow = loadWorkflow();
  assertExists(workflow.name, "Workflow should have a name field");
  assertEquals(typeof workflow.name, "string");
});

Deno.test("deno-outdated workflow runs on a weekly schedule and supports manual dispatch", () => {
  const workflow = loadWorkflow();

  // The 'on' key may be parsed as the boolean `true` by some YAML parsers
  // when unquoted, so we check for both 'on' and true as keys.
  const triggers = (workflow["on"] ?? workflow[String(true)]) as Record<
    string,
    unknown
  >;
  assertExists(triggers, "Workflow should have trigger configuration");

  const schedule = triggers["schedule"] as Array<Record<string, unknown>>;
  assertExists(schedule, "Workflow should declare a schedule trigger");
  assertEquals(
    Array.isArray(schedule) && schedule.length > 0,
    true,
    "Schedule trigger should list at least one cron entry",
  );
  const firstCron = schedule[0]["cron"];
  assertEquals(
    typeof firstCron,
    "string",
    "Schedule entry should specify a cron expression",
  );

  assertEquals(
    Object.prototype.hasOwnProperty.call(triggers, "workflow_dispatch"),
    true,
    "Workflow should also support manual workflow_dispatch",
  );
});

Deno.test("deno-outdated workflow grants write permissions for content and pull-requests", () => {
  const workflow = loadWorkflow();
  const permissions = workflow["permissions"] as Record<string, unknown>;
  assertExists(permissions, "Workflow should declare permissions");
  assertEquals(
    permissions["contents"],
    "write",
    "Workflow needs write access to contents to push the update branch",
  );
  assertEquals(
    permissions["pull-requests"],
    "write",
    "Workflow needs write access to pull-requests to open the PR",
  );
});

Deno.test("deno-outdated workflow installs Deno", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;
  assertExists(jobs, "Workflow should define jobs");

  let installsDeno = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("denoland/setup-deno@")) {
        installsDeno = true;
        break;
      }
    }
  }
  assertEquals(
    installsDeno,
    true,
    "Workflow should install Deno via the setup-deno action",
  );
});

Deno.test("deno-outdated workflow runs deno outdated --update --latest", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let runsOutdated = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const run = step["run"] as string | undefined;
      if (
        run && run.includes("deno outdated") && run.includes("--update") &&
        run.includes("--latest")
      ) {
        runsOutdated = true;
        break;
      }
    }
  }
  assertEquals(
    runsOutdated,
    true,
    "Workflow should run `deno outdated --update --latest` to refresh dependencies",
  );
});

Deno.test("deno-outdated workflow opens a pull request via create-pull-request action", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let opensPr = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("peter-evans/create-pull-request@")) {
        opensPr = true;
        break;
      }
    }
  }
  assertEquals(
    opensPr,
    true,
    "Workflow should use peter-evans/create-pull-request to open the update PR",
  );
});
