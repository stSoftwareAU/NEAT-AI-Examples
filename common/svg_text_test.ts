/**
 * Unit tests for the shared SVG text/number helpers.
 *
 * These are "what" tests — each case calls a real helper with known
 * input and asserts on the returned string, never on how it is built.
 */

import { assertEquals } from "@std/assert";

import { escapeAttr, escapeText, fmt, formatScore } from "./svg_text.ts";

Deno.test("fmt: rounds a coordinate to two decimal places", () => {
  assertEquals(fmt(1.23456), "1.23");
  assertEquals(fmt(1.239), "1.24");
  assertEquals(fmt(70), "70");
  assertEquals(fmt(-0.001), "0");
});

Deno.test("fmt: a non-finite coordinate degrades to 0", () => {
  assertEquals(fmt(Infinity), "0");
  assertEquals(fmt(-Infinity), "0");
  assertEquals(fmt(NaN), "0");
});

Deno.test("formatScore: rounds a value to three decimal places", () => {
  assertEquals(formatScore(0.123456), "0.123");
  assertEquals(formatScore(42), "42");
  assertEquals(formatScore(0.05), "0.05");
  assertEquals(formatScore(-1.23456), "-1.235");
});

Deno.test("formatScore: a non-finite value degrades to 0", () => {
  assertEquals(formatScore(Infinity), "0");
  assertEquals(formatScore(NaN), "0");
});

Deno.test("escapeText: neutralises XML metacharacters", () => {
  assertEquals(escapeText(`a & b < c > d`), "a &amp; b &lt; c &gt; d");
  assertEquals(escapeText(""), "");
  assertEquals(escapeText("plain"), "plain");
});

Deno.test("escapeText: ampersands are escaped before the entities they introduce", () => {
  // `&` must be replaced first, otherwise the `&` of `&lt;` is double-escaped.
  assertEquals(escapeText("&<>"), "&amp;&lt;&gt;");
  assertEquals(escapeText("&amp;"), "&amp;amp;");
});

Deno.test("escapeAttr: layers double-quote escaping on top of escapeText", () => {
  assertEquals(escapeAttr(`say "hi" & <bye>`), "say &quot;hi&quot; &amp; &lt;bye&gt;");
  assertEquals(escapeAttr(`"`), "&quot;");
  assertEquals(escapeAttr("no quotes"), escapeText("no quotes"));
});
