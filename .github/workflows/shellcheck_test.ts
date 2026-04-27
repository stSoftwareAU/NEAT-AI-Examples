/**
 * Tests for the ShellCheck Lint workflow configuration.
 *
 * These tests parse the workflow YAML file and verify that it
 * contains the required configuration to lint shell scripts on
 * pull requests using ShellCheck.
 */
import { assertEquals, assertExists } from "@std/assert";
import { parse } from "@std/yaml";

const WORKFLOW_PATH = ".github/workflows/shellcheck.yml";

/** Helper to load and parse the workflow file. */
function loadWorkflow(): Record<string, unknown> {
  const content = Deno.readTextFileSync(WORKFLOW_PATH);
  const parsed = parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Workflow file did not parse as an object");
  }
  return parsed as Record<string, unknown>;
}

Deno.test("shellcheck workflow file exists and is valid YAML", () => {
  const workflow = loadWorkflow();
  assertExists(workflow, "Workflow should parse as a valid YAML object");
});

Deno.test("shellcheck workflow has a descriptive name", () => {
  const workflow = loadWorkflow();
  assertExists(workflow.name, "Workflow should have a name field");
  assertEquals(typeof workflow.name, "string");
});

Deno.test("shellcheck workflow triggers on pull_request events", () => {
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

Deno.test("shellcheck workflow declares read-only contents permission", () => {
  const workflow = loadWorkflow();
  const permissions = workflow["permissions"] as Record<string, unknown>;
  assertExists(permissions, "Workflow should declare permissions");
  assertEquals(
    permissions["contents"],
    "read",
    "Workflow should grant read-only access to repository contents",
  );
});

Deno.test("shellcheck workflow defines a shellcheck job", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, unknown>;
  assertExists(jobs, "Workflow should define jobs");
  assertEquals(
    Object.keys(jobs).length > 0,
    true,
    "Workflow should have at least one job",
  );
});

Deno.test("shellcheck workflow checks out the repository", () => {
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
    "Workflow should check out the repository before scanning",
  );
});

Deno.test("shellcheck workflow runs shellcheck to lint shell scripts", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  let runsShellcheck = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const uses = step["uses"] as string | undefined;
      if (uses && uses.startsWith("ludeeus/action-shellcheck@")) {
        runsShellcheck = true;
        break;
      }
      const run = step["run"] as string | undefined;
      if (run && run.includes("shellcheck")) {
        runsShellcheck = true;
        break;
      }
    }
    if (runsShellcheck) break;
  }
  assertEquals(
    runsShellcheck,
    true,
    "Workflow should run shellcheck to lint shell scripts",
  );
});

Deno.test("shellcheck workflow pins actions to commit SHAs", () => {
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

Deno.test("shellcheck workflow configures severity at warning or stricter", () => {
  const workflow = loadWorkflow();
  const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;

  // The issue's suggested template requests `severity: warning` so that
  // style-only suggestions do not fail the build but real warnings do.
  const allowed = new Set(["warning", "error"]);

  let hasSeverity = false;
  for (const name of Object.keys(jobs)) {
    const steps = jobs[name]["steps"] as Array<Record<string, unknown>>;
    if (!steps) continue;
    for (const step of steps) {
      const withCfg = step["with"] as Record<string, unknown> | undefined;
      if (withCfg && typeof withCfg["severity"] === "string") {
        const sev = withCfg["severity"] as string;
        assertEquals(
          allowed.has(sev),
          true,
          `Severity '${sev}' should be one of ${[...allowed].join(", ")}`,
        );
        hasSeverity = true;
      }
      const run = step["run"] as string | undefined;
      if (run && run.includes("--severity")) {
        hasSeverity = true;
      }
    }
  }
  assertEquals(
    hasSeverity,
    true,
    "Workflow should configure shellcheck severity (warning or error)",
  );
});
