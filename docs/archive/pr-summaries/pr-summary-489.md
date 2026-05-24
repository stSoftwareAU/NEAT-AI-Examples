# Issue #489 — Dedupe unit tests

## Summary

Audited all 65 `*_test.ts` files (930 `Deno.test(...)` blocks) for tests that duplicate another
test's observable behaviour, per the criteria in issue #489: two tests are duplicates only when they
assert the same observable behaviour for the same equivalence class of inputs. The audit found that
the suite is already well-deduplicated — only one clean-cut duplicate survived. That test has been
removed. Closes #489.

## Deleted tests

| File                           | Deleted test                                              | Surviving test that covers the same invariant           | Why it was a duplicate                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/tsp_instances_test.ts` | `tourLength is invariant under tour reversal (ulysses22)` | `tourLength is invariant under tour reversal (burma14)` | Both assert exactly the same invariant (`tourLength(forward) == tourLength(reversed)`) for the same equivalence class — any TSP tour. The instance choice is incidental, not a new equivalence class. |

## Before / after counts

| Metric                                          | Before | After |
| ----------------------------------------------- | -----: | ----: |
| `Deno.test(...)` blocks                         |    930 |   929 |
| Test files                                      |     65 |    65 |
| `common/tsp_instances_test.ts` Deno.test blocks |     17 |    16 |

## Audit method and findings

The audit was performed by:

1. Extracting every `Deno.test(...)` line across all 65 `*_test.ts` files (gives a single index of
   all 930 tests with file + line).
2. Surveying each test file for tests on the same function with similar names, then reading the
   bodies to compare what behaviour and what equivalence class of inputs each test asserts.
3. Cross-referencing structurally similar pairs (e.g. tests named `<fn> rejects non-finite <field>`
   for many different `<field>`s) to confirm whether each test is genuinely asserting a different
   invariant or just re-running the same invariant on a different input.

The audit found that the suite already follows the discipline described in `AGENTS.md` ("what" tests
only, each asserting a single observable invariant): structurally similar tests almost always target
distinct equivalence classes (different fields, different instances of a problem, different branches
of an algorithm). The headers of several test files (e.g. `lunar_lander/lunar_lander_test.ts`)
explicitly document past dedupe work under issues #240, #292 and #324.

### Cases that look like duplicates but aren't

- `crossover/crossover_example_test.ts` has parallel `createParentA` / `createParentB` tests (valid,
  finite, deterministic, I/O shape). They exercise different functions, so each parent retains its
  own happy/error/edge coverage.
- `common/evolve_dir_summary_test.ts` has five `rejects non-finite <field>` tests. Each asserts
  rejection on a different field with a different error message — distinct invariants on distinct
  equivalence classes.
- `mnist_classification/mnist_classification_test.ts` has two `writeMnistTrainingBin` tests
  (`writes the documented binary record
  stride (784 + 10)` and `round-trips synthetic samples`).
  The first encodes the documented stride formula and one-hot for specific labels (3, 7); the second
  is a generic round-trip across labels 0–3. They share some assertions but cover different
  equivalence classes (documented constants vs. generic round-trip across labels) — kept both per
  the issue's "be conservative" guidance.
- `cart_pole/physics_test.ts` has paired `positive force` / `negative
  force` tests — these assert
  symmetric behaviour on opposite-sign inputs, which is a separate invariant from the magnitude
  behaviour.

## Coverage impact

`common/tsp_instances_test.ts` still exercises every public function and branch:

- `tourLength` — happy path (unit square), reversal invariance (burma14), error path (wrong-length
  tour), edge case (empty cities).
- `loadInstance`, `euclideanDistance`, `boundingBoxDiagonal`, `nearestNeighbourTour` — unchanged.

The deleted `(ulysses22)` test added no equivalence class not already covered by the `(burma14)`
test, and `loadInstance returns ulysses22
with 22 cities and optimum 7013` still ensures the
`ulysses22` instance itself is exercised.

## Evidence

This is a test-only change. Verification:

```text
common/tsp_instances_test.ts  ok | 16 passed | 0 failed (22ms)
common/ (all)                 ok | 163 passed | 0 failed (3s)
deno fmt --check              Checked 404 files (pass)
deno lint                     Checked 146 files (pass)
deno check common/tsp_instances_test.ts  (pass)
```

## Test Plan

- The surviving test `tourLength is invariant under tour reversal
  (burma14)` continues to assert
  the symmetry invariant.
- `deno test common/tsp_instances_test.ts` reports 16 passed / 0 failed (was 17 / 0 before the
  deletion).
- `deno test common/` reports 163 passed / 0 failed.
- `deno fmt --check`, `deno lint`, and `deno check` all pass on the modified file.
