// Regression test for issue #647: six standard-library dependencies were
// declared in the `imports` map of deno.json but never imported by any
// source file. Declared-but-unused dependencies inflate the resolved
// module set and lockfile and widen the supply-chain attack surface.
//
// This is a behavioural ("what") test — it parses the committed deno.json
// as data and asserts the dead entries stay removed, guarding against a
// silent re-introduction.

import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

// The six specifiers removed in issue #647. None is imported by any
// source file (only `@std/testing/mock` appears, as quoted string-literal
// fixtures in bump_deps_test.ts — never as an import statement).
const REMOVED_SPECIFIERS = [
  "@std/bytes",
  "@std/crypto",
  "@std/csv",
  "@std/streams",
  "@std/testing/mock",
  "@std/uuid",
];

Deno.test("removed unused @std/* imports stay out of deno.json", async () => {
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${REPO_ROOT}deno.json`),
  ) as { imports: Record<string, string> };

  for (const specifier of REMOVED_SPECIFIERS) {
    assert(
      !(specifier in denoJson.imports),
      `deno.json still declares unused import "${specifier}" — it is not ` +
        "imported by any source file and was removed in issue #647",
    );
  }
});
