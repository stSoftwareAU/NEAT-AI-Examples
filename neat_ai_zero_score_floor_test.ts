import { assert } from "@std/assert";

/**
 * `@stsoftware/neat-ai@5.9.43` guarded `FindTunePopulation.make`'s score
 * comparisons with a truthiness test, so a population member with a
 * legitimate score of exactly `0` was rejected as
 * `ValidationError: Creature <uuid> has invalid score`.
 *
 * `adaptive_mutation` configures `costOfGrowth: 0`, making the score
 * `1 - error`; an error of exactly `1` therefore yields exactly `0` and
 * aborted the whole run deterministically (issues #699, #702).
 *
 * The upstream fix (stSoftwareAU/NEAT-AI#3507) shipped in `5.10.1`. This
 * floor stops a future bump — or a hand-edit of the pin — from silently
 * dropping the repo back onto a release that cannot run
 * `adaptive_mutation`.
 *
 * These are "what" tests: the pinned dependency set is the deliverable,
 * so they parse `deno.json` / `deno.lock` and assert on the resolved
 * version rather than grepping source text.
 */

/** First `@stsoftware/neat-ai` release carrying the zero-score fix. */
const ZERO_SCORE_FIX_VERSION = "5.10.1";

const DENO_CONFIG_PATH = "deno.json";
const DENO_LOCK_PATH = "deno.lock";

/** Parse a bare `major.minor.patch` string into its numeric parts. */
function parseVersion(version: string): number[] {
  const parts = version.split(".").map(Number);
  assert(
    parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0),
    `Expected a "major.minor.patch" version, got "${version}"`,
  );
  return parts;
}

/** Negative when `a` precedes `b`, zero when equal, positive when `a` follows `b`. */
function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** The version `deno.json` pins `@stsoftware/neat-ai` to. */
function pinnedVersion(): string {
  const config = JSON.parse(Deno.readTextFileSync(DENO_CONFIG_PATH));
  const specifier: string | undefined = config.imports?.["@stsoftware/neat-ai"];
  assert(
    typeof specifier === "string",
    `deno.json "imports" must pin "@stsoftware/neat-ai"`,
  );
  const match = specifier.match(/^jsr:@stsoftware\/neat-ai@(\d+\.\d+\.\d+)$/);
  assert(
    match,
    `Expected an exact JSR pin like "jsr:@stsoftware/neat-ai@6.0.3", ` +
      `got "${specifier}"`,
  );
  return match[1];
}

/** Every `@stsoftware/neat-ai` version `deno.lock` resolves a specifier to. */
function lockedVersions(): string[] {
  const lock = JSON.parse(Deno.readTextFileSync(DENO_LOCK_PATH));
  const specifiers: Record<string, string> = lock.specifiers ?? {};
  return Object.entries(specifiers)
    .filter(([specifier]) => specifier.startsWith("jsr:@stsoftware/neat-ai@"))
    .map(([, resolved]) => resolved);
}

Deno.test("deno.json pins @stsoftware/neat-ai at or above the zero-score fix", () => {
  const pinned = pinnedVersion();
  assert(
    compareVersions(pinned, ZERO_SCORE_FIX_VERSION) >= 0,
    `deno.json pins @stsoftware/neat-ai@${pinned}, which predates ` +
      `${ZERO_SCORE_FIX_VERSION} — the release that stopped ` +
      `FineTunePopulation rejecting a legitimate score of 0. ` +
      `adaptive_mutation fails deterministically on older releases (#702).`,
  );
});

Deno.test("deno.lock resolves @stsoftware/neat-ai at or above the zero-score fix", () => {
  const resolved = lockedVersions();
  assert(
    resolved.length > 0,
    `deno.lock must resolve at least one "jsr:@stsoftware/neat-ai@" specifier`,
  );

  for (const version of resolved) {
    assert(
      compareVersions(version, ZERO_SCORE_FIX_VERSION) >= 0,
      `deno.lock resolves @stsoftware/neat-ai to ${version}, which predates ` +
        `${ZERO_SCORE_FIX_VERSION} — the release carrying the zero-score fix. ` +
        `Re-run ./bump-deps.sh so the lockfile matches the deno.json pin.`,
    );
  }
});
