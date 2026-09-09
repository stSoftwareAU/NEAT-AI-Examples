## Summary

Collapsed the four near-duplicate `gradedTerminalReward` ordering tests in
`lunar_lander/lunar_lander_test.ts` into a single table-driven test. The four bodies shared
identical setup, identical structure and an identical assertion shape — build a baseline
`LanderState`, vary exactly one field, compare the two rewards — so each was another place a change
to `LanderState`'s field list or to `gradedTerminalReward`'s calling convention had to be edited by
hand. Closes #851.

No behavioural coverage is lost. All four shaping dimensions (impact speed, distance from the pad,
tilt, spin) are still asserted, each as its own `t.step` with its original name and its own
pass/fail in the test report.

## Evidence

Backend/test-only change — there is no web interface to screenshot. The evidence is the test run
itself, which shows the four dimensions still reported individually:

```text
running 7 tests from ./lunar_lander/lunar_lander_test.ts
gradedTerminalReward returns exactly 0 for a clean landing ... ok (458µs)
gradedTerminalReward returns a value in [-1, 0) for every non-landed state ... ok (314µs)
gradedTerminalReward orders states by shaping dimension ...
  softer crash > harder crash (less negative) ... ok (1ms)
  closer to pad > farther from pad ... ok (0ms)
  upright > tilted (less negative) ... ok (0ms)
  non-spinning > spinning (less negative) ... ok (0ms)
gradedTerminalReward orders states by shaping dimension ... ok (1ms)
gradedTerminalReward respects [-1, 0] bounds across a state sweep ... ok (570µs)
gradedTerminalReward handles out_of_bounds states (non-positive, bounded) ... ok (43µs)
gradedTerminalReward keeps soft non-landed outcomes meaningfully below landing ... ok (41µs)
gradedTerminalReward penalises unresolved hover timeout by altitude ... ok (35µs)

ok | 7 passed (4 steps) | 0 failed | 65 filtered out (9ms)
```

The four `t.step` lines are the four tests this PR removed — the coverage is intact, only the
duplicated bodies are gone.

## Test Plan

- Removed `gradedTerminalReward: softer crash > harder crash (less negative)`,
  `gradedTerminalReward: closer to pad > farther from pad`,
  `gradedTerminalReward: upright > tilted (less negative)` and
  `gradedTerminalReward: non-spinning > spinning (less negative)` from
  `lunar_lander/lunar_lander_test.ts`.
- Added `gradedTerminalReward orders states by shaping dimension` in their place — a table-driven
  test over `ORDERING_CASES`, one `t.step` per removed test, keeping each original name.
- Added `ORDERING_BASE` (the shared off-pad, upright, non-spinning baseline) and `ORDERING_CASES`
  (per-dimension `better` / `worse` overrides). Every state literal is the same as before: each
  case's spread reproduces the exact `LanderState` its predecessor built, so the assertions compare
  identical values to identical values.
- Ran `deno fmt`, `deno lint`, `deno check` on the changed file, plus
  `deno test -A --filter gradedTerminalReward lunar_lander/lunar_lander_test.ts` — all pass.
- Ran the full `./quality.sh` gate: **29 stages, 0 failures, exit 0** ("All examples passed!"),
  covering Deno Format, Bash Syntax, Deno Lint, Deno Type Check, Unit Tests and every example run.

An earlier full-gate run on this identical tree reported one failing example section; the clean
re-run above passed every stage, so that was a flaky example run rather than anything this change
caused — the diff is test-only, confined to `lunar_lander/lunar_lander_test.ts`, and cannot affect
any example's runtime behaviour. The gate also rewrites several `docs/screenshots/*.svg` artefacts
as a non-deterministic side effect of running the demos; those working-tree edits were reverted and
are deliberately **not** part of this PR.
