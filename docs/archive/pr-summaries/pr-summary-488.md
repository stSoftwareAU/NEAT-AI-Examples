# Parallelise `deno test` in `quality.sh`

## Summary

Added `--parallel` to the `deno test` invocation in `quality.sh` so the
unit-test step uses all available CPU cores instead of running serially.
The full suite of 943 tests passes deterministically across three
consecutive runs with no flakes. Closes #488.

This change is scoped per parent issue #487: parallelise the **test
runner only**; the shell steps in `quality.sh` and the example runs
remain serial.

## Evidence

### Wall-clock for the unit-test step (the `deno test` line)

Measured on the same machine (Apple Silicon, 8 cores) with
`/usr/bin/time -p deno test ...`:

| Mode                  | Real wall-clock | Deno-reported |
| --------------------- | --------------- | ------------- |
| Serial (baseline)     | 60.17 s         | 56 s          |
| `--parallel` (run 1)  | 13.53 s         | 13 s          |
| `--parallel` (run 2)  | 13.98 s         | 13 s          |
| `--parallel` (run 3)  | 14.08 s         | 13 s          |

Speed-up: **~4.3× wall-clock**. All 943 tests pass deterministically
across all three parallel runs.

### Full-suite verification

A full `./quality.sh` run on this branch produces the same example-step
outcomes as a clean run on Develop:

- **Unit Tests**: PASS (parallel, ~13 s) — was PASS (serial, ~60 s) on
  Develop.
- **MNIST Handwritten-Digit Classification Example**: FAILS on this
  branch and on Develop — pre-existing `NotCapable: Requires env access
  to "TMPDIR"` in `mnist_classification.ts:598`. Not introduced by this
  change.
- **Adaptive Mutation Rate Demo**: intermittent
  `ValidationError: invalid score` from
  `FindTunePopulation.make` in `@stsoftware/neat-ai`. Reproduces on
  Develop too — unrelated library-level flake, not introduced by this
  change.

Both pre-existing/flake failures are outside the scope of #488.

### Parallelism safety review

Every existing test that creates filesystem state uses
`Deno.makeTempDir()` (or unique subdirectories) — confirmed by grep
across all 65 `*_test.ts` files. No test relies on a fixed port, a
shared cwd, or a singleton process-global, so no test needed to be
opted out of parallelism. No `--sequential` or `{ sanitize... }` opt-out
markers were added.

## Test Plan

- Three consecutive `deno test --parallel ...` runs locally — 943 / 943
  pass on each run (timings above).
- Diff of `quality.sh` shows a single one-token change on the unit-test
  line; no other lines moved.
- Full `./quality.sh` exit-code path unchanged: the script still sets
  `FAILED=1` and `exit 1` when any step fails, and `exit 0` on a clean
  run.
