/**
 * Quarantine-aware updater for `deno.json` import pins (Issue #441).
 *
 * This module replaces a bare `deno update --latest` invocation with a
 * supply-chain-aware bump that:
 *
 * - Queries the registry (JSR or npm) for each pinned import's publish
 *   timestamps.
 * - Refuses to bump an external pin to a version younger than
 *   `VIBE_BUMP_QUARANTINE_HOURS` hours (default 24h). This gives defenders a
 *   window to spot and report a malicious publish before any repo merges it.
 * - Allows internal `@stsoftware/*` packages to bump immediately — internal
 *   NEAT-AI / tags releases are expected to land without delay per the
 *   project supply-chain policy.
 * - Skips yanked versions.
 * - Never downgrades — only forward bumps land.
 *
 * The picked target versions are written back into `deno.json`. The caller
 * (`bump-deps.sh`) refreshes the lockfile afterwards.
 *
 * Usage:
 *
 *   deno run --allow-read --allow-write --allow-net=jsr.io,npm.jsr.io,registry.npmjs.org \
 *     bump_deps.ts [--config deno.json] [--quarantine-hours 24] [--dry-run]
 *
 * Exit codes:
 *   0 — completed (with or without any pin changes)
 *   1 — usage error or unrecoverable registry error
 */

/** Default quarantine window for external packages (hours). */
export const DEFAULT_QUARANTINE_HOURS = 24;

/**
 * Internal scope prefixes. Imports whose package name starts with one of
 * these (case-insensitive) bypass the quarantine window.
 */
export const INTERNAL_SCOPE_PREFIXES = ["@stsoftware/", "@stsoftwareau/"];

/** A parsed `jsr:` or `npm:` import specifier. */
export interface ImportInfo {
  /** Import-map key, e.g. `@std/cli`. */
  readonly key: string;
  /** Raw specifier from `deno.json`, e.g. `jsr:@std/cli@1.0.29`. */
  readonly raw: string;
  /** Registry protocol. */
  readonly protocol: "jsr" | "npm";
  /** Package name without the version, e.g. `@std/cli`. */
  readonly packageName: string;
  /** Pinned version, e.g. `1.0.29`. */
  readonly version: string;
  /** Optional subpath suffix, e.g. `/mock` (empty string if none). */
  readonly subpath: string;
}

/** A single version returned by a registry, with its publish time. */
export interface VersionInfo {
  readonly version: string;
  readonly publishedAt: Date;
  readonly yanked: boolean;
}

/**
 * Parse a `jsr:` or `npm:` specifier into its components. Returns `null`
 * for any other scheme (the caller should leave those imports untouched).
 *
 * Supported forms:
 *   - `jsr:@scope/name@1.2.3`
 *   - `jsr:@scope/name@1.2.3/subpath`
 *   - `npm:package@1.2.3`
 *   - `npm:@scope/name@1.2.3`
 */
export function parseSpecifier(key: string, raw: string): ImportInfo | null {
  let protocol: "jsr" | "npm";
  let rest: string;
  if (raw.startsWith("jsr:")) {
    protocol = "jsr";
    rest = raw.slice("jsr:".length);
  } else if (raw.startsWith("npm:")) {
    protocol = "npm";
    rest = raw.slice("npm:".length);
  } else {
    return null;
  }

  // Pull the optional leading `@scope/` off so the next `@` we find marks
  // the version separator and not the scope's leading `@`.
  let scope = "";
  if (rest.startsWith("@")) {
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    scope = rest.slice(0, slash + 1);
    rest = rest.slice(slash + 1);
  }

  const at = rest.indexOf("@");
  if (at === -1) return null;
  const namePart = rest.slice(0, at);
  const afterAt = rest.slice(at + 1);

  const slashIdx = afterAt.indexOf("/");
  const version = slashIdx === -1 ? afterAt : afterAt.slice(0, slashIdx);
  const subpath = slashIdx === -1 ? "" : afterAt.slice(slashIdx);

  if (!version) return null;

  const packageName = `${scope}${namePart}`;
  return { key, raw, protocol, packageName, version, subpath };
}

