# PR Summary — Issue #766

## Summary

Removed the unused export `PHASE_CHAMPIONS_DIR` from `mnist_classification/phase_champions.ts`. The
constant eagerly evaluated `phaseChampionsDir()` with its default exploration root but was never
imported or referenced anywhere in the repository. Every live caller — inside the module and in
`population_pool.ts` — already calls `phaseChampionsDir(explorationRoot)` directly, which is the
form that honours a caller-supplied root. The `phaseChampionsDir()` function itself is untouched.

This mirrors the removals of `EXPLORATION_PHASE_LOG_PATH` (#763), `EXPLORATION_SUMMARY_PATH` (#764)
and `EXPLORATION_CALIBRATION_PATH` (#765). Closes #766.

## Evidence

Backend/CLI change only — no web interface to screenshot.

Dynamic-use check requested by the issue: a repository-wide search finds no remaining reference to
the identifier, and no string-keyed lookup of `"PHASE_CHAMPIONS_DIR"` exists, so nothing resolves it
reflectively.

```
$ grep -rn "PHASE_CHAMPIONS_DIR" .
(no matches)
```

Module tests after the change:

```
$ deno test --allow-all mnist_classification/phase_champions_test.ts
champions directory comes from phaseChampionsDir(), not a module-level alias ... ok (80µs)
ok | 10 passed | 0 failed (23ms)
```

The new test fails against the unfixed code (`AssertionError` on the module-surface check) and
passes after the removal.

## Test Plan

- Added
  `mnist_classification/phase_champions_test.ts::"champions directory comes from phaseChampionsDir(), not a module-level alias"`
  — asserts `phaseChampionsDir(root)` and `phaseChampionPath(phase, root)` resolve under the
  supplied root, and that `PHASE_CHAMPIONS_DIR` is absent from the module's exported surface.
- Existing `phase_champions_test.ts` suite re-run unchanged (10 passed).
- `./quality.sh` run in full.
