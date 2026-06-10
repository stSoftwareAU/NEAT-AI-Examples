/**
 * Unit tests for the quarantine-aware dependency updater (Issue #441).
 *
 * These tests exercise the real exported functions against an injected
 * fetcher — no network access is required. They cover specifier parsing,
 * internal-scope classification, quarantine-age filtering, registry URL
 * shape, and the end-to-end bumpDenoConfig flow on a temp file.
 */

import { assert, assertEquals } from "@std/assert";
import {
  applyBumps,
  bumpDenoConfig,
  compareVersions,
  decideBumps,
  DEFAULT_QUARANTINE_HOURS,
  fetchJsrResolvableVersions,
  fetchVersions,
  formatDecision,
  isInternalPackage,
  isPlainSemver,
  jsrMetaUrl,
  parseSpecifier,
  pickTargetVersion,
  registryUrl,
} from "./bump_deps.ts";

Deno.test("DEFAULT_QUARANTINE_HOURS matches the policy default", () => {
  assertEquals(DEFAULT_QUARANTINE_HOURS, 24);
});

Deno.test("parseSpecifier - jsr scoped import without subpath", () => {
  const info = parseSpecifier("@std/cli", "jsr:@std/cli@1.0.29");
  assertEquals(info, {
    key: "@std/cli",
    raw: "jsr:@std/cli@1.0.29",
    protocol: "jsr",
    packageName: "@std/cli",
    version: "1.0.29",
    subpath: "",
  });
});

Deno.test("parseSpecifier - jsr scoped import with subpath", () => {
  const info = parseSpecifier("@std/testing/mock", "jsr:@std/testing@1.0.18/mock");
  assertEquals(info?.packageName, "@std/testing");
  assertEquals(info?.version, "1.0.18");
  assertEquals(info?.subpath, "/mock");
});

Deno.test("parseSpecifier - npm scoped import", () => {
  const info = parseSpecifier("@babel/core", "npm:@babel/core@7.24.0");
  assertEquals(info?.protocol, "npm");
  assertEquals(info?.packageName, "@babel/core");
  assertEquals(info?.version, "7.24.0");
});

Deno.test("parseSpecifier - npm unscoped import", () => {
  const info = parseSpecifier("typescript", "npm:typescript@5.4.0");
  assertEquals(info?.protocol, "npm");
  assertEquals(info?.packageName, "typescript");
  assertEquals(info?.version, "5.4.0");
});

Deno.test("parseSpecifier - returns null for https imports", () => {
  assertEquals(parseSpecifier("foo", "https://example.com/foo.ts"), null);
});

Deno.test("parseSpecifier - returns null when version missing", () => {
  assertEquals(parseSpecifier("@std/cli", "jsr:@std/cli"), null);
});

Deno.test("isInternalPackage - stsoftware scope is internal", () => {
  assert(isInternalPackage("@stsoftware/neat-ai"));
  assert(isInternalPackage("@stsoftware/tags"));
});

Deno.test("isInternalPackage - case-insensitive on the scope", () => {
  assert(isInternalPackage("@StSoftware/Tags"));
  assert(isInternalPackage("@stsoftwareAU/widget"));
});

Deno.test("isInternalPackage - @std and unrelated scopes are external", () => {
  assertEquals(isInternalPackage("@std/cli"), false);
  assertEquals(isInternalPackage("typescript"), false);
  assertEquals(isInternalPackage("@babel/core"), false);
});

Deno.test("compareVersions - numeric ordering", () => {
  assert(compareVersions("1.0.0", "1.0.1") < 0);
  assert(compareVersions("1.10.0", "1.9.0") > 0);
  assertEquals(compareVersions("2.0.0", "2.0.0"), 0);
});

Deno.test("isPlainSemver - rejects pre-release tags and empty strings", () => {
  assert(isPlainSemver("1.0.0"));
  assert(isPlainSemver("1.0"));
  assertEquals(isPlainSemver("1.0.0-rc.1"), false);
  assertEquals(isPlainSemver(""), false);
});

Deno.test("registryUrl - jsr packages route to the npm.jsr.io mirror", () => {
  const url = registryUrl({
    key: "@std/cli",
    raw: "jsr:@std/cli@1.0.29",
    protocol: "jsr",
    packageName: "@std/cli",
    version: "1.0.29",
    subpath: "",
  });
  assertEquals(url, "https://npm.jsr.io/@jsr/std__cli");
});

