# PR Summary — Issue #765

## Summary

Removed the unused export `EXPLORATION_CALIBRATION_PATH` from
`mnist_classification/exploration_campaign.ts`. The constant aliased
`explorationPaths().calibration` but was never imported or referenced by any executable code —
callers that need the path already obtain it from `explorationPaths()`. The only other mention was a
`{@link}` in the doc comment on `loadExplorationCalibration`, which has been reworded to name
`explorationPaths().calibration` so it does not dangle.

This mirrors the removals of `EXPLORATION_PHASE_LOG_PATH` (#763) and `EXPLORATION_SUMMARY_PATH`
(#764). Closes #765.

## Evidence

Backend/CLI change only — no web interface to screenshot.

Dynamic-use check requested by the issue: a repository-wide search finds no remaining reference to
the identifier, and no string-keyed lookup of `"EXPLORATION_CALIBRATION_PATH"` exists, so nothing
resolves it reflectively.

```
$ grep -rn "EXPLORATION_CALIBRATION_PATH" .
(no matches)
```

Module tests after the change:

```
$ deno test --allow-all mnist_classification/exploration_campaign_test.ts
...
calibration path comes from explorationPaths(), not a module-level alias ... ok (20µs)
ok | 13 passed | 0 failed (19ms)
```

The new test fails against the unfixed code (`AssertionError` on the module-surface check) and
passes after the removal.

## Test Plan

- Added
  `mnist_classification/exploration_campaign_test.ts::"calibration path comes from
  explorationPaths(), not a module-level alias"`
  — asserts `explorationPaths(EXPLORATION_ROOT).calibration` resolves to `<root>/calibration.json`
  and that `EXPLORATION_CALIBRATION_PATH` is absent from the module's exported surface.
- Existing `exploration_campaign_test.ts` suite re-run unchanged (13 passed).
- `./quality.sh` run in full.
