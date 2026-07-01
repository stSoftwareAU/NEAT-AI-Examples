## Summary

Removed the redundant `export` modifier from the `OUTCOME_COLOUR` constant in
`common/outcome_bar_chart.ts`. A repo-wide search confirmed the constant has no
importer in any module — it is read only by the three local SVG renderers in
its own file (lines 178, 242, 288). Narrowing it to module-private tightens the
public surface without changing any behaviour; the constant and its internal
read sites are untouched. Closes #622.

## Evidence

Backend/CLI change — no web interface to screenshot.

Verification that `OUTCOME_COLOUR` is referenced only within its own file:

```
$ grep -rn "OUTCOME_COLOUR" . --include="*.ts" --include="*.md" --include="*.json" --include="*.js"
common/outcome_bar_chart.ts:60:const OUTCOME_COLOUR: ...
common/outcome_bar_chart.ts:178: ... fill="${OUTCOME_COLOUR[cat]}" ...
common/outcome_bar_chart.ts:242: ... fill="${OUTCOME_COLOUR[o.outcome]}" ...
common/outcome_bar_chart.ts:288: ... fill="${OUTCOME_COLOUR[cat]}" ...
```

The test file imports only `OUTCOME_ORDER` and `renderOutcomeBarChartSVG`, never
`OUTCOME_COLOUR`, so dropping the export does not break any consumer.

Lint, format, type-check, and all unit tests pass via `./quality.sh`. The
`Adaptive Mutation Rate Demo` example failure reported by `quality.sh` is
pre-existing and unrelated — it fails identically on a clean tree
(`ValidationError: ... has invalid score`) and does not import
`common/outcome_bar_chart.ts`.

## Test Plan

- Added `common/outcome_bar_chart_test.ts::"renderOutcomeBarChartSVG: each
  outcome renders in its own colour"` — a "what" test asserting each outcome's
  fill colour appears in the rendered SVG. It exercises the rendered-colour
  behaviour that `OUTCOME_COLOUR` drives without depending on the constant being
  an exported symbol, so it survives the export removal.
- Existing `outcome_bar_chart_test.ts` suite continues to pass (12 tests, all
  green).
