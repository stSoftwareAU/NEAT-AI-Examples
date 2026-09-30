// Shared helpers for the `.github` workflow policy tests (Issue #744).
//
// The per-workflow suites each hand-rolled the same YAML-loading
// boilerplate (`loadWorkflow`, `triggers`) and repeated an identical
// SHA-pin assertion body. Every copy was another place a policy change
// had to be applied by hand, and a missed copy silently weakened the
// gate. This module is the single source of truth for the loading
// helpers and for the pin policy itself; `workflow_pin_policy_test.ts`
// applies the policy to every committed workflow and composite action.

import { parse } from "@std/yaml";

// deno-lint-ignore no-explicit-any
export type Workflow = any;

/** Directory holding the committed GitHub Actions workflows. */
export const WORKFLOW_DIR = new URL("./workflows/", import.meta.url);

/** Directory holding the repository's local composite actions. */
export const ACTIONS_DIR = new URL("./actions/", import.meta.url);

/** Parses any YAML document at `url`. */
export async function loadYaml(url: URL): Promise<Workflow> {
  return parse(await Deno.readTextFile(url)) as Workflow;
}

/** Loads a workflow by file name, e.g. `loadWorkflow("quality.yml")`. */
export function loadWorkflow(name: string): Promise<Workflow> {
  return loadYaml(new URL(name, WORKFLOW_DIR));
}

/** Every workflow file name under `.github/workflows`, sorted. */
export async function workflowNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(WORKFLOW_DIR)) {
    if (entry.isFile && /\.ya?ml$/.test(entry.name)) names.push(entry.name);
  }
  return names.sort();
}

/** Every local composite action name under `.github/actions`, sorted. */
export async function compositeActionNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(ACTIONS_DIR)) {
    if (entry.isDirectory) names.push(entry.name);
  }
  return names.sort();
}

/** Loads a local composite action by directory name. */
export function loadCompositeAction(name: string): Promise<Workflow> {
  return loadYaml(new URL(`${name}/action.yml`, ACTIONS_DIR));
}

/** The `on:` block of a workflow. */
export function triggers(wf: Workflow): Record<string, unknown> {
  // YAML 1.1 treats `on` as a boolean; @std/yaml uses YAML 1.2 and keeps
  // it as the string `on`. Accept both for safety.
  return (wf.on ?? wf["true"] ?? wf[true as unknown as string]) as Record<string, unknown>;
}

/** Path (relative to the repository root) of the verified-download helper. */
export const INSTALL_VERIFIED_TOOL = ".github/scripts/install_verified_tool.sh";

/** A single `run:` body plus a human-readable location. */
export interface RunStep {
  location: string;
  run: string;
  /** The step's explicit `shell:`, when it declares one. */
  shell?: string;
}

/** Every `run:` body in a workflow's jobs or in a composite action's steps. */
export function runSteps(doc: Workflow): RunStep[] {
  const steps: RunStep[] = [];
  const collect = (raw: unknown, label: (name: string) => string) => {
    for (const step of (raw ?? []) as Array<Record<string, unknown>>) {
      const run = step.run as string | undefined;
      if (!run) continue;
      const shell = step.shell as string | undefined;
      steps.push({ location: label(String(step.name ?? "unnamed")), run, shell });
    }
  };

  const jobs = (doc?.jobs ?? {}) as Record<string, { steps?: unknown }>;
  for (const [jobKey, job] of Object.entries(jobs)) {
    collect(job?.steps, (name) => `job '${jobKey}' step '${name}'`);
  }
  collect(doc?.runs?.steps, (name) => `composite step '${name}'`);
  return steps;
}

/**
 * The `run:` steps that pull an executable over the network without proving
 * which bytes arrived (Issue #748). Pinning an upstream *version* is not
 * enough: a release asset can be deleted and re-uploaded under the same tag,
 * so every download must go through `install_verified_tool.sh` with a pinned
 * 64-character SHA-256 digest.
 */
export function unverifiedDownloads(doc: Workflow): string[] {
  const digestPattern = /\b[0-9a-f]{64}\b/;
  return runSteps(doc)
    .filter(({ run }) => /\b(curl|wget)\b/.test(run))
    .filter(({ run }) => !(run.includes(INSTALL_VERIFIED_TOOL) && digestPattern.test(run)))
    .map(({ location }) => location);
}

/** The strict-mode preamble every multi-line `run:` block must open with. */
export const STRICT_MODE_PREAMBLE = "set -euo pipefail";

/** Shells the strict-mode policy applies to; anything else (pwsh, python) is exempt. */
const POSIX_SHELLS = /^(bash|sh)\b/;

/**
 * The multi-line `run:` blocks that do not open with `set -euo pipefail`
 * (Issue #750). GitHub's default shell is `bash -e {0}` — `errexit` only —
 * so without the preamble an unset variable expands to an empty string and a
 * failure mid-pipeline is masked by the exit status of the last command. That
 * turns a fault into a green step: `deno-security-update.yml` once dropped
 * `-e` and a failed `echo … >> "$GITHUB_OUTPUT"` would have left the advisory
 * gate empty, silently skipping the patch while the run reported success.
 *
 * Single-line blocks are exempt — the default `-e` already propagates the sole
 * command's exit status.
 */
