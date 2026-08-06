// Tests for .github/scripts/install_verified_tool.sh (Issue #748).
//
// Both the actionlint and gitleaks workflows used to fetch a release
// tarball and execute the extracted binary without checking a single
// byte. A GitHub release asset is not immutable — a compromised upstream
// account can delete and re-upload an asset under an existing tag — so a
// version pin constrains *which release* is fetched but says nothing
// about *what bytes* arrive.
//
// These are "what" tests: they run the real script against real tarballs
// built in a temp directory and assert on exit codes and side effects
// (was the binary extracted or not), never on the script's source text.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT = new URL("./scripts/install_verified_tool.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the installer under `bash` (the only shell the test sandbox allows). */
async function install(args: string[], cwd: string): Promise<RunResult> {
  const command = new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Runs a plain `bash -c` helper, failing loudly if it does not succeed. */
async function bash(script: string, cwd: string): Promise<void> {
  const { code, stderr } = await new Deno.Command("bash", {
    args: ["-c", script],
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(code, 0, `helper failed: ${new TextDecoder().decode(stderr)}`);
}

async function sha256Of(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Builds `tool.tar.gz` in `dir` containing an executable `payload` binary
 * that prints `marker`, and returns the tarball's real SHA-256.
 */
async function buildTarball(dir: string, marker: string): Promise<string> {
  await Deno.writeTextFile(`${dir}/payload`, `#!/bin/bash\necho "${marker}"\n`);
  await bash("chmod +x payload && tar -czf tool.tar.gz payload && rm payload", dir);
  return await sha256Of(`${dir}/tool.tar.gz`);
}

/** A `file://` URL curl can fetch, so no test touches the network. */
function fileUrl(dir: string): string {
  return `file://${dir}/tool.tar.gz`;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "install-verified-tool-" });
  try {
    await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("installer — extracts an executable binary when the digest matches", async () => {
  await withTempDir(async (dir) => {
    const digest = await buildTarball(dir, "genuine-tool");
    const result = await install([fileUrl(dir), digest, "payload"], dir);

    assertEquals(result.code, 0, `installer must succeed, stderr: ${result.stderr}`);
    const stat = await Deno.stat(`${dir}/payload`);
    assert(stat.isFile, "the verified binary must be extracted into the destination");
    assert((stat.mode ?? 0) & 0o111, "the extracted binary must be executable");

    const ran = await new Deno.Command("bash", {
      args: [`${dir}/payload`],
      stdout: "piped",
      stderr: "null",
    }).output();
    assertStringIncludes(new TextDecoder().decode(ran.stdout), "genuine-tool");
  });
});

Deno.test("installer — rejects a substituted tarball and never extracts it", async () => {
  await withTempDir(async (dir) => {
    const pinned = await buildTarball(dir, "genuine-tool");
    // Upstream re-uploads a different asset under the same release tag.
    const substituted = await buildTarball(dir, "malicious-tool");
    assert(pinned !== substituted, "the substituted tarball must hash differently");

    const result = await install([fileUrl(dir), pinned, "payload"], dir);

    assert(result.code !== 0, "a digest mismatch must fail the job, not run the binary");
    assertStringIncludes(result.stderr.toLowerCase(), "mismatch");
    await assertMissing(`${dir}/payload`, "a tampered binary must never be extracted");
  });
});

Deno.test("installer — fails loudly on a malformed or empty pinned digest", async () => {
  await withTempDir(async (dir) => {
    await buildTarball(dir, "genuine-tool");
    for (const bad of ["", "deadbeef", "not-a-digest", "8ACA8DB9".repeat(8)]) {
      const result = await install([fileUrl(dir), bad, "payload"], dir);
      assert(
        result.code !== 0,
        `'${bad}' is not a 64-character lowercase hex digest and must be rejected`,
      );
      await assertMissing(`${dir}/payload`, "nothing may be extracted for a malformed digest");
    }
  });
});

Deno.test("installer — fails when the download itself fails", async () => {
  await withTempDir(async (dir) => {
    const result = await install([
      `file://${dir}/absent.tar.gz`,
      "a".repeat(64),
      "payload",
    ], dir);
    assert(result.code !== 0, "an unreachable asset must fail the job");
    await assertMissing(`${dir}/payload`, "nothing may be extracted when the download fails");
  });
});

Deno.test("installer — rejects a binary name that escapes the destination", async () => {
  await withTempDir(async (dir) => {
    const digest = await buildTarball(dir, "genuine-tool");
    for (const name of ["../escaped", "/etc/passwd", "sub/payload"]) {
      const result = await install([fileUrl(dir), digest, name], dir);
      assert(result.code !== 0, `binary name '${name}' must be rejected`);
    }
  });
});

Deno.test("installer — reports usage instead of guessing when arguments are missing", async () => {
  await withTempDir(async (dir) => {
    const result = await install([fileUrl(dir), "a".repeat(64)], dir);
    assert(result.code !== 0, "a missing binary name must fail rather than default");
    assertStringIncludes(result.stderr.toLowerCase(), "usage");
  });
});

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`${message}: ${path} exists`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
