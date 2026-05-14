# PR — Multi-run complexity-curve SVG renderer

## Summary

Added `common/multi_run_complexity_chart.ts`, a dual-axis SVG renderer that plots creature
complexity (neuron count on the left axis, synapse count on the right axis) versus cumulative
generations across every run combined. Faint vertical guide lines mark each `runIndex` transition so
the diminishing-returns / "evolution slows as topology grows" narrative is visible at a glance.
Mirrors the structure of `common/milestone_chart.ts` and `common/multi_run_error_chart.ts` (issue
#319) for consistent output. Closes #320.

## Evidence

Backend/utility module — no UI to screenshot. Verified via the new test suite
(`common/multi_run_complexity_chart_test.ts`) and the full `common/` test suite:

- `deno fmt` — clean
- `deno lint` — clean
- `deno check common/*.ts` — clean
- `deno test common/` — 110 passed, 0 failed (including 12 new tests)

```mermaid
flowchart LR
    A[MultiRunMilestone[]] --> B[renderMultiRunComplexityChartSVG]
    B --> C[SVG string]
    C --> D{Sections}
    D --> E[neurons polyline<br/>left axis · green]
    D --> F[synapses polyline<br/>right axis · red]
    D --> G[run-boundary guides<br/>at runIndex transitions]
    D --> H[legend + optional caption]
```

## Test Plan

New tests in `common/multi_run_complexity_chart_test.ts`:

- Happy path emits valid SVG with both polylines, dual-axis ticks, and legend.
- Run-boundary markers render at each `runIndex` transition (one, two, and three-run cases).
- Single-run input produces no boundary markers.
- Empty input throws a clear error.
- Deterministic — identical input produces identical SVG output.
- Identical neuron + synapse counts do not leak `NaN` / `Infinity`.
- Caption summarises final neuron + synapse counts and total runs when `options.caption: true`.
- Caption defaults to off.
- `logX` layout differs from linear for power-of-ten spaced generations.
- Unsorted input is sorted by `cumulativeGen` (renderer is order-independent).
- Default title mentions creature complexity.

## Acceptance Criteria

- [x] `renderMultiRunComplexityChartSVG` produces SVG containing both polylines.
- [x] Run-boundary markers render at each `runIndex` transition.
- [x] No `NaN` or `Infinity` leaks to the SVG output.
- [x] Byte-deterministic for identical inputs.
- [x] Unit tests cover happy/error/edge paths and pass.
- [x] Formatting, lint, type check, and `common/` tests all pass cleanly.
