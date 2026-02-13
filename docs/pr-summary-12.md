## Summary

Extract shared utilities into a `common/` module to eliminate duplicated code across the discovery,
intelligent design, and crossover examples. Closes #12.

The following shared utilities were extracted:

- **`common/deterministic_random.ts`** — Seeded PRNG (moved from `shared/`; the old `shared/`
  directory has been removed)
- **`common/synthetic_data.ts`** — `generateSyntheticData()` and `scoreCreature()` with a
  `SyntheticConfig` interface, replacing three identical implementations across the example modules
- **`common/working_dirs.ts`** — `setupWorkingDirs()` replaces the repeated
  `ensureDirSync`/`emptyDirSync` pattern in each example's main function

Each example module now imports from `common/` and re-exports the shared functions so existing test
imports continue to work without modification. Creature definitions remain example-specific, as the
issue suggested.

## Evidence

This is a backend/CLI refactoring with no visual output. Evidence is provided by the test suite:

- All 101 unit tests pass (16 new + 85 existing)
- `quality.sh` passes cleanly: lint, format, unit tests, and all four example runner scripts
- The duplicated `generateSyntheticData` function was removed from all three example modules
  (discovery, intelligent design, crossover) and replaced with imports from `common/`

## Test Plan

- Added `common/synthetic_data_test.ts` (8 tests): file creation, correct sizes, determinism,
  valid float32 values, different seeds produce different data, scoring correctness
- Added `common/working_dirs_test.ts` (5 tests): directory creation, correct paths, output
  directory emptying, data/creatures preservation, idempotency
- Existing `common/deterministic_random_test.ts` (3 tests) moved from `shared/` — unchanged
- All existing tests in discovery (18), intelligent design (14), and crossover (21) continue to
  pass without modification (except one import path update in the discovery test)
