# Add shared `evolveDir` return-value summary chart helper (#284)

## Summary

Added a new shared helper `common/evolve_dir_summary.ts` that renders a deterministic,
dependency-free SVG summary chart for the return value of `Creature.evolveDir` (final error, final
score, generations, wall-clock time) plus before/after topology (neurons and synapses) of the seed
and final creature. An optional caption surfaces the configured `targetError` and `timeoutMinutes`
stop conditions.

The helper is the foundation reused by the `mnist_classification` and `adaptive_mutation` example
rewrites tracked in #272, #273, and #263, so both examples share one consistent summary chart.
Closes #284.

## Evidence

This change is a backend/utility addition with no web interface to screenshot — the helper emits SVG
strings that callers persist alongside their other run artefacts. Verification is via the new unit
test suite below, which asserts on the SVG content (numeric callouts, topology bars, caption
presence, deterministic output, non-finite rejection).

Layout of the produced SVG:

```mermaid
flowchart LR
    A[evolveDir result\n{error, score, time, generation}] --> S[EvolveDirSummary]
    T[Seed + Final creature\nneurons / synapses] --> S
    S --> R[renderEvolveDirSummarySvg]
    R --> SVG[Deterministic SVG\ntopology bars + numeric callouts + caption]
```

## Test Plan

Added `common/evolve_dir_summary_test.ts` with 15 tests covering:

- Happy path — well-formed summary renders an SVG containing each numeric value and the topology
  bars.
- Stop-condition caption present when `targetError`/`timeoutMinutes` are set, and omitted when both
  are absent.
- Error path — `NaN`/`±Infinity` rejected for every required numeric field (`finalError`,
  `finalScore`, `wallClockMs`, `generations`, `seedNeurons`, `seedSynapses`, `finalNeurons`,
  `finalSynapses`) and for optional fields (`targetError`, `timeoutMinutes`) when supplied.
- Edge case — seed and final topology equal (no growth) still renders the bar pair without
  artefacts.
- Edge case — very large topology values (5k/10k counts, 50k generations) format correctly.
- Edge case — very small numeric ranges (1e-9 error/score, sub-second duration) render without `NaN`
  or `Infinity` leaking through.
- Determinism — repeated calls and calls separated by a synchronous busy-wait produce byte-identical
  output.
- Option overrides — `width`, `height`, `title` flow through.

All 15 new tests pass; the broader `common/` suite (100 tests) still passes. `deno fmt`,
`deno lint`, and `deno check` all pass cleanly on the new files.
