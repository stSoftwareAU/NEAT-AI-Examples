## Summary

Added `common/tsp_instances.ts`, a shared TSPLIB instance module providing embedded `burma14` (14
cities, optimum 3,323) and `ulysses22` (22 cities, optimum 7,013) coordinate data plus reusable
Euclidean tour helpers (`euclideanDistance`, `tourLength`, `boundingBoxDiagonal`,
`nearestNeighbourTour`). This is the foundation that the upcoming `tsp_constructive` and
`tsp_two_opt` examples (issue #456) will both reuse, mirroring how `common/large_creature.ts`,
`common/episode_runner.ts`, and `common/multi_run_state.ts` are organised. All coordinates are
embedded as literal arrays — no runtime network fetch. Closes #457.

## Evidence

Backend-only CLI module — no UI to screenshot. Verified by 17 new unit tests in
`common/tsp_instances_test.ts`, all passing:

```
ok | 17 passed | 0 failed (29ms)
```

`deno fmt` and `deno lint` both pass on the new files. The two failures shown in the full
`./quality.sh` run (`adaptive_mutation_test.ts:137` and `lunar_lander_test.ts:485`) are pre-existing
on the base branch and are unrelated to this TSP module.

## Test Plan

- Added `common/tsp_instances_test.ts` covering:
  - `loadInstance("burma14")` returns 14 cities with `optimum === 3323`.
  - `loadInstance("ulysses22")` returns 22 cities with `optimum === 7013`.
  - `loadInstance` rejects an unknown instance name.
  - `euclideanDistance` is symmetric for every burma14 pair.
  - `tourLength` computes the perimeter of a unit square (and a diagonal-crossing permutation).
  - `tourLength` is invariant under tour reversal for both embedded instances (within `1e-9`
    tolerance).
  - `tourLength` rejects a `tourOrder` of the wrong length.
  - `tourLength` returns `0` for an empty city list.
  - `boundingBoxDiagonal` computes the 3-4-5 triangle diagonal, returns `0` for empty input, and is
    positive on both embedded instances.
  - `nearestNeighbourTour` visits every burma14 city exactly once.
  - `nearestNeighbourTour` is deterministic for the same start index.
  - `nearestNeighbourTour` picks the obvious neighbour on a known straight-line layout (forward and
    reverse start).
  - `nearestNeighbourTour` rejects out-of-range start indices and returns `[]` for an empty city
    list.
