## Summary

Make `generateSyntheticData` in the intelligent design module deterministic, consistent with the
discovery module's approach. Closes #10.

### Changes

- **Seeded PRNG**: Replaced `Math.random()` with a seeded `createDeterministicRandom` function,
  ensuring identical data is generated across runs for a given seed.
- **Creature-derived sizes**: Input and output sizes are now derived from the `Creature` object
  (`creature.input`, `creature.output`) instead of being hardcoded as `4` and `1`.
- **Creature activation for targets**: Target outputs are generated using the creature's own
  `activate()` method rather than a separate mathematical formula (`Math.tanh(...)`).
- **Shared PRNG utility**: Extracted `createDeterministicRandom` into
  `shared/deterministic_random.ts` so both the discovery and intelligent design modules import from
  a single source of truth (DRY).
- **Configurable generation**: Added `SYNTHETIC_CONFIG` (matching the discovery module's pattern)
  with `totalRecords`, `recordsPerFile`, and `seed` fields.

## Evidence

This is a backend/CLI change with no visual output. Correctness is verified by the test suite:

- All 35 tests pass across intelligent design, discovery, and shared modules
- The full `quality.sh` pipeline passes (lint, format, tests, example runners)

## Test Plan

- **New test**: `generateSyntheticData is deterministic for the same seed` — generates data twice
  with the same seed and asserts the binary output is byte-for-byte identical
- **New test**: `generateSyntheticData splits records across multiple files` — verifies batched file
  output works correctly
- **New test**: `SYNTHETIC_CONFIG has expected properties` — validates the configuration constant
- **New tests**: `shared/deterministic_random_test.ts` — tests for the extracted PRNG (range,
  determinism, seed diversity)
- **Updated tests**: All existing `generateSyntheticData` tests updated for the new function
  signature (`Creature, dataDir, config`) and new file naming pattern (`synthetic_0000.bin`)
- All 7 original `createReferenceCreature` tests preserved unchanged