export function missingStrictMode(doc: Workflow): string[] {
  return runSteps(doc)
    .filter(({ shell }) => shell === undefined || POSIX_SHELLS.test(shell))
    .filter(({ run }) => run.trimEnd().includes("\n"))
    .filter(({ run }) => run.split("\n")[0].trim() !== STRICT_MODE_PREAMBLE)
    .map(({ location }) => location);
}

/** A single `uses:` reference plus a human-readable location. */
export interface UsesRef {
  location: string;
  uses: string;
}

/** Every `uses:` in a workflow's jobs or in a composite action's steps. */
export function usesRefs(doc: Workflow): UsesRef[] {
  const refs: UsesRef[] = [];
  const collect = (steps: unknown, label: (name: string) => string) => {
    for (const step of (steps ?? []) as Array<Record<string, unknown>>) {
      const uses = step.uses as string | undefined;
      if (uses) refs.push({ location: label(String(step.name ?? uses)), uses });
    }
  };

  const jobs = (doc?.jobs ?? {}) as Record<string, { steps?: unknown }>;
  for (const [jobKey, job] of Object.entries(jobs)) {
    collect(job?.steps, (name) => `job '${jobKey}' step '${name}'`);
  }
  collect(doc?.runs?.steps, (name) => `composite step '${name}'`);
  return refs;
}

/**
 * The `uses:` references that breach the supply-chain pin policy: every
 * third-party action must name an immutable 40-character commit SHA.
 * Local (`./…`) composite actions are exempt — they wrap already-trusted
 * in-repo code, and the actions they wrap are checked in their own right
 * (Issue #682).
 */
export function unpinnedUses(doc: Workflow): string[] {
  const shaPattern = /@[0-9a-f]{40}\b/;
  return usesRefs(doc)
    .filter(({ uses }) => !uses.startsWith("./") && !shaPattern.test(uses))
    .map(({ location, uses }) => `${location} uses '${uses}'`);
}

/**
 * npm commands that can execute a package's `preinstall` / `install` /
 * `postinstall` lifecycle scripts. `npm install`, its `i` / `add` aliases,
 * `npm ci`, and the `npx` / `npm exec` package runners all do.
 */
