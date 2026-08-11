# intelligent_design: minimal seed + measured telemetry (#214)

## Summary

Audits the `intelligent_design` example so the published evolution genuinely _learns_ the network
structure from a minimal NEAT-AI seed and the README embeds real measured telemetry from the latest
run. Closes #214.

The pre-audit example seeded a hand-crafted reference creature (4 inputs, 5 hidden, 1 output)
straight into the squash improvement scan. After the audit:

- The reference creature is now used **only** as the label oracle that synthesises the binary `.bin`
  training set. NEAT-AI never sees it.
- The seed passed to NEAT-AI is `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — no hidden-layer hint, no
  pre-built `network.json`, no hand-tuned shape.
- Evolution runs through `Creature.evolveDir(dataDir, options)` over the binary `.bin` directory in
  forward-only mode (no `feedbackLoop` key).
- Stop conditions are `targetError = 0.005` plus `timeoutMinutes: 5` (the issue #214 backstop).
- Per-generation telemetry is captured via `onTrainingEvent` and emitted as a CSV plus two SVG
  charts.
- The original "intelligent design" framing is preserved by running `scanForSquashImprovements` on
  the **evolved** champion.

## Evidence

### Latest measured run (`./intelligent_design/run.sh`)

| Metric                    | Value                           |
| ------------------------- | ------------------------------- |
| Total generations         | 32                              |
| Evolution wall-clock      | 1.1 s                           |
| Final best fitness        | 0.9973                          |
| Final per-record error    | 0.0027 (target met)             |
| Seed neurons / synapses   | 5 / 4                           |
| Final neurons / synapses  | 6 / 9                           |
| Stop condition that fired | `targetError` reached           |
| Squash scan (GELU)        | 1 neuron tested, 0 improvements |

Topology genuinely grew: NEAT-AI added **1 hidden neuron** and **5 synapses** on top of the minimal
direct-only seed. The committed `evolution.csv` shows this trajectory across all 32 generations and
the unit-test suite asserts it.

### Per-generation artefacts committed

- [`docs/data/intelligent_design/evolution.csv`](data/intelligent_design/evolution.csv) — 32 rows +
  header, audit-mandated schema `generation,best_fitness,mean_fitness,neuron_count,synapse_count`.
- [`docs/screenshots/intelligent_design/fitness.svg`](screenshots/intelligent_design/fitness.svg) —
  best vs mean fitness per generation.
- [`docs/screenshots/intelligent_design/topology.svg`](screenshots/intelligent_design/topology.svg)
  — score / neurons / synapses per generation.

### Workflow diagram

```mermaid
flowchart LR
    REF[Hand-crafted reference] --> DATA[.bin training set]
    SEED[new Creature(4, 1)] --> EVOLVE
    DATA --> EVOLVE[Creature.evolveDir]
    EVOLVE --> CHAMPION[Evolved champion]
    CHAMPION --> SCAN[scanForSquashImprovements]
    EVOLVE --> CSV[CSV + 2 SVGs]
```

## Test Plan

New tests in `intelligent_design/improve_squash_example_test.ts` (10 added, 14 pre-existing all
still pass — 24 total):

- `INPUT_COUNT and OUTPUT_COUNT are positive integers matching the runner seed` — locks in the
  minimal-seed contract.
- `DEFAULT_MINIMAL_SEED_EVOLUTION_CONFIG honours the audit's stop-condition rule` — verifies
  `targetError`, `timeoutMinutes`, `populationSize`, `maxIterations` defaults.
- `formatEvolutionCsv emits the schema mandated by issue #214` — asserts the CSV header and row
  encoding.
- `formatEvolutionCsv survives non-finite fitness without throwing` — handles `±Infinity`/`NaN`
  cleanly.
- `rowsToFitnessSamples renames meanFitness to avgFitness` — chart-helper adapter contract.
- `rowsToEvolutionSamples maps neuron and synapse counts onto chart fields` — chart-helper adapter
  contract.
- `runMinimalSeedEvolution rejects non-positive config values` — input validation.
- `runMinimalSeedEvolution captures per-generation telemetry from a minimal seed` — end-to-end
  contract.
- `runMinimalSeedEvolution leaves the passed-in creature as the champion` — `evolveDir` in-place
  mutation contract.
- `committed evolution.csv shows the topology genuinely changing across generations` — guards the
  audit's "topology must change" acceptance criterion against the committed CSV.

Other validation:

- `deno fmt --check` — passes (321 files).
- `deno lint` — passes (127 files).
- `deno check **/*.ts` — passes.
- `./intelligent_design/run.sh` — runs end-to-end in ~3 s and writes the committed artefacts.
- `docs/archive_test.ts` — updated to allowlist `pr-summary-212.md` and `pr-summary-214.md`.

The `crispr_injection_test.ts::runCrisprExperiment is deterministic for the same seed` test was
already failing on `Develop` before this branch (verified by `git stash` + re-run); it is unrelated
to this change and is left for a separate fix.
