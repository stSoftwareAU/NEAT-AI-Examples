# Remove six unused `@std/*` dependencies from `deno.json`

## Summary

Six standard-library dependencies were declared in the `imports` map of
`deno.json` but never imported by any source file. Declared-but-unused
dependencies are dead weight in the build graph: they inflate the resolved
module set and lockfile and widen the supply-chain attack surface. This PR
removes the six dead entries and regenerates `deno.lock` so the two stay
consistent. Closes #647.

Removed direct imports:

| specifier | status |
| --- | --- |
| `@std/bytes` | removed (still present as a transitive of `@stsoftware/neat-ai`) |
| `@std/crypto` | removed (still present as a transitive of `@stsoftware/neat-ai`) |
| `@std/csv` | removed |
| `@std/streams` | removed |
| `@std/testing/mock` | removed |
| `@std/uuid` | removed |

Each specifier was verified unused by grepping every `*.ts` file (including
tests) for all real import forms — `from "<name>"`, `import "<name>"`,
dynamic `import("<name>")` — with zero matches. The only occurrences of
`@std/testing` are quoted string-literal fixtures in `bump_deps_test.ts`
(test data for the dependency-bump parser), never `import` statements, so
removing the entry leaves those tests passing.

`@std/bytes` and `@std/crypto` remain in `deno.lock` only as transitive
dependencies of `@stsoftware/neat-ai@5.7.6`, which is correct — they are no
longer direct dependencies of this repo.

## Evidence

Backend/config change — no web interface to screenshot.

- New regression test fails against the unmodified `deno.json` and passes
  after removal (see below).
- `common/lockfile_test.ts` ("every `deno.json` pin is resolved to the same
  version in `deno.lock`") passes, confirming `deno.json` and `deno.lock`
  stay consistent after regeneration.
- `./quality.sh` passes cleanly (lint, format, type-check, all example runs).

## Test Plan

- Added `common/unused_imports_test.ts::"removed unused @std/* imports stay
  out of deno.json"` — parses the committed `deno.json` and asserts the six
  removed specifiers are absent, guarding against silent re-introduction.
  Verified it fails before the `deno.json` edit and passes after.
- Ran `common/lockfile_test.ts` and `bump_deps_test.ts` — all pass, confirming
  the `@std/testing/mock` string-literal fixtures are unaffected.
- Ran `./quality.sh` end to end — all checks pass.
