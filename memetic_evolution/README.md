# 🧠 Memetic Evolution — Seeding From the Fittest Archive

`memetic_evolution.ts` demonstrates **memetic seeding**: recording the weights and biases of the
fittest creatures observed so far and using them to seed future generations. The example runs two
evolutions on the same synthetic weight-tuning task — one with memetic seeding enabled, one without
— and renders both fitness curves overlaid so the advantage of seeding from a curated archive is
visible at a glance.

Per the audit in [issue #216](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/216), the
runner now follows the conceptual memetic-vs-control comparison with a second stage that genuinely
exercises NEAT-AI: it seeds `new Creature(2, 1)` (no hidden hint, no `network.json`, no hand-tuned
shape) and runs `Creature.evolveDir(...)` over a binary `.bin` training set, capturing
per-generation telemetry the README quotes verbatim from the latest local run.

![Memetic vs control fitness comparison](../docs/screenshots/memetic_evolution.svg)

## 📈 Latest Measured Run (Minimal-Seed `evolveDir` Stage)

The numbers below come directly from the latest local run of `./memetic_evolution/run.sh` — no
estimates, no qualifiers.

| Metric                    | Value                                |
| ------------------------- | ------------------------------------ |
| Generations               | 147 (solved — `targetError` reached) |
| Wall-clock                | 2.1 s                                |
| Final per-record error    | 0.0049                               |
| Final best fitness        | 0.9951                               |
| Held-out score (-MSE)     | -0.004863                            |
| Seed neurons / synapses   | 3 / 2                                |
| Final neurons / synapses  | 6 / 12                               |
| `targetError`             | 0.005                                |
| `timeoutMinutes` (safety) | 5                                    |

Topology genuinely changed: NEAT added 3 hidden neurons (3 → 6) and grew the synapse count from 2 to
12 across 147 generations starting from the minimal direct-only seed. The intermediate checkpoints
visible in the CSV are `(3,2) → (4,5) → (5,8) → (6,11) → (6,12)`.

- Per-generation telemetry CSV:
  [`docs/data/memetic_evolution/evolution.csv`](../docs/data/memetic_evolution/evolution.csv)
- Schema: `generation, best_fitness, mean_fitness, neuron_count, synapse_count`

![Memetic Evolution — Best vs Mean Fitness](../docs/screenshots/memetic_evolution/fitness.svg)

![Memetic Evolution — Topology Growth (neuron and synapse counts per generation)](../docs/screenshots/memetic_evolution/topology.svg)

## 🚀 How to Run

```bash
./memetic_evolution/run.sh
```

The runner:

1. Runs the conceptual memetic-vs-control simulation on the synthetic weight-tuning task and writes
   the dual-curve chart to `docs/screenshots/memetic_evolution.svg`.
2. Writes the same synthetic dataset as a Float32 `.bin` file under
   `.synthetic-memetic-evolution/data/` so NEAT-AI can consume it via `Creature.evolveDir(...)`.
3. Seeds NEAT-AI with `new Creature(2, 1)` — minimal direct-only topology.
4. Runs `Creature.evolveDir(dataDir, neatOptions)` with `targetError = 0.005` and
   `timeoutMinutes = 5`. The evolution loop is split into 25-iteration chunks so per-generation
   telemetry picks up structural growth at fine resolution.
5. Writes the per-generation CSV, the fitness chart, the topology chart, and the champion creature
   JSON. The whole run completes in seconds on a developer machine — well under the 5-minute
   backstop.

### Why `evolveDir` rather than per-step `activate()`?

The training task is a pre-generated binary `(input, target)` set — the canonical "binary-data +
`evolveDir`" categorisation from the parent audit ([issue #203]). `evolveDir` exercises NEAT-AI's
full feature set (back-propagation, structure discovery, WASM/SIMD/GPU parallelism) and is orders of
magnitude faster than per-call `activate()` for supervised regression. Per-step `activate()` is
reserved for interactive simulations / RL agents where the next observation depends on the previous
action.

[issue #203]: https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/203

## 🧠 What is memetic seeding?

In population-based search, **elitism** (always keeping the single best creature seen so far) is the
standard hedge against losing progress to bad mutations. Memetic seeding generalises that idea:
maintain a **library** (or _archive_) of the top-K weight vectors observed so far, ranked by their
**averaged** fitness across many evaluations, and periodically re-seed the population by mutating
samples drawn from that archive.

| Aspect          | Pure elitism                                    | Memetic seeding                                                |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Retained memory | Single best creature                            | Top-K best **distinct** weight vectors                         |
| Robustness      | Loses progress when a noisy fitness picks a dud | Averaged ranking smooths out single-evaluation flukes          |
| Diversity       | All offspring are perturbations of one parent   | Offspring also blend in mutations of historical elites         |
| Recovery        | Stuck once the elite gets noise-fooled to a dud | Archive can re-seed the population with genuinely-good weights |
| Cost            | One extra creature kept across generations      | K extra creatures plus their accumulated fitness statistics    |

## 🔧 How It Works

```mermaid
flowchart TD
    INIT["🎲 Random initial population<br/>(shared between memetic & control)"]
    SCORE["📏 Score on noisy mini-batch"]
    UPDATE["📚 Update memetic archive<br/>(re-evaluate, insert top-K)"]
    SEED{"Seeding<br/>generation?"}
    REPLACE["🌱 Replace worst N members<br/>with mutated archive samples"]
    NEXT["🧬 Build next gen<br/>(elite + perturbed elite)"]
    MARKER["🟢 Record seeding marker"]

    INIT --> SCORE
    SCORE --> UPDATE
    UPDATE --> SEED
    SEED -- yes --> REPLACE
    REPLACE --> MARKER
    MARKER --> NEXT
    SEED -- no --> NEXT
    NEXT --> SCORE
```

### The synthetic task

The "creature" is a fixed-topology weight vector for a small network — 2 inputs → 2 TANH hidden → 1
sigmoid output. The full vector has **9 parameters**: 4 input→hidden weights, 2 hidden biases, 2
hidden→output weights, and 1 output bias.

A target weight vector defines the truth: the synthetic dataset is generated by feeding 32
deterministic 2D inputs through that target network. Both algorithms search for the target weights
by minimising mean-squared error.

### Noisy mini-batch evaluation

Every generation each creature is scored on a small mini-batch (default: **2 records**) randomly
sampled from the 32-record dataset. The mini-batch is shared between the two runs at each generation
so they see identical noise — the only behavioural difference is the memetic seeding mechanism.

The mini-batch is small enough that the per-generation "best" creature is sometimes a fluke. This
exposes the failure mode the memetic archive is designed to mitigate:

- **Control run**: keeps the noisy mini-batch elite each generation. Sometimes the elite is a
  worse-true-fitness creature that got lucky on the batch; mutations around that dud waste
  generations.
- **Memetic run**: maintains an archive of the top-K weight vectors ranked by **averaged** observed
  fitness across many generations. The averaged ranking is much more stable, so the archive's top
  entry is a genuinely-fit creature even when the current generation's mini-batch elite is
  misleading. Periodically re-seeding the population from the archive pulls the search back toward
  genuinely-good weights.

### Archive maintenance

```
At each generation:
  1. Re-evaluate every archive entry on the new mini-batch.
     entry.meanFitness ← entry.meanFitness + (observed − entry.meanFitness) / entry.evaluations
  2. Re-sort the archive by meanFitness.
  3. Offer the current top performers as candidates; insert if they
     beat the worst archive entry.
```

The running mean is the standard online-update form, so memory is O(K) regardless of how many
generations the run lasts.

### Seeding schedule

Every `seedingInterval` generations (default: every 3), the memetic algorithm replaces its worst
`seedingReplacementCount` (default: 3) population members with mutated copies of the top archive
entries (round-robin), using a **smaller** mutation strength than normal so the seeded creatures
land near the archive's known-good weights rather than drifting away. Seeded generations are
recorded and rendered as green dashed vertical lines on the fitness chart.

## 📤 Output

- `docs/screenshots/memetic_evolution.svg` — single-panel chart showing:
  - **Blue** memetic fitness curve.
  - **Grey** control fitness curve.
  - **Green dashed** vertical markers at the generations where memetic seeding was applied.
- `docs/screenshots/memetic_evolution/fitness.svg` — best vs mean fitness per generation from the
  minimal-seed `evolveDir` stage (audit #216).
- `docs/screenshots/memetic_evolution/topology.svg` — neuron and synapse counts per generation from
  the minimal-seed `evolveDir` stage.
- `docs/data/memetic_evolution/evolution.csv` — per-generation telemetry CSV with the schema
  `generation, best_fitness, mean_fitness, neuron_count, synapse_count`.
- `.synthetic-memetic-evolution/creatures/champion.json` — final evolved creature for downstream
  inspection.

## 🧪 Tests

`memetic_evolution_test.ts` verifies:

- The forward pass returns finite outputs in `[0, 1]` and rejects malformed weight vectors.
- The synthetic dataset is deterministic for a given seed and is fit perfectly by the target
  weights.
- The mini-batch sampler returns the requested batch size (capped at the dataset length).
- Both runs produce one record per generation with finite fitness values, and only memetic records
  carry the `seeded` flag.
- The same seed produces identical results across runs (full determinism).
- On the default seed the memetic run finishes with a final fitness ≥ control − tolerance, and
  outperforms the control by a measurable margin (the SVG demonstrates the lift visually).
- The rendered SVG is well-formed, embeds both curves as polylines, and includes the seeding-marker
  class so the markers are individually addressable for downstream styling.
- (Audit #216) `INPUT_COUNT`/`OUTPUT_COUNT` match the simulation topology, `writeBinaryDataset`
  emits a Float32 `.bin` of the expected byte count, `runMinimalSeedEvolution` rejects invalid
  configs and emits per-generation telemetry rows from a minimal
  `new Creature(INPUT_COUNT,
  OUTPUT_COUNT)` seed, `formatEvolutionCsv` emits the canonical header,
  and the new fitness / topology SVG renderers produce well-formed output.

## 🧰 NEAT-AI Features Used

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies. _MSE_ = mean squared error. _WASM_ =
WebAssembly. _SIMD_ = single instruction, multiple data. _GPU_ = graphics processing unit. _RL_ =
reinforcement learning.

Memetic Evolution re-seeds the population from an archive of fittest creatures so successful weight
patterns are remembered across generations.

Features exercised (links go to upstream
[`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)):

- **[Memetic Evolution](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#1--memetic-evolution-hybrid-evolution--backpropagation)**
  — memetic recall: the population is re-seeded from an archive of fittest creatures so good weight
  patterns survive structural change.
