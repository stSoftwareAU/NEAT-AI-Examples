## Summary

Narrowed the public surface of `common/outcome_bar_chart.ts` by dropping the
`export` modifier from the `OUTCOME_COLOUR` constant. Module-graph analysis
confirmed no `.ts` module, test, barrel re-export, or string/dynamic reference
outside the file imports the constant — it is read only by the three local SVG
renderers (count bars, cell strip, legend swatches). Removing `export` keeps it
as a module-private constant with those internal read sites unchanged. Closes #622.

## Evidence

Backend/library change with no web interface, so no screenshot applies. The
constant drives the fill colours of the rendered SVG; that behaviour is now
guarded by a new "what" test asserting each outcome colour appears in the
output. Verification:

- `deno test common/outcome_bar_chart_test.ts` → 12 passed, 0 failed.
- `deno test common/` → 205 passed, 0 failed.
- `deno fmt --check`, `deno lint`, `deno check` on both changed files → clean.

The one pre-existing `quality.sh` failure (`Temporal is not defined` in the
`suggest_improvements` example, from the NEAT-AI dependency needing
`--unstable-temporal`) is unrelated — it reproduces on the base branch with my
change stashed.

## Test Plan

- Added `common/outcome_bar_chart_test.ts::renderOutcomeBarChartSVG: fills cells
  with each outcome's colour` — a "what" test that renders the chart and asserts
  each outcome's `fill="#…"` colour appears, guarding the behaviour the now
  module-private `OUTCOME_COLOUR` drives without importing the constant.
- Existing 11 renderer tests continue to pass unchanged.
