## Summary

Embed the 442-city TSPLIB95 `pcb442` instance (printed-circuit-board drilling problem by
Groetschel/Juenger/Reinelt, published optimum 50,778) in `common/tsp_instances.ts` so downstream TSP
examples can load it the same way they already load `burma14` and `ulysses22`. City order matches
the canonical TSPLIB95 `NODE_COORD_SECTION` exactly so any downstream comparison to published tours
stays meaningful. Closes #480.

CLI wiring in `tsp_constructive` and `tsp_two_opt` is intentionally out of scope — those changes are
tracked in dependent sub-issues per the issue description.

## Evidence

Backend-only data and tests — no UI to screenshot. Verification was via the new and existing unit
tests:

```
deno test common/tsp_instances_test.ts
ok | 21 passed | 0 failed (6ms)
```

Full `./quality.sh` run: 950 unit tests pass; lint, fmt, type-check all green; the
`TSP Constructive Example` and `TSP Two-Opt Local Search Example` still pass with no CLI changes.
The only example failure (`MNIST`) is a pre-existing stochastic example failure unrelated to this
change — confirmed by reverting the diff and reproducing the same failure.

## Test Plan

Five new tests added in `common/tsp_instances_test.ts` covering the acceptance criteria from the
issue:

- [x] `loadInstance("pcb442")` returns an instance with `name === "pcb442"`,
      `cities.length === 442`, and `optimum === 50778`.
- [x] Every `pcb442` city has finite `x` and `y` (its own test for clarity).
- [x] `tourLength` is invariant under tour reversal on `pcb442` (within `1e-6`, scaled appropriately
      for the integer coordinate range).
- [x] `nearestNeighbourTour(cities, 0)` returns a permutation of `[0, 442)` with no duplicates and
      starts at index 0.
- [x] `boundingBoxDiagonal(cities) > 0` for `pcb442`.

Existing tests continue to pass unchanged — no test was modified or removed.
