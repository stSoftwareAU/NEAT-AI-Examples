## Summary

Add a third example demonstrating crossover (breeding) — a fundamental NEAT-AI neuroevolution
operation where two parent creatures are combined to produce offspring. This rounds out the example
suite to cover the three main NEAT-AI workflows: mutation-based discovery, intelligent design, and
crossover breeding. Closes #11.

## Changes

- **`crossover/crossover_example.ts`** — Main example program that creates two parent creatures with
  different architectures (TANH/LOGISTIC vs SELU/LeakyReLU), generates synthetic training data,
  performs crossover to produce offspring, scores and compares all creatures, and optionally evolves
  the offspring for several generations.
- **`crossover/crossover_example_test.ts`** — 21 unit tests covering all exported functions:
  `createParentA`, `createParentB`, `generateSyntheticData`, `scoreCreature`, and
  `performCrossover`.
- **`crossover/run.sh`** — Runner script matching the pattern of existing examples.
- **`quality.sh`** — Updated to include the crossover example and clean up its synthetic data.
- **`README.md`** — Added crossover example documentation section.
- **`AGENTS.md`** — Updated project structure to include the crossover directory.

## Evidence

This is a CLI/library example with no visual UI. Evidence of correctness:

- All 88 unit tests pass (21 new crossover tests + 67 existing tests)
- `./quality.sh` passes cleanly (lint, format, tests, all 4 example programs)
- Runner script produces expected output showing parent creation, crossover, scoring, and evolution

## Test Plan

- 21 new tests in `crossover/crossover_example_test.ts`:
  - `createParentA` — validates creature structure (3 inputs, 1 output), validity, finite output,
    determinism, hidden neuron squashes
  - `createParentB` — same validations plus verification of different squash functions from parent A
  - Parents produce different outputs for the same input
  - `SYNTHETIC_CONFIG` has expected properties
  - `generateSyntheticData` — file creation, correct size, determinism, valid float32 values
  - `scoreCreature` — returns finite numeric score, deterministic results
  - `performCrossover` — returns valid creature or undefined, offspring produces finite output,
    offspring can be scored against data
