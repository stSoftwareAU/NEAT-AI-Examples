# lunar_lander: per-generation evolution CSV + best/avg fitness chart

## Summary

Captures per-generation evolution telemetry for the `lunar_lander` example and renders a best/avg
fitness line chart so readers can see how fitness improves over the run rather than just the final
number. Closes #199.

- New shared renderer `common/fitness_chart.ts` plots best fitness on the left axis and average
  fitness on the right axis against generation index, mirroring the structure of
  `common/evolution_chart.ts`.
- `lunar_lander.ts` now collects an `EvolutionRow` (`generation`, `bestFitness`, `avgFitness`,
  `landedRate`, `wallclockMs`) per `onGeneration` callback. After evolution stops the runner writes
  the rows to `docs/data/lunar_lander/evolution.csv` (header
  `generation,best_fitness,avg_fitness,landed_rate,wallclock_ms`) and the fitness line chart to
  `docs/screenshots/lunar_lander/fitness.svg`.
- `run.sh` runs `deno fmt` on the regenerated SVG so `deno fmt --check` stays clean.

## Evidence

Backend / CLI change — no UI to screenshot. Verified end-to-end by running the runner with a tight
budget; both files are produced and well-formed:

```
🗒️  Wrote evolution CSV docs/data/lunar_lander/evolution.csv (10 rows)
📈 Wrote fitness chart docs/screenshots/lunar_lander/fitness.svg
```

CSV header and first rows from the smoke run:

```
generation,best_fitness,avg_fitness,landed_rate,wallclock_ms
0,-618.928086,-2359.858316,0,238
1,-543.681771,-1588.590736,0.1,524
...
```

```mermaid
flowchart LR
  Evolve[evolveLanderController] -- onGeneration --> Rows[(EvolutionRow[])]
  Rows --> CSV[docs/data/lunar_lander/evolution.csv]
  Rows --> Fit[renderFitnessChartSVG]
  Fit --> SVG[docs/screenshots/lunar_lander/fitness.svg]
```

## Test Plan

New tests:

- `common/fitness_chart_test.ts` — empty input throws, well-formed `<svg>`, two polylines (best +
  avg), legend renders both labels, single-sample rendering, down-sampling, all-equal values produce
  no NaN, deterministic output.
- `lunar_lander/lunar_lander_test.ts`:
  - `evolveLanderController: CSV row count equals the number of generation events (issue #199)` —
    runs a tiny evolve with a known seed (snapshot-checkpoint trick pins it to exactly three
    generations) and confirms the CSV row count matches the generation event count.
  - `formatEvolutionCsv: header is exact and rows parse cleanly with @std/csv (issue #199)` —
    verifies the header string is the exact expected value, that rows parse cleanly with `@std/csv`,
    that values round-trip, and that the output is byte-deterministic.
  - `formatEvolutionCsv: empty input emits header only (issue #199)`.

Quality gates:

- `deno lint` — clean.
- `deno fmt --check` — clean.
- `deno check **/*.ts` — clean.
- `deno test --no-check` — 1028 passed; the single failure is the pre-existing
  `docs/archive_test.ts` which checks that older `pr-summary-186.md`, `-195.md`, `-196.md` files
  have been archived; that has nothing to do with this change.
