// Regression tests for issue #422: the repository .gitignore must cover
// common non-dot credential filenames so that contributors who run
// examples that emit or consume a config / credentials file cannot
// accidentally stage the secrets with `git add .`.
//
// These are behavioural ("what") tests: each test creates a candidate
// file inside a temporary working tree that uses the same .gitignore
// as the repository, then asks git whether the file would be ignored.
// We assert on git's actual answer — not on the text of .gitignore.

import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Candidate credential filenames that must be ignored at any depth. */
const CREDENTIAL_FILES = [
  "config.json",
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "server.pem",
  "private.key",
  "id_rsa",
  "id_rsa.pub",
  // Same filenames in a nested directory — patterns must match at any
  // depth, not only at the repository root.
  "examples/config.json",
  "examples/credentials.json",
  "deep/nested/dir/service-account.json",
  "deep/nested/dir/server.pem",
  "deep/nested/dir/private.key",
  "deep/nested/dir/id_rsa",
];

/**
 * Initialise a throwaway git repository in `dir` that uses the
 * repository .gitignore, then ask `git check-ignore` whether each
 * candidate path would be ignored. Returns the set of paths that are
 * NOT ignored.
 */
async function notIgnored(dir: string, paths: string[]): Promise<string[]> {
  // Copy the real .gitignore into the throwaway repo so we exercise the
  // exact rules contributors get on a fresh clone.
  const gitignore = await Deno.readTextFile(`${REPO_ROOT}.gitignore`);
  await Deno.writeTextFile(`${dir}/.gitignore`, gitignore);

  const init = new Deno.Command("git", {
    args: ["init", "-q", dir],
    stdout: "null",
    stderr: "null",
  });
  const initResult = await init.output();
  assert(initResult.success, "git init must succeed");

  // Create each candidate file (and its parent directories) so
  // `git check-ignore` has a real path to evaluate.
  for (const rel of paths) {
    const full = `${dir}/${rel}`;
    const slash = full.lastIndexOf("/");
    if (slash > dir.length) {
      await Deno.mkdir(full.slice(0, slash), { recursive: true });
    }
    await Deno.writeTextFile(full, "stub");
  }

  const check = new Deno.Command("git", {
    args: ["-C", dir, "check-ignore", "--no-index", "--", ...paths],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await check.output();
  const ignored = new Set(
    new TextDecoder().decode(out.stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  return paths.filter((p) => !ignored.has(p));
}

Deno.test("common credential filenames are gitignored (issue #422)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "neat_gitignore_test_" });
  try {
    const missed = await notIgnored(tmpDir, CREDENTIAL_FILES);
    assert(
      missed.length === 0,
      `These credential paths are NOT gitignored and could leak secrets ` +
        `(issue #422): ${missed.join(", ")}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("ordinary repository files are still tracked (issue #422)", async () => {
  // Make sure the credential rules do not accidentally ignore the
  // project's own source files. README.md, deno.json, etc. must remain
  // trackable.
  const tmpDir = await Deno.makeTempDir({ prefix: "neat_gitignore_test_" });
  try {
    const tracked = [
      "README.md",
      "deno.json",
      "quality.sh",
      "common/working_dirs.ts",
    ];
    const missed = await notIgnored(tmpDir, tracked);
    // For tracked files we expect ALL of them to come back as "not
    // ignored", i.e. missed === tracked.
    assert(
      missed.length === tracked.length,
      `Expected all ordinary files to remain trackable, but some are ` +
        `now ignored: ${tracked.filter((t) => !missed.includes(t)).join(", ")}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
