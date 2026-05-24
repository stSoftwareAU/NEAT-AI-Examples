## Summary

Audited the entire `*_test.ts` suite for HOW tests — tests that assert on private/internal state or
re-implement the function under test — and removed the one clear violation. Closes #490.

The audit was extensive (Grep for `._private` field access, scan of all 60 `*_test.ts` files, manual
review of the 20 largest test files for inline re-implementation patterns). The codebase is largely
WHAT-test disciplined already — every other test reviewed either drives a real exported function
with deterministic inputs and asserts on the returned value, or asserts on the observable artefact
(file contents, SVG markup, on-disk byte size, run.sh policy, README embed paths).

### HOW tests found and disposed

| File / Test                                                                                                  | Pattern                                                                                                                                                                                                                                             | Disposition                                  |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `tsp_constructive/environment_test.ts` :: `geoTourLength — totals match recomputed sum of geoDistance edges` | Test body re-implemented `geoTourLength` inline (looped `geoDistance` over consecutive cities, summed, then compared to `geoTourLength`). Pure tautology — would always pass for any implementation that sums `geoDistance` edges, by construction. | **DELETE** + 4 WHAT replacements (see below) |

### WHAT-test replacements for `geoTourLength` coverage

Coverage bar (happy / error / edge) restored by four property-based WHAT tests that assert
observable invariants without summing edges:

1. **happy** — `geoTourLength — closed-tour length is invariant under cyclic rotation`: rotating the
   start city of a closed tour yields the same total. Follows from "closed tour" alone; a buggy
   `geoTourLength` that mis-handles the closing edge would fail.
2. **happy** — `geoTourLength — reversed tour has the same length (symmetric edges)`: reversing the
   visit order yields the same total. Follows from `geoDistance` being symmetric.
3. **error** — `geoTourLength — throws when tour length differs from cities length`: covers the
   validation branch (`tour.length !== cities.length`).
4. **edge** — `geoTourLength — empty cities returns 0`: covers the `cities.length === 0` early
   return.

None of these recompute the sum inline; they assert mathematical invariants that survive any future
re-implementation that honours the contract.

### Out of scope (per issue body)

The issue explicitly excludes tests asserting on exact error strings and tests using call counts /
mocks / spies — neither pattern was modified.

### Notes on near-misses

A few tests look HOW-adjacent on first glance but are not:

- `runConstructiveEpisode — declared length matches geoTourLength() of the visit order` and the
  equivalent in `tsp_constructive_test.ts` assert consistency between two output fields of the
  runner (`result.tourLength` vs `geoTourLength(result.tour)`). They test an observable property of
  the runner's return value, not the runner's internals.
- `classifierAccuracy - returns 1.0 for a hand-built perfect parity creature` uses a hand-built
  creature fixture as a known-good input. The function under test (`classifierAccuracy`) is not
  re-implemented — the helper builds a network; the assertion is on `classifierAccuracy`'s output.
  WHAT test.
- Tests that read `run.sh` and `README.md` files (`common/run_sh_permissions_test.ts`, etc.) treat
  those files as the artefact being verified (security policy / documentation contract). The files
  themselves are the observable contract.

## Evidence

This is a backend / test-suite change — no UI to screenshot. Evidence is the test-runner output:

```
$ deno test --allow-all tsp_constructive/environment_test.ts
running 16 tests from ./tsp_constructive/environment_test.ts
…
geoTourLength — closed-tour length is invariant under cyclic rotation ... ok (0ms)
geoTourLength — reversed tour has the same length (symmetric edges) ... ok (0ms)
geoTourLength — throws when tour length differs from cities length ... ok (0ms)
geoTourLength — empty cities returns 0 ... ok (0ms)
…
ok | 16 passed | 0 failed (15ms)
```

Unit-test summary from `./quality.sh < /dev/null`:

```
ok | 945 passed | 0 failed (53s)
SUCCESS: Unit Tests
```

### Pre-existing failure unrelated to this PR

`./quality.sh` also reports `FAILED: MNIST Handwritten-Digit Classification Example`. This is a
pre-existing TMPDIR permission bug introduced by #485 — the MNIST runner calls
`Deno.env.get("TMPDIR")` (mnist_classification.ts:598) but `common/example_runner_preamble.sh`
does not allowlist `TMPDIR` in `NEAT_AI_ENV_VARS`. Reproduced identically on the base commit
`ef3afee` with `mnist_classification/` checked out unchanged. Out of scope for #490; should be
tracked under a separate issue.

## Test Plan

- [x] `deno test tsp_constructive/environment_test.ts` — 16 passed, 0 failed (the 4 new tests
      replace the 1 deleted HOW test, net +3).
- [x] `./quality.sh < /dev/null` — 945/945 unit tests pass; format, lint, type-check all green.
- [x] Grep for `._private` field access in tests — none.
- [x] Manual review of the 20 largest test files for inline re-implementation patterns — no further
      violations.
