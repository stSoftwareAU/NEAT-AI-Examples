## Summary

Narrowed the public surface of `common/outcome_bar_chart.ts` by dropping the `export` keyword from
the `OUTCOME_COLOUR` constant. The constant has no importer anywhere in the repository — it is read
only by the three local SVG renderers in the same file (count bars, strip cells, legend swatches) —
so it becomes module-private with its internal behaviour unchanged. Closes #622.

Verified there are no external references before removing the export:

```
$ grep -rnw OUTCOME_COLOUR --include='*.ts' --include='*.md' \
    --include='*.json' --include='*.js' .
common/outcome_bar_chart.ts:60:const OUTCOME_COLOUR: ...   # declaration
common/outcome_bar_chart.ts:178: ... fill="${OUTCOME_COLOUR[cat]}" ...
common/outcome_bar_chart.ts:242: ... fill="${OUTCOME_COLOUR[o.outcome]}" ...
common/outcome_bar_chart.ts:288: ... fill="${OUTCOME_COLOUR[cat]}" ...
```

All hits are inside the declaring module — no importer, no barrel re-export, no string/dynamic
reference.

## Evidence

Backend/renderer change with no web interface to screenshot. The renderer's observable output is
verified by the unit test suite:

- `deno test -A common/` → **205 passed, 0 failed**.
- Targeted `deno fmt --check`, `deno lint`, and `deno check` on both changed files pass cleanly.

## Test Plan

- Added
  `common/outcome_bar_chart_test.ts::renderOutcomeBarChartSVG: fills each
  category with its outcome colour`
  — a "what" test asserting the rendered SVG contains each outcome's expected colour fill. This
  exercises the now module-private `OUTCOME_COLOUR` palette purely through observable output, so it
  guards the internal rendering behaviour that must survive the export removal.
- Existing outcome-bar-chart tests continue to pass unchanged.
