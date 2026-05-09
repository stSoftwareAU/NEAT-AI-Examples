## Summary

Added a per-validation-scenario outcome bar chart that visualises how robustly the lunar-lander
champion generalises across all 200 unseen validation scenarios. Pairs with the fitness line chart
from #199 — the line chart shows the journey, this chart shows where the champion stands at the end.
Closes #200.

The new shared renderer lives under `common/` so other agent examples can reuse it once
`lunar_lander` proves the pattern. The layout is the 2x2 split recommended in the issue: a small
four-bar count chart on the left (`landed` / `crashed` / `out_of_bounds` / `flying`) gives the
headline "92% landed" number at a glance, while a per-scenario cell strip on the right shows every
individual outcome — a single red cell in a sea of green is obvious.

## Evidence

```mermaid
flowchart LR
    A[validateChampion] --> B[results.json]
    A --> C[ScenarioOutcome[]]
    C --> D[renderOutcomeBarChartSVG]
    D --> E[docs/screenshots/lunar_lander/validation.svg]
```

The runner now emits `docs/screenshots/lunar_lander/validation.svg` after the validation step writes
`results.json`. Quick-mode CI runs continue to skip writing the canonical artefact, matching the
existing behaviour of every other docs SVG the runner emits.

Sample chart (rendered from a short demonstration run — a maintainer regenerates this from a full
2-minute run when committing canonical artefacts):

![Validation outcome chart](docs/screenshots/lunar_lander/validation.svg)

## Test Plan

- `common/outcome_bar_chart_test.ts` — 11 new "what" tests covering: empty-input rejection,
  well-formed `<svg>` root, every outcome category renders a count bar, per-scenario cell count
  matches input length, score-range axis renders min/max, count labels reflect the input
  distribution, deterministic output for identical input, scales cleanly to 200 scenarios without
  emitting `NaN` or `Infinity`, legend renders all four labels, tooltips include the scenario index
  and outcome, and single-outcome input does not produce `NaN`.
- `lunar_lander/lunar_lander_test.ts` — existing 47 tests still pass; no test was modified or
  removed.
- `deno lint`, `deno check **/*.ts`, and `deno fmt` are all clean against the new files.

### Pre-existing failure (not introduced by this PR)

`docs/archive_test.ts` continues to fail on `Develop` because `docs/pr-summary-231.md` is present in
the `docs/` root but absent from the `archive_test.ts` allowlist. This failure pre-dates this branch
and is out of scope for #200; tracking is left to #231's archival follow-up.
