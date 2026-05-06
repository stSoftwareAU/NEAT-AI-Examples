/**
 * Tests for the Markdown Lint workflow configuration.
 *
 * These tests parse the workflow YAML file and verify that it
 * contains the required configuration to lint Markdown files on
 * pull requests and pushes via markdownlint-cli2.
 */
import { assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = ".github/workflows/markdown-lint.yml";

/** Helper to load and parse the workflow file. */
function loadWorkflow(): Record<string, unknown> {
  const content = Deno.readTextFileSync(WORKFLOW_PATH);
  const parsed = parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Workflow file did not parse as an object");
  }
  return parsed as Record<string, unknown>;
}

Deno.test("markdown-lint workflow file exists and is valid YAML", () => {
  const workflow = loadWorkflow();
  assertExists(workflow, "Workflow should parse as a valid YAML object");
});

Deno.test("markdown-lint workflow has a descriptive name", () => {
  const workflow = loadWorkflow();
  assertExists(workflow.name, "Workflow should have a name field");
  assertEquals(typeof workflow.name, "string");
});

Deno.test("markdown-lint workflow triggers on pull_request and push events", () => {
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
  assertExists(triggers["push"], "Workflow should trigger on push events");
});

Deno.test("markdown-lint workflow declares read-only contents permission", () => {
  const workflow = loadWorkflow();
  const permissions = workflow["permissions"] as Record<string, unknown>;
  assertExists(permissions, "Workflow should declare permissions");
  assertEquals(
    permissions["contents"],
    "read",
    "Workflow should grant read-only access to repository contents",
  );
});

Deno.test("markdown-lint workflow defines at least one job", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, unknown>;
  assertExists(jobs, "Workflow should define jobs");
  assertEquals(
    Object.keys(jobs).length > 0,
    true,
    "Workflow should have at least one job",
  );
});

Deno.test("markdown-lint workflow checks out the repository", () => {
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
    "Workflow should check out the repository before linting",
  );
});

Deno.test("markdown-lint workflow sets up Node.js", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let setsUpNode = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("actions/setup-node@")) {
        setsUpNode = true;
        break;
      }
    }
    if (setsUpNode) break;
  }
  assertEquals(
    setsUpNode,
    true,
    "Workflow should set up Node.js so markdownlint-cli2 can run",
  );
});

Deno.test("markdown-lint workflow runs markdownlint-cli2", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let runsLinter = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const run = step["run"] as string | undefined;
      if (run && run.includes("markdownlint-cli2")) {
        runsLinter = true;
        break;
      }
    }
    if (runsLinter) break;
  }
  assertEquals(
    runsLinter,
    true,
    "Workflow should invoke markdownlint-cli2 to scan Markdown files",
  );
});

Deno.test("markdown-lint workflow pins actions to commit SHAs", () => {
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

Deno.test("markdownlint-cli2 config file exists and is valid", () => {
  const content = Deno.readTextFileSync(".markdownlint-cli2.jsonc");
  // Strip JSONC line comments before parsing.
  const stripped = content.replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(stripped);
  assertExists(cfg, "Config should parse as JSON");
  assertExists(cfg.config, "Config should expose a 'config' object of rules");
});
