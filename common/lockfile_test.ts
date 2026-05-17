// Regression tests for issue #418: deno.lock must be tracked in git and
// must stay consistent with the pins in deno.json so CI can run with
// `--frozen` and reject silent transitive bumps.
//
// These are behavioural ("what") tests — they assert on the actual
// contents of the committed deno.lock and deno.json, not on whether any
// particular source file mentions `--frozen`.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

Deno.test("deno.lock exists at the repository root", async () => {
  const stat = await Deno.stat(`${REPO_ROOT}deno.lock`);
  assert(stat.isFile, "deno.lock must be a regular file");
  assert(stat.size > 0, "deno.lock must not be empty");
});

Deno.test("deno.lock is not gitignored", async () => {
  const gitignore = await Deno.readTextFile(`${REPO_ROOT}.gitignore`);
  // The `.*` pattern would catch hidden files, but `deno.lock` is not
  // hidden. The only way it ends up ignored is an explicit `deno.lock`
  // entry, which this test guards against.
  const lines = gitignore.split("\n").map((line) => line.trim());
  const hasIgnoreEntry = lines.some((line) => line === "deno.lock" || line === "/deno.lock");
  assert(
    !hasIgnoreEntry,
    "deno.lock must not appear as an active .gitignore entry " +
      "(see issue #418)",
  );
});

Deno.test("every deno.json pin is resolved to the same version in deno.lock", async () => {
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${REPO_ROOT}deno.json`),
  ) as { imports: Record<string, string> };
  const denoLock = JSON.parse(
    await Deno.readTextFile(`${REPO_ROOT}deno.lock`),
  ) as { specifiers: Record<string, string> };

  for (const [, specifier] of Object.entries(denoJson.imports)) {
    // Only check pinned jsr: specifiers (the only kind used in this
    // repo today). The format is "jsr:<scope>/<name>@<version>" or
    // "jsr:<scope>/<name>@<version>/<subpath>".
    if (!specifier.startsWith("jsr:")) continue;
    const match = specifier.match(/^(jsr:[^/]+\/[^@]+@[^/]+)/);
    assert(match, `Unable to parse JSR specifier: ${specifier}`);
    const base = match[1];
    const version = base.split("@").pop()!;
    const resolved = denoLock.specifiers[base];
    assert(
      resolved !== undefined,
      `deno.lock has no entry for ${base} — run \`deno install\` and ` +
        "commit the updated deno.lock (issue #418)",
    );
    assertEquals(
      resolved,
      version,
      `deno.lock resolves ${base} to ${resolved}, but deno.json pins ` +
        `it to ${version} — run \`deno install\` and commit the updated ` +
        "deno.lock (issue #418)",
    );
  }
});