Deno.test("registryUrl - npm packages route to registry.npmjs.org", () => {
  const url = registryUrl({
    key: "typescript",
    raw: "npm:typescript@5.4.0",
    protocol: "npm",
    packageName: "typescript",
    version: "5.4.0",
    subpath: "",
  });
  assertEquals(url, "https://registry.npmjs.org/typescript");
});

const now = new Date("2026-05-20T12:00:00Z");
const ONE_HOUR = 60 * 60 * 1000;

Deno.test("pickTargetVersion - external dep skips a version younger than quarantine", () => {
  const versions = [
    { version: "1.0.0", publishedAt: new Date(now.getTime() - 72 * ONE_HOUR), yanked: false },
    { version: "1.1.0", publishedAt: new Date(now.getTime() - 1 * ONE_HOUR), yanked: false },
  ];
  const target = pickTargetVersion(versions, "1.0.0", now, 24 * ONE_HOUR, true);
  // 1.1.0 is too young (1h old); 1.0.0 is not newer than current — no bump.
  assertEquals(target, null);
});

Deno.test("pickTargetVersion - external dep picks the highest old-enough version", () => {
  const versions = [
    { version: "1.0.0", publishedAt: new Date(now.getTime() - 72 * ONE_HOUR), yanked: false },
    { version: "1.1.0", publishedAt: new Date(now.getTime() - 48 * ONE_HOUR), yanked: false },
    { version: "1.2.0", publishedAt: new Date(now.getTime() - 1 * ONE_HOUR), yanked: false },
  ];
  const target = pickTargetVersion(versions, "1.0.0", now, 24 * ONE_HOUR, true);
  assertEquals(target, "1.1.0");
});

Deno.test("pickTargetVersion - internal dep ignores the quarantine window", () => {
  const versions = [
    { version: "1.0.0", publishedAt: new Date(now.getTime() - 72 * ONE_HOUR), yanked: false },
    { version: "1.2.0", publishedAt: new Date(now.getTime() - 1 * ONE_HOUR), yanked: false },
  ];
  const target = pickTargetVersion(versions, "1.0.0", now, 24 * ONE_HOUR, false);
  assertEquals(target, "1.2.0");
});

Deno.test("pickTargetVersion - skips yanked and pre-release versions", () => {
  const versions = [
    { version: "1.0.0", publishedAt: new Date(now.getTime() - 72 * ONE_HOUR), yanked: false },
    { version: "1.1.0", publishedAt: new Date(now.getTime() - 72 * ONE_HOUR), yanked: true },
    { version: "1.2.0-rc.1", publishedAt: new Date(now.getTime() - 72 * ONE_HOUR), yanked: false },
  ];
  const target = pickTargetVersion(versions, "1.0.0", now, 24 * ONE_HOUR, true);
  assertEquals(target, null);
});

Deno.test("pickTargetVersion - never downgrades", () => {
  const versions = [
    { version: "0.9.0", publishedAt: new Date(now.getTime() - 240 * ONE_HOUR), yanked: false },
  ];
  const target = pickTargetVersion(versions, "1.0.0", now, 24 * ONE_HOUR, true);
  assertEquals(target, null);
});

/**
 * Build a `fetch`-shaped function that returns the given npm-style
 * metadata for the matching URL. Anything else throws so tests fail
 * loud rather than silently calling out to the real registry.
 */