/** True if `packageName` belongs to an internal stSoftware scope. */
export function isInternalPackage(packageName: string): boolean {
  const lower = packageName.toLowerCase();
  return INTERNAL_SCOPE_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Compare two `MAJOR.MINOR.PATCH` versions. Returns a negative number when
 * `a < b`, positive when `a > b`, zero when equal. Versions with non-numeric
 * components (e.g. pre-release tags) sort lower than the bare numeric form
 * and are treated as untargetable by {@link pickTargetVersion}.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i] ?? "0");
    const nb = Number(pb[i] ?? "0");
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      // Fall back to string comparison for prerelease-tagged segments.
      const sa = pa[i] ?? "";
      const sb = pb[i] ?? "";
      if (sa === sb) continue;
      return sa < sb ? -1 : 1;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** True if every dotted component of `version` parses as a non-negative integer. */
export function isPlainSemver(version: string): boolean {
  if (!version) return false;
  return version.split(".").every((part) => /^\d+$/.test(part));
}

/**
 * Pick the highest version this updater is willing to bump to.
 *
 * Filters:
 *   - Skip yanked versions.
 *   - Skip versions <= currentVersion (never downgrade or no-op-bump).
 *   - Skip versions younger than `quarantineMs` when `enforceQuarantine` is
 *     true (i.e. for external packages).
 *   - Skip versions that are not plain numeric semver (no pre-release tags).
 *
 * Returns the chosen version or `null` if no candidate qualifies.
 */
export function pickTargetVersion(
  versions: readonly VersionInfo[],
  currentVersion: string,
  now: Date,
  quarantineMs: number,
  enforceQuarantine: boolean,
): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (v.yanked) continue;
    if (!isPlainSemver(v.version)) continue;
    if (compareVersions(v.version, currentVersion) <= 0) continue;
    if (enforceQuarantine) {
      const ageMs = now.getTime() - v.publishedAt.getTime();
      if (ageMs < quarantineMs) continue;
    }
    if (best === null || compareVersions(v.version, best) > 0) {
      best = v.version;
    }
  }
  return best;
}

/** A `fetch`-shaped function — injected so unit tests stay offline. */
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Build the registry metadata URL for a given import.
 *
 * - JSR uses its npm-compatible mirror at `npm.jsr.io` because that endpoint
 *   exposes a `time` map of per-version publish timestamps in the same
 *   shape as `registry.npmjs.org`.
 * - npm imports go straight to `registry.npmjs.org`.
 */
export function registryUrl(info: ImportInfo): string {
  if (info.protocol === "jsr") {
    // `@scope/name` becomes `@jsr/scope__name` on the npm.jsr.io mirror.
    if (!info.packageName.startsWith("@")) {
      throw new Error(`jsr: imports must be scoped: ${info.packageName}`);
    }
    const slash = info.packageName.indexOf("/");
    const scope = info.packageName.slice(1, slash);
    const name = info.packageName.slice(slash + 1);
    return `https://npm.jsr.io/@jsr/${encodeURIComponent(scope)}__${encodeURIComponent(name)}`;
  }
  return `https://registry.npmjs.org/${info.packageName}`;
}

/**
 * Build the native JSR metadata URL for a JSR import.
 *
 * `deno install` resolves `jsr:` specifiers against this endpoint, not the
 * `npm.jsr.io` mirror used for publish timestamps. The two can lag each
 * other: a freshly-published release may appear on the npm mirror minutes
 * before the native `meta.json` lists it. Bumping a pin to a version the
 * native registry has not yet caught up on makes the subsequent lockfile
 * refresh fail with "Could not find version … that matches …" (Issue
 * #362). We cross-check candidates against this endpoint so we only ever
 * pick a version `deno` can actually resolve.
 */
export function jsrMetaUrl(info: ImportInfo): string {
  if (info.protocol !== "jsr") {
    throw new Error(`jsrMetaUrl called for non-jsr import: ${info.raw}`);
  }
  if (!info.packageName.startsWith("@")) {
    throw new Error(`jsr: imports must be scoped: ${info.packageName}`);
  }
  return `https://jsr.io/${info.packageName}/meta.json`;
}

/** Shape of the native `jsr.io` `meta.json` payload. */
interface JsrMetadata {
  versions?: Record<string, { yanked?: boolean } | undefined>;
}

/**
 * Fetch the set of versions the native `jsr.io` registry knows about for a
 * JSR import, mapped to whether each is yanked there. This is the source
 * `deno install` resolves against, so any version absent here is not yet
 * installable regardless of what the npm mirror advertises.
 *
 * Returns `null` when the `jsr.io` lookup fails (network error or non-OK
 * response) so the caller falls back to the mirror-only candidate set
 * rather than blocking every JSR bump on a transient `jsr.io` hiccup
 * (PR #576).
 */
