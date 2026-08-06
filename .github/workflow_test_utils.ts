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
}

/** Every `run:` body in a workflow's jobs or in a composite action's steps. */
export function runSteps(doc: Workflow): RunStep[] {
  const steps: RunStep[] = [];
  const collect = (raw: unknown, label: (name: string) => string) => {
    for (const step of (raw ?? []) as Array<Record<string, unknown>>) {
      const run = step.run as string | undefined;
      if (run) steps.push({ location: label(String(step.name ?? "unnamed")), run });
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
