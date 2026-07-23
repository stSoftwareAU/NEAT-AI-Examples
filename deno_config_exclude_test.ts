import { assert } from "@std/assert";
import { parse } from "@std/yaml";

/**
 * The `unit-tests` job checks NEAT-AI-scorer and NEAT-AI-core out *into*
 * the workspace (actions/checkout cannot write outside $GITHUB_WORKSPACE)
 * so Cargo can build rust_scorer against its sibling path dependency.
 *
 * Those repositories carry their own Deno test files, which import
 * `jsr:@std/assert@1` — a specifier this repo's deno.lock does not and
 * should not contain. Without a root-level `exclude`, `deno test` walks
 * the whole working directory, discovers those files, resolves their
 * imports, and fails with "The lockfile is out of date" under `--frozen`.
 *
 * `fmt.exclude` alone is not enough: it scopes only `deno fmt`.
 *
 * These are "what" tests — the config and workflow are the deliverable,
 * so they parse them and assert on structure rather than grepping text.
 */

const DENO_CONFIG_PATH = "deno.json";
const QUALITY_PATH = ".github/workflows/quality.yml";

// deno-lint-ignore no-explicit-any
function readDenoConfig(): any {
  return JSON.parse(Deno.readTextFileSync(DENO_CONFIG_PATH));
}

/** Directories quality.yml checks out into the workspace via `path:`. */
function inWorkspaceCheckoutPaths(): string[] {
  // deno-lint-ignore no-explicit-any
  const wf: any = parse(Deno.readTextFileSync(QUALITY_PATH));
  const paths = new Set<string>();
  // deno-lint-ignore no-explicit-any
  for (const job of Object.values(wf.jobs) as any[]) {
    for (const step of job.steps ?? []) {
      if (
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout@") &&
        typeof step.with?.path === "string"
      ) {
        paths.add(step.with.path);
      }
    }
  }
  return [...paths];
}

Deno.test("deno.json excludes every in-workspace repository checkout", () => {
  const exclude: string[] = readDenoConfig().exclude ?? [];
  const checkouts = inWorkspaceCheckoutPaths();

  assert(
    checkouts.length > 0,
    "Expected quality.yml to check at least one repository into the workspace",
  );

  for (const path of checkouts) {
    assert(
      exclude.includes(path),
      `deno.json "exclude" must list "${path}" — quality.yml checks that ` +
        `repository out into the workspace, and its test files would ` +
        `otherwise break "deno test --frozen".`,
    );
  }
});

/** Entries of every `--ignore=` flag passed to `deno test` in quality.yml. */
function testIgnoreEntries(): string[][] {
  const yaml = Deno.readTextFileSync(QUALITY_PATH);
  const flags = [...yaml.matchAll(/--ignore=(\S+)/g)];
  return flags.map(([, list]) => list.split(","));
}

Deno.test("deno test --ignore repeats every in-workspace repository checkout", () => {
  // `--ignore` replaces deno.json's "exclude" rather than adding to it, so a
  // command that ignores anything must re-state the excluded checkouts.
  const checkouts = inWorkspaceCheckoutPaths();
  const ignoreLists = testIgnoreEntries();

  assert(
    ignoreLists.length > 0,
    "Expected quality.yml to pass at least one --ignore flag to deno test",
  );

  for (const entries of ignoreLists) {
    for (const path of checkouts) {
      assert(
        entries.includes(path),
        `A "--ignore=" list in quality.yml omits "${path}". --ignore ` +
          `overrides deno.json "exclude", so deno test would walk that ` +
          `in-workspace checkout and fail under --frozen. Current list: ` +
          entries.join(","),
      );
    }
  }
});

Deno.test("deno.json exclude covers the coverage output directory", () => {
  const exclude: string[] = readDenoConfig().exclude ?? [];
  assert(
    exclude.includes(".coverage"),
    'deno.json "exclude" must list ".coverage" so generated coverage ' +
      "artefacts are not treated as source.",
  );
});
