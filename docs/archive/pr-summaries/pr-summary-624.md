# Remove dead-code unused export `ensureParentDir`

## Summary

Deleted the unused exported helper `ensureParentDir` from
`mnist_classification/data.ts`. A repo-wide search confirmed the identifier
appeared exactly once — its own declaration — with no importer in any `.ts`
module (production or test), no re-export from a barrel, and no dynamic/string
reference in any `.sh`/`.md`/`.json` file. The runner creates its output
directories with its own `ensureDirSync`, so the JSDoc's "Used by the runner"
claim was stale.

Because the function body (`await ensureDir(dirname(path))`) was the sole
consumer of the `ensureDir` (`@std/fs`) and `dirname` (`@std/path`) imports at
`data.ts:17-18`, those two imports were removed alongside it — otherwise
`deno lint`'s `no-unused-vars` would flag them.

Closes #624

## Evidence

Backend/CLI-only change — no web interface to screenshot. Verification was via
the quality gates:

- `deno fmt --check` — clean
- `deno lint` (168 files) — clean
- `deno check ./**/*.ts` — clean
- `deno test mnist_classification/mnist_classification_test.ts` — 41 passed, 0 failed

The existing `mnist_classification_test.ts` imports the other public symbols of
`data.ts` (`parseIdxImages`, `parseIdxLabels`, `buildDigitSamples`,
`splitDataset`, `readGzippedFile`, …) and never referenced `ensureParentDir`, so
its continued green run confirms the removal did not disturb the module's public
surface.

## Test Plan

- No new tests: this is a pure dead-code deletion with no behavioural change to
  test. Asserting a deleted symbol's absence would be a forbidden "how" test
  (see AGENTS.md Testing Philosophy).
- Ran the full `mnist_classification/mnist_classification_test.ts` suite
  (41 tests) — all pass, confirming the surviving exports are unaffected.
- Repo-wide `deno lint` / `deno check` confirm no unused imports remain and the
  module still type-checks.
