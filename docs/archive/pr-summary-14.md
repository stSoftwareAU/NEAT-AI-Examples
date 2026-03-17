## Summary

Add benchmark files for the discovery and intelligent design modules, establishing baseline
performance data for creature activation, synthetic data generation, and scoring operations. Closes
#14.

## Changes

- **`discovery/discover_missing_neuron_bench.ts`** — Benchmarks for creature creation, activation
  (baseline and crippled), synthetic data generation (256 records), and scoring against generated
  data.
- **`intelligent_design/improve_squash_example_bench.ts`** — Benchmarks for creature creation,
  activation (single and varied inputs), synthetic data generation (500 records), and scoring (both
  `scoreDir` and `scoreCreature`).
- **`README.md`** — Added "Running Benchmarks" section with instructions for running all benchmarks
  or module-specific benchmarks via `deno bench`.
- **`AGENTS.md`** — Updated project structure to list the new benchmark files.

## Evidence

This is a backend/CLI change with no visual output. All benchmarks run successfully:

```
deno bench --allow-read --allow-write --allow-env
```

Discovery module benchmarks (8 benchmarks):

- Creature creation, instantiation, validation, crippled creature creation
- Activation (baseline and crippled creature)
- Synthetic data generation (256 records)
- Scoring (baseline and crippled creature)

Intelligent design module benchmarks (6 benchmarks):

- Creature creation and validation
- Activation (single and varied inputs)
- Synthetic data generation (500 records)
- Scoring (scoreDir and scoreCreature)

All quality checks (`./quality.sh`) pass cleanly — lint, formatting, unit tests, and example
programs.

## Test Plan

- Benchmarks verified by running `deno bench --allow-read --allow-write --allow-env` successfully
- Existing unit tests unmodified and passing (115 tests)
- Full quality gate (`./quality.sh`) passes with no failures