export async function fetchJsrAvailableVersions(
  info: ImportInfo,
  fetcher: Fetcher = fetch,
): Promise<Map<string, { yanked: boolean }> | null> {
  const url = jsrMetaUrl(info);
  let res: Response;
  try {
    res = await fetcher(url, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as JsrMetadata;
  const versions = data.versions ?? {};
  const available = new Map<string, { yanked: boolean }>();
  for (const [version, entry] of Object.entries(versions)) {
    available.set(version, { yanked: Boolean(entry?.yanked) });
  }
  return available;
}

/**
 * Shape of the npm-style package metadata returned by both
 * `registry.npmjs.org` and `npm.jsr.io`.
 */
interface NpmMetadata {
  versions?: Record<string, { deprecated?: string } | undefined>;
  time?: Record<string, string | undefined>;
}

/**
 * Fetch and parse the version list for one import. Throws on network or
 * registry error so the caller surfaces the failure rather than silently
 * keeping the stale pin.
 */
export async function fetchVersions(
  info: ImportInfo,
  fetcher: Fetcher = fetch,
): Promise<VersionInfo[]> {
  const url = registryUrl(info);
  const res = await fetcher(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry ${url} returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as NpmMetadata;
  const versions = data.versions ?? {};
  const time = data.time ?? {};

  // For JSR imports, cross-check against the native `jsr.io` registry — the
  // source `deno install` resolves against. The npm.jsr.io mirror can
  // advertise a release before the native registry lists it, and picking
  // such a version makes the lockfile refresh fail (Issue #362). A version
  // absent from (or yanked in) the native registry is treated as
  // untargetable here.
  let jsrAvailable: Map<string, { yanked: boolean }> | null = null;
  if (info.protocol === "jsr") {
    jsrAvailable = await fetchJsrAvailableVersions(info, fetcher);
  }

  const result: VersionInfo[] = [];
  for (const [version, entry] of Object.entries(versions)) {
    if (version === "modified" || version === "created") continue;
    const publishedRaw = time[version];
    if (!publishedRaw) {
      // Without a publish timestamp we cannot judge quarantine — treat as
      // yanked so it is skipped.
      result.push({ version, publishedAt: new Date(0), yanked: true });
      continue;
    }
    const publishedAt = new Date(publishedRaw);
    if (Number.isNaN(publishedAt.getTime())) {
      result.push({ version, publishedAt: new Date(0), yanked: true });
      continue;
    }
    // A version the native jsr.io registry has not yet caught up on (or has
    // yanked) is not installable — skip it so `deno install` can resolve the
    // pin we land on.
    const jsrEntry = jsrAvailable?.get(version);
    const unavailableOnJsr = jsrAvailable !== null && (jsrEntry === undefined || jsrEntry.yanked);
    const yanked = Boolean(entry?.deprecated) || unavailableOnJsr;
    result.push({ version, publishedAt, yanked });
  }
  return result;
}

/** Outcome of evaluating one import against the registry. */
export interface BumpDecision {
  readonly info: ImportInfo;
  readonly internal: boolean;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly bumped: boolean;
  /** Diagnostic note describing why no bump was selected. */
  readonly note?: string;
}

/** Options for {@link decideBumps}. */
export interface DecideBumpsOptions {
  readonly imports: Readonly<Record<string, string>>;
  readonly quarantineHours: number;
  readonly now?: Date;
  readonly fetcher?: Fetcher;
}

/**
 * Evaluate every `jsr:` / `npm:` import in the supplied map and return
 * a {@link BumpDecision} per parseable specifier. Unsupported scheme
 * imports (e.g. `https:`) are silently skipped.
 */
export async function decideBumps(opts: DecideBumpsOptions): Promise<BumpDecision[]> {
  const now = opts.now ?? new Date();
  const quarantineMs = opts.quarantineHours * 60 * 60 * 1000;
  const fetcher = opts.fetcher ?? fetch;
  const decisions: BumpDecision[] = [];
  for (const [key, raw] of Object.entries(opts.imports)) {
    const info = parseSpecifier(key, raw);
    if (!info) continue;
    const internal = isInternalPackage(info.packageName);
    let versions: VersionInfo[];
    try {
      // `fetchVersions` already cross-checks JSR candidates against the
      // authoritative `jsr.io` registry (versions absent there — or yanked —
      // are flagged so `pickTargetVersion` skips them), so a bump never
      // writes a pin `deno install` cannot resolve (Issue #362).
      versions = await fetchVersions(info, fetcher);
    } catch (err) {
      decisions.push({
        info,
        internal,
        currentVersion: info.version,
        targetVersion: info.version,
        bumped: false,
        note: `registry lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const target = pickTargetVersion(versions, info.version, now, quarantineMs, !internal);
    if (target === null) {
      decisions.push({
        info,
        internal,
        currentVersion: info.version,
        targetVersion: info.version,
        bumped: false,
        note: internal
          ? "no newer version available"
          : `no newer version older than ${opts.quarantineHours}h quarantine`,
      });
      continue;
    }
    decisions.push({
      info,
      internal,
      currentVersion: info.version,
      targetVersion: target,
      bumped: true,
    });
  }
  return decisions;
}

/**
 * Apply the resolved bumps to an import map, returning a new map. The
 * input map is not mutated.
 */
export function applyBumps(
  imports: Readonly<Record<string, string>>,
  decisions: readonly BumpDecision[],
): Record<string, string> {
  const next: Record<string, string> = { ...imports };
  for (const d of decisions) {
    if (!d.bumped) continue;
    const { protocol, packageName, subpath } = d.info;
    next[d.info.key] = `${protocol}:${packageName}@${d.targetVersion}${subpath}`;
  }
  return next;
}

/**
 * Top-level entry point. Reads `configPath`, decides bumps, optionally
 * writes the updated `imports` map back, and returns the decisions for
 * logging by the caller.
 */
export async function bumpDenoConfig(opts: {
  configPath: string;
  quarantineHours: number;
  dryRun?: boolean;
  now?: Date;
  fetcher?: Fetcher;
}): Promise<{ decisions: BumpDecision[]; changed: boolean }> {
  const raw = await Deno.readTextFile(opts.configPath);
  const config = JSON.parse(raw) as { imports?: Record<string, string> };
  const imports = config.imports ?? {};
  const decisions = await decideBumps({
    imports,
    quarantineHours: opts.quarantineHours,
    now: opts.now,
    fetcher: opts.fetcher,
  });
  const next = applyBumps(imports, decisions);
  const changed = JSON.stringify(next) !== JSON.stringify(imports);
  if (changed && !opts.dryRun) {
    config.imports = next;
    // Preserve trailing newline if the source had one — deno fmt rewrites
    // the file later anyway, but matching the existing convention avoids
    // a spurious diff on the first run.
    const trailingNewline = raw.endsWith("\n") ? "\n" : "";
    await Deno.writeTextFile(opts.configPath, JSON.stringify(config, null, 2) + trailingNewline);
  }
  return { decisions, changed };
}

/** Format a one-line summary of a decision for the CLI log. */
export function formatDecision(d: BumpDecision): string {
  const tag = d.internal ? "internal" : "external";
  if (d.bumped) {
    return `BUMP   ${d.info.key} ${d.currentVersion} → ${d.targetVersion} (${tag})`;
  }
  const reason = d.note ? ` — ${d.note}` : "";
  return `keep   ${d.info.key} @${d.currentVersion} (${tag})${reason}`;
}

function parseArgs(argv: readonly string[]): {
  configPath: string;
  quarantineHours: number;
  dryRun: boolean;
} {
  let configPath = "deno.json";
  const envHours = Deno.env.get("VIBE_BUMP_QUARANTINE_HOURS");
  let quarantineHours = envHours ? Number(envHours) : DEFAULT_QUARANTINE_HOURS;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      configPath = argv[++i] ?? "deno.json";
    } else if (a === "--quarantine-hours") {
      quarantineHours = Number(argv[++i]);
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: deno run --allow-read --allow-write --allow-net --allow-env bump_deps.ts " +
          "[--config deno.json] [--quarantine-hours 24] [--dry-run]",
      );
      Deno.exit(0);
    } else {
      console.error(`bump_deps: unknown argument: ${a}`);
      Deno.exit(1);
    }
  }
  if (!Number.isFinite(quarantineHours) || quarantineHours < 0) {
    console.error(`bump_deps: invalid quarantine hours: ${quarantineHours}`);
    Deno.exit(1);
  }
  return { configPath, quarantineHours, dryRun };
}

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const { decisions, changed } = await bumpDenoConfig(args);
  for (const d of decisions) {
    console.log(formatDecision(d));
  }
  if (changed) {
    console.log(
      args.dryRun
        ? "bump_deps: changes pending (--dry-run, deno.json untouched)"
        : "bump_deps: deno.json updated",
    );
  } else {
    console.log("bump_deps: no changes");
  }
}
