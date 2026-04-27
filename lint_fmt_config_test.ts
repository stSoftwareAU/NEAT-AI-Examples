/**
 * Tests for the Deno linting and formatting configuration.
 *
 * These are "what" tests — they parse the actual configuration files
 * and verify that lint and fmt settings are present and correct.
 */

import { assertEquals, assertExists } from "@std/assert";

const DENO_JSON_PATH = "deno.json";
const QUALITY_SH_PATH = "quality.sh";

/** Helper to load and parse deno.json. */
function loadDenoConfig(): Record<string, unknown> {
  const content = Deno.readTextFileSync(DENO_JSON_PATH);
  return JSON.parse(content) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  deno.json lint configuration                                       */
/* ------------------------------------------------------------------ */

Deno.test("deno.json includes a lint section", () => {
  const config = loadDenoConfig();
  assertExists(config.lint, "deno.json should have a lint section");
});

Deno.test("deno.json lint section includes recommended rules", () => {
  const config = loadDenoConfig();
  const lint = config.lint as Record<string, unknown>;
  assertExists(lint.rules, "lint section should have rules");

  const rules = lint.rules as Record<string, unknown>;
  const tags = rules.tags as string[];
  assertExists(tags, "lint rules should have tags");
  assertEquals(tags.includes("recommended"), true, "lint rules should include 'recommended' tag");
});

/* ------------------------------------------------------------------ */
/*  deno.json fmt configuration                                        */
/* ------------------------------------------------------------------ */

Deno.test("deno.json includes a fmt section", () => {
  const config = loadDenoConfig();
  assertExists(config.fmt, "deno.json should have a fmt section");
});

Deno.test("deno.json fmt section specifies useTabs as false", () => {
  const config = loadDenoConfig();
  const fmt = config.fmt as Record<string, unknown>;
  assertEquals(fmt.useTabs, false, "fmt should use spaces, not tabs");
});

Deno.test("deno.json fmt section specifies lineWidth", () => {
  const config = loadDenoConfig();
  const fmt = config.fmt as Record<string, unknown>;
  assertEquals(typeof fmt.lineWidth, "number", "lineWidth should be a number");
  assertEquals(fmt.lineWidth, 100, "lineWidth should be 100");
});

Deno.test("deno.json fmt section specifies indentWidth as 2", () => {
  const config = loadDenoConfig();
  const fmt = config.fmt as Record<string, unknown>;
  assertEquals(fmt.indentWidth, 2, "indentWidth should be 2");
});

Deno.test("deno.json fmt section specifies singleQuote as false", () => {
  const config = loadDenoConfig();
  const fmt = config.fmt as Record<string, unknown>;
  assertEquals(fmt.singleQuote, false, "singleQuote should be false");
});

/* ------------------------------------------------------------------ */
/*  quality.sh includes lint and format checks                         */
/* ------------------------------------------------------------------ */

Deno.test("quality.sh runs deno lint", () => {
  const content = Deno.readTextFileSync(QUALITY_SH_PATH);
  assertEquals(content.includes("deno lint"), true, "quality.sh should run deno lint");
});

Deno.test("quality.sh runs deno fmt --check", () => {
  const content = Deno.readTextFileSync(QUALITY_SH_PATH);
  assertEquals(
    content.includes("deno fmt --check"),
    true,
    "quality.sh should run deno fmt --check",
  );
});

Deno.test("quality.sh runs deno check (type checking)", () => {
  const content = Deno.readTextFileSync(QUALITY_SH_PATH);
  assertEquals(
    /\bdeno check\b/.test(content),
    true,
    "quality.sh should run deno check for type checking",
  );
});

Deno.test("quality.sh runs type check before unit tests", () => {
  const content = Deno.readTextFileSync(QUALITY_SH_PATH);
  const checkPos = content.search(/\bdeno check\b/);
  const testPos = content.indexOf("deno test");
  assertEquals(
    checkPos !== -1 && checkPos < testPos,
    true,
    "deno check should run before deno test",
  );
});

Deno.test("quality.sh runs lint before unit tests", () => {
  const content = Deno.readTextFileSync(QUALITY_SH_PATH);
  const lintPos = content.indexOf("deno lint");
  const testPos = content.indexOf("deno test");
  assertEquals(lintPos < testPos, true, "deno lint should run before deno test");
});

Deno.test("quality.sh runs fmt check before unit tests", () => {
  const content = Deno.readTextFileSync(QUALITY_SH_PATH);
  const fmtPos = content.indexOf("deno fmt --check");
  const testPos = content.indexOf("deno test");
  assertEquals(fmtPos < testPos, true, "deno fmt --check should run before deno test");
});