function makeFetcher(
  map: Record<string, { versions: Record<string, unknown>; time: Record<string, string> }>,
) {
  return (input: string | URL): Promise<Response> => {
    const url = String(input);
    const body = map[url];
    if (!body) {
      return Promise.resolve(new Response(`unexpected URL ${url}`, { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

Deno.test("fetchVersions - parses npm-style metadata with publish times", async () => {
  const url = "https://npm.jsr.io/@jsr/std__cli";
  const fetcher = makeFetcher({
    [url]: {
      versions: { "1.0.0": {}, "1.1.0": { deprecated: "do not use" } },
      time: {
        "1.0.0": "2026-05-01T00:00:00Z",
        "1.1.0": "2026-05-19T00:00:00Z",
      },
    },
  });
  const out = await fetchVersions(
    {
      key: "@std/cli",
      raw: "jsr:@std/cli@0.9.0",
      protocol: "jsr",
      packageName: "@std/cli",
      version: "0.9.0",
      subpath: "",
    },
    fetcher,
  );
  assertEquals(out.length, 2);
  const v100 = out.find((v) => v.version === "1.0.0");
  const v110 = out.find((v) => v.version === "1.1.0");
  assertEquals(v100?.yanked, false);
  assertEquals(v110?.yanked, true, "deprecated versions are flagged as yanked");
  assertEquals(v100?.publishedAt.toISOString(), "2026-05-01T00:00:00.000Z");
});

Deno.test("fetchVersions - HTTP error throws", async () => {
  const fetcher = () => Promise.resolve(new Response("not found", { status: 404 }));
  let threw = false;
  try {
    await fetchVersions(
      {
        key: "@std/cli",
        raw: "jsr:@std/cli@1.0.0",
        protocol: "jsr",
        packageName: "@std/cli",
        version: "1.0.0",
        subpath: "",
      },
      fetcher,
    );
  } catch {
    threw = true;
  }
  assert(threw, "expected HTTP 404 to throw");
});

Deno.test("decideBumps - external dep gated by quarantine, internal dep bumps immediately", async () => {
  const fetcher = makeFetcher({
    "https://npm.jsr.io/@jsr/std__cli": {
      versions: { "1.0.29": {}, "1.0.30": {} },
      time: {
        // 1.0.30 published 1 hour ago — younger than the 24h window.
        "1.0.29": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
        "1.0.30": new Date(now.getTime() - 1 * ONE_HOUR).toISOString(),
      },
    },
    "https://npm.jsr.io/@jsr/stsoftware__neat-ai": {
      versions: { "5.0.28": {}, "5.0.29": {} },
      // Even though the new internal release is brand new, it should land.
      time: {
        "5.0.28": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
        "5.0.29": new Date(now.getTime() - 1 * ONE_HOUR).toISOString(),
      },
    },
  });
  const decisions = await decideBumps({
    imports: {
      "@std/cli": "jsr:@std/cli@1.0.29",
      "@stsoftware/neat-ai": "jsr:@stsoftware/neat-ai@5.0.28",
    },
    quarantineHours: 24,
    now,
    fetcher,
  });
  const stdDecision = decisions.find((d) => d.info.key === "@std/cli");
  const internalDecision = decisions.find((d) => d.info.key === "@stsoftware/neat-ai");
  assertEquals(stdDecision?.bumped, false, "external dep too young to bump");
  assertEquals(stdDecision?.internal, false);
  assertEquals(internalDecision?.bumped, true, "internal dep bumps despite young age");
  assertEquals(internalDecision?.targetVersion, "5.0.29");
});

Deno.test("decideBumps - external dep with an old-enough new release bumps", async () => {
  const fetcher = makeFetcher({
    "https://npm.jsr.io/@jsr/std__cli": {
      versions: { "1.0.29": {}, "1.0.30": {} },
      time: {
        "1.0.29": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
        // 48h old — passes the 24h gate.
        "1.0.30": new Date(now.getTime() - 48 * ONE_HOUR).toISOString(),
      },
    },
  });
  const decisions = await decideBumps({
    imports: { "@std/cli": "jsr:@std/cli@1.0.29" },
    quarantineHours: 24,
    now,
    fetcher,
  });
  assertEquals(decisions[0]?.bumped, true);
  assertEquals(decisions[0]?.targetVersion, "1.0.30");
});

Deno.test("decideBumps - registry failure is reported without crashing", async () => {
  const fetcher = () => Promise.resolve(new Response("boom", { status: 503 }));
  const decisions = await decideBumps({
    imports: { "@std/cli": "jsr:@std/cli@1.0.29" },
    quarantineHours: 24,
    now,
    fetcher,
  });
  assertEquals(decisions.length, 1);
  assertEquals(decisions[0]?.bumped, false);
  assert((decisions[0]?.note ?? "").includes("registry lookup failed"));
});

Deno.test("applyBumps - rewrites the matching entry, preserves subpath", () => {
  const imports = {
    "@std/testing/mock": "jsr:@std/testing@1.0.18/mock",
    "@std/cli": "jsr:@std/cli@1.0.29",
  };
  const decisions = [
    {
      info: parseSpecifier("@std/testing/mock", "jsr:@std/testing@1.0.18/mock")!,
      internal: false,
      currentVersion: "1.0.18",
      targetVersion: "1.0.20",
      bumped: true,
    },
  ];
  const next = applyBumps(imports, decisions);
  assertEquals(next["@std/testing/mock"], "jsr:@std/testing@1.0.20/mock");
  assertEquals(next["@std/cli"], "jsr:@std/cli@1.0.29", "untouched entries are preserved");
});

Deno.test("bumpDenoConfig - writes the new pin and reports changed=true", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/deno.json`;
  try {
    const fetcher = makeFetcher({
      "https://npm.jsr.io/@jsr/std__cli": {
        versions: { "1.0.29": {}, "1.0.40": {} },
        time: {
          "1.0.29": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
          "1.0.40": new Date(now.getTime() - 100 * ONE_HOUR).toISOString(),
        },
      },
      "https://npm.jsr.io/@jsr/stsoftware__tags": {
        versions: { "1.0.13": {}, "1.0.14": {} },
        time: {
          "1.0.13": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
          "1.0.14": new Date(now.getTime() - 1 * ONE_HOUR).toISOString(),
        },
      },
    });
    await Deno.writeTextFile(
      path,
      JSON.stringify(
        {
          imports: {
            "@std/cli": "jsr:@std/cli@1.0.29",
            "@stsoftware/tags": "jsr:@stsoftware/tags@1.0.13",
          },
        },
        null,
        2,
      ) + "\n",
    );
    const { changed, decisions } = await bumpDenoConfig({
      configPath: path,
      quarantineHours: 24,
      now,
      fetcher,
    });
    assertEquals(changed, true);
    const written = JSON.parse(await Deno.readTextFile(path));
    assertEquals(written.imports["@std/cli"], "jsr:@std/cli@1.0.40");
    assertEquals(written.imports["@stsoftware/tags"], "jsr:@stsoftware/tags@1.0.14");
    assertEquals(decisions.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bumpDenoConfig - dry-run leaves the file untouched", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/deno.json`;
  try {
    const fetcher = makeFetcher({
      "https://npm.jsr.io/@jsr/std__cli": {
        versions: { "1.0.29": {}, "1.0.40": {} },
        time: {
          "1.0.29": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
          "1.0.40": new Date(now.getTime() - 100 * ONE_HOUR).toISOString(),
        },
      },
    });
    const original = JSON.stringify(
      { imports: { "@std/cli": "jsr:@std/cli@1.0.29" } },
      null,
      2,
    ) + "\n";
    await Deno.writeTextFile(path, original);
    const { changed } = await bumpDenoConfig({
      configPath: path,
      quarantineHours: 24,
      dryRun: true,
      now,
      fetcher,
    });
    assertEquals(changed, true);
    assertEquals(await Deno.readTextFile(path), original, "dry-run must not write");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bumpDenoConfig - no changes when every pin is up to date", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/deno.json`;
  try {
    const fetcher = makeFetcher({
      "https://npm.jsr.io/@jsr/std__cli": {
        versions: { "1.0.29": {} },
        time: {
          "1.0.29": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
        },
      },
    });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ imports: { "@std/cli": "jsr:@std/cli@1.0.29" } }, null, 2) + "\n",
    );
    const { changed, decisions } = await bumpDenoConfig({
      configPath: path,
      quarantineHours: 24,
      now,
      fetcher,
    });
    assertEquals(changed, false);
    assertEquals(decisions[0]?.bumped, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("formatDecision - human-readable lines for bumped and kept pins", () => {
  const info = parseSpecifier("@std/cli", "jsr:@std/cli@1.0.29")!;
  const bumped = formatDecision({
    info,
    internal: false,
    currentVersion: "1.0.29",
    targetVersion: "1.0.30",
    bumped: true,
  });
  assert(bumped.startsWith("BUMP"));
  assert(bumped.includes("@std/cli"));
  assert(bumped.includes("(external)"));
  const kept = formatDecision({
    info,
    internal: false,
    currentVersion: "1.0.29",
    targetVersion: "1.0.29",
    bumped: false,
    note: "no newer version older than 24h quarantine",
  });
  assert(kept.startsWith("keep"));
  assert(kept.includes("24h quarantine"));
});

Deno.test("jsrMetaUrl - builds the authoritative jsr.io metadata URL", () => {
  assertEquals(
    jsrMetaUrl("@stsoftware/neat-ai"),
    "https://jsr.io/@stsoftware/neat-ai/meta.json",
  );
});

/**
 * Build a `fetch` that serves npm.jsr.io mirror metadata and jsr.io
 * authoritative metadata from two maps. Unknown URLs return HTTP 500 so a
 * stray request fails loudly rather than reaching the network.
 */
function makeDualFetcher(
  mirror: Record<string, { versions: Record<string, unknown>; time: Record<string, string> }>,
  jsrMeta: Record<string, { versions: Record<string, { yanked?: boolean }> }>,
) {
  return (input: string | URL): Promise<Response> => {
    const url = String(input);
    const body = mirror[url] ?? jsrMeta[url];
    if (!body) {
      return Promise.resolve(new Response(`unexpected URL ${url}`, { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

Deno.test("fetchJsrResolvableVersions - parses versions and excludes yanked", async () => {
  const fetcher = makeDualFetcher({}, {
    "https://jsr.io/@stsoftware/neat-ai/meta.json": {
      versions: { "5.3.18": {}, "5.3.19": {}, "5.3.17": { yanked: true } },
    },
  });
  const out = await fetchJsrResolvableVersions("@stsoftware/neat-ai", fetcher);
  assert(out !== null);
  assert(out!.has("5.3.18"));
  assert(out!.has("5.3.19"));
  assert(!out!.has("5.3.17"), "yanked versions are excluded");
});

Deno.test("fetchJsrResolvableVersions - HTTP error returns null (mirror-only fallback)", async () => {
  const fetcher = () => Promise.resolve(new Response("boom", { status: 503 }));
  const out = await fetchJsrResolvableVersions("@stsoftware/neat-ai", fetcher);
  assertEquals(out, null);
});

Deno.test("decideBumps - JSR bump is constrained to jsr.io-resolvable versions", async () => {
  // Regression for PR #576: the npm.jsr.io mirror advertised 5.3.20 (with an
  // old-enough publish time) but jsr.io only resolves up to 5.3.19, so
  // `deno install @stsoftware/neat-ai@5.3.20` failed. The bump must stop at
  // the highest version jsr.io can actually resolve.
  const fetcher = makeDualFetcher({
    "https://npm.jsr.io/@jsr/stsoftware__neat-ai": {
      versions: { "5.3.15": {}, "5.3.19": {}, "5.3.20": {} },
      time: {
        "5.3.15": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
        "5.3.19": new Date(now.getTime() - 48 * ONE_HOUR).toISOString(),
        "5.3.20": new Date(now.getTime() - 30 * ONE_HOUR).toISOString(),
      },
    },
  }, {
    "https://jsr.io/@stsoftware/neat-ai/meta.json": {
      // jsr.io has not propagated 5.3.20 yet.
      versions: { "5.3.15": {}, "5.3.19": {} },
    },
  });
  const decisions = await decideBumps({
    imports: { "@stsoftware/neat-ai": "jsr:@stsoftware/neat-ai@5.3.15" },
    quarantineHours: 24,
    now,
    fetcher,
  });
  assertEquals(decisions[0]?.bumped, true);
  assertEquals(decisions[0]?.targetVersion, "5.3.19", "must not select the unresolvable 5.3.20");
});

Deno.test("decideBumps - JSR meta lookup failure falls back to mirror candidates", async () => {
  // When jsr.io is unreachable, do not block the bump entirely — fall back
  // to the mirror-only candidate set (prior behaviour).
  const fetcher = (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url === "https://npm.jsr.io/@jsr/stsoftware__neat-ai") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            versions: { "5.3.15": {}, "5.3.19": {} },
            time: {
              "5.3.15": new Date(now.getTime() - 720 * ONE_HOUR).toISOString(),
              "5.3.19": new Date(now.getTime() - 48 * ONE_HOUR).toISOString(),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    // jsr.io meta.json is down.
    return Promise.resolve(new Response("down", { status: 503 }));
  };
  const decisions = await decideBumps({
    imports: { "@stsoftware/neat-ai": "jsr:@stsoftware/neat-ai@5.3.15" },
    quarantineHours: 24,
    now,
    fetcher,
  });
  assertEquals(decisions[0]?.bumped, true);
  assertEquals(decisions[0]?.targetVersion, "5.3.19");
});