const NPM_LIFECYCLE_COMMAND = /(^|[;&|(]\s*|\s)(npm\s+(install|i|add|ci|exec)\b|npx\b)/;

/** The flag that stops npm running any lifecycle script during an install. */
export const IGNORE_SCRIPTS_FLAG = "--ignore-scripts";

/**
 * Splits a `run:` body into logical lines, joining trailing-backslash
 * continuations so a flag on the second physical line still counts.
 */
function logicalLines(run: string): string[] {
  return run.replace(/\\\r?\n\s*/g, " ").split("\n");
}

/**
 * The `run:` commands that install or execute an npm package without
 * `--ignore-scripts` (Issue #849).
 *
 * A version pin fixes which release of the named package is fetched, but npm
 * still runs whatever `preinstall` / `install` / `postinstall` scripts that
 * package — or any of its unpinned transitive dependencies — declares. A
 * compromised dependency therefore gets arbitrary code execution on the runner
 * for every pull request. `--ignore-scripts` closes that path; it is passed on
 * the command line rather than via a repository `.npmrc` because an `.npmrc`
 * is a hidden file this repository does not commit, and a per-command flag is
 * visible at the point of use.
 */
export function npmInstallsRunningLifecycleScripts(doc: Workflow): string[] {
  const offenders: string[] = [];
  for (const { location, run } of runSteps(doc)) {
    for (const line of logicalLines(run)) {
      if (!NPM_LIFECYCLE_COMMAND.test(line)) continue;
      if (line.includes(IGNORE_SCRIPTS_FLAG)) continue;
      offenders.push(location);
      break;
    }
  }
  return offenders;
}

/** The path-classification job that per-job CI gating depends on (Issue #888). */
export const CHANGES_JOB = "changes";

/** The local composite action every `changes` job must classify with. */
export const DETECT_CHANGES_ACTION = "./.github/actions/detect-changes";

/** Every `needs.changes.outputs.<name>` reference, with what follows it. */
const CHANGES_OUTPUT_REF = new RegExp(
  `needs\\.${CHANGES_JOB}\\.outputs\\.([A-Za-z0-9_-]+)(\\s*(?:==|!=)\\s*(?:'[^']*'|[^\\s)}]+))?`,
  "g",
);

/** A comparison written the other way round, e.g. `'true' == needs.changes…`. */
const REVERSED_CHANGES_COMPARISON = new RegExp(
  `(?:==|!=)\\s*needs\\.${CHANGES_JOB}\\.outputs\\.[A-Za-z0-9_-]+`,
  "g",
);

/**
 * A `changes` output tested with no comparison at all — bare truthiness,
 * `contains(…)`, `fromJSON(…)`. Reversed comparisons are excluded here
 * because {@link REVERSED_CHANGES_COMPARISON} already reports them.
 */
const UNCOMPARED_CHANGES_REF = new RegExp(
  `(?<!(?:==|!=)\\s*)needs\\.${CHANGES_JOB}\\.outputs\\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-]|\\s*(?:==|!=))`,
  "g",
);

/** The only comparison a `changes` output may take: a positive "skip" verdict. */
const FAIL_SAFE_COMPARISON = /^\s*!=\s*'false'$/;

/**
 * The fail-safe gate contract for every job that `needs:` the `changes`
 * classifier (Issue #888), returned as human-readable violations.
 *
 * A job skipped by `if:` reports success, so it satisfies a required status
 * check. The skip must therefore need a positive `'false'` verdict:
 *
 * - The job's `if:` must include `!cancelled()` (or `always()`). Without it
 *   the implicit `success()` skips the job whenever `changes` fails — a
 *   checkout flake would turn a required check green without running it.
 * - Every comparison against a `changes` output — in the job `if:`, a step
 *   `if:`, or an expression anywhere in the job — must be `!= 'false'`.
 *   `== 'true'` (or any other form) skips the work when the output is empty
 *   because `changes` failed. In a job or step `if:` the output must be
 *   compared at all: a bare truthy reference, `contains(…)` or `fromJSON(…)`
 *   is falsy on an empty output and skips the work the same way.
 * - Every referenced output must be one the `changes` job declares; a typo
 *   reads as empty and silently disables the skip, or worse, a later
 *   rewrite to `== 'true'` would skip the job for ever.
 * - The `changes` job itself must classify with the shared composite action
 *   from a `fetch-depth: 2` checkout, so the merge commit's first parent is
 *   the base branch tip.
 */
export function changesGateViolations(doc: Workflow): string[] {
  const jobs = (doc?.jobs ?? {}) as Record<string, Record<string, unknown>>;
  const violations: string[] = [];
  const gated = Object.entries(jobs).filter(([, job]) => {
    const needs = job?.needs === undefined ? [] : [job.needs].flat();
    return needs.includes(CHANGES_JOB);
  });
  if (gated.length === 0) return violations;

  const changes = jobs[CHANGES_JOB];
  if (!changes) {
    return [`jobs 'needs: ${CHANGES_JOB}' but no '${CHANGES_JOB}' job is defined`];
  }
  const declared = Object.keys((changes.outputs ?? {}) as Record<string, unknown>);

  for (const [key, job] of gated) {
    const condition = String(job.if ?? "");
    if (!condition.includes("!cancelled()") && !condition.includes("always()")) {
      violations.push(
        `job '${key}' 'if:' must include '!cancelled()' so a failed '${CHANGES_JOB}' still runs it (got '${condition}')`,
      );
    }
    const body = JSON.stringify(job);
    for (const match of body.matchAll(CHANGES_OUTPUT_REF)) {
      const [, name, comparison] = match;
      const ref = `needs.${CHANGES_JOB}.outputs.${name}`;
      if (!declared.includes(name)) {
        violations.push(`job '${key}' reads undeclared output '${ref}'`);
      }
      if (comparison !== undefined && !FAIL_SAFE_COMPARISON.test(comparison)) {
        violations.push(
          `job '${key}' compares ${ref}${comparison}; a '${CHANGES_JOB}' output may only be compared with "!= 'false'"`,
        );
      }
    }
    for (const [reversed] of body.matchAll(REVERSED_CHANGES_COMPARISON)) {
      violations.push(
        `job '${key}' compares ${reversed.trim()}; put the '${CHANGES_JOB}' output first and compare with "!= 'false'"`,
      );
    }
    // A condition decides whether work runs, so it must spell out the
    // fail-safe comparison. Pass-throughs (step `env:`, `with:`) may still
    // read an output bare, as the aggregate's `CODE_CHANGED` does.
    const steps = (job.steps ?? []) as Array<Record<string, unknown>>;
    const conditions = [job.if, ...steps.map((step) => step?.if)]
      .filter((condition) => condition !== undefined).map(String);
    for (const condition of conditions) {
      for (const [ref] of condition.matchAll(UNCOMPARED_CHANGES_REF)) {
        violations.push(
          `job '${key}' tests ${ref} without "!= 'false'"; an empty output from a failed '${CHANGES_JOB}' job would skip it`,
        );
      }
    }
  }

  const steps = (changes.steps ?? []) as Array<Record<string, unknown>>;
  if (!steps.some((step) => step.uses === DETECT_CHANGES_ACTION)) {
    violations.push(`job '${CHANGES_JOB}' must classify with '${DETECT_CHANGES_ACTION}'`);
  }
  const checkout = steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  const withBlock = (checkout?.with ?? {}) as Record<string, unknown>;
  if (Number(withBlock["fetch-depth"]) !== 2) {
    violations.push(`job '${CHANGES_JOB}' must check out with 'fetch-depth: 2'`);
  }
  if (withBlock["persist-credentials"] !== false) {
    violations.push(`job '${CHANGES_JOB}' must check out with 'persist-credentials: false'`);
  }
  return violations;
}
