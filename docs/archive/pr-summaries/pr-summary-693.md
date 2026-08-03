# Reword private-repo sampler mentions in `mnist_classification`

## Summary

The `mnist_classification/` example named a private production repository and pointed readers at its
internal scripts (`sampler.sh`, `worker/shared/squash_random.sh`, `.sampler/loop-N.json`) across
module docs, code comments, exported identifiers, console output, and test names. None of those
pointers resolve for a public reader.

Every mention is now reworded to concept level — "sampled exploration campaign": early
structure-discovery loops train on a subsample, the final polish loop uses full data. Behaviour is
unchanged; only wording and two identifier names moved. Closes #693.

Renamed exports (`mnist_classification/exploration_campaign.ts`):

| Before                                                                       | After                       |
| ---------------------------------------------------------------------------- | --------------------------- |
| the sampler loop-count constant, prefixed with the private repository's name | `SAMPLER_LOOP_COUNT`        |
| the structure sample-rate accessor, prefixed with the same name              | `randomStructureSampleRate` |

Files touched: `exploration_campaign.ts`, `exploration_campaign_test.ts`, `exploration_campaign.sh`,
`README.md`, `mnist_classification.ts`, `phase_champions.ts`, `phase_champions_test.ts`,
`population_pool.ts`, `population_pool_test.ts`, `squash_random.ts`.

## Evidence

No web interface to screenshot — this is a documentation/identifier rename in a CLI example.
Verified instead by:

- A case-insensitive grep for the private repository's name across `mnist_classification/` returns
  no matches.
- `deno fmt --check`, `deno lint`, and `deno check` pass on the module.
- The existing `mnist_classification` unit tests pass unchanged in behaviour (23 tests), exercising
  the renamed `randomStructureSampleRate` and the sampler-loop archive helpers.

## Test Plan

No new behaviour, so no new tests — the existing suites were updated to the new names and still
assert the same outcomes:

- `mnist_classification/exploration_campaign_test.ts` —
  `randomStructureSampleRate stays within the
  10–50% band` (renamed from the private-repo-prefixed
  variant) still asserts the 0.10 / 0.50 band endpoints;
  `structureSampleRatesForCalibration keeps the ladder when full data is fast enough` and
  `buildExplorationLoopPhases repeats the five-loop sampler cadence` renamed, assertions unchanged.
- `mnist_classification/population_pool_test.ts` — `priorLoopPhaseNames lists earlier sampler loops`
  renamed, assertions unchanged.
- `mnist_classification/phase_champions_test.ts` — module doc comment reworded only.
