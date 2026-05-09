# 🔀 Crossover — Breeding Two Creatures + Minimal-Seed Evolution

**The audit (#213) reframes this example.** The breeding demo (parents A and B → offspring) is
preserved because parents are exempt hand-crafted state per `AGENTS.md` — they are the demo's whole
point. On top of that, the example now runs a **minimal-seed** `evolveDir` against the same `.bin`
training set so the published evolution genuinely _learns_ the network structure with no hidden hint
and no warm start. The README quotes the _measured_ numbers from the latest run only.

```mermaid
flowchart TD
    PA["👩 Parent A (hand-crafted)<br/>TANH / LOGISTIC"]
    PB["👨 Parent B (hand-crafted)<br/>SELU / LeakyReLU"]
    DATA["📦 Binary .bin training set<br/>(Parent A as label oracle)"]
    SCORE["📏 Score Both Parents"]
    CROSS["🔀 Crossover<br/>mother-keep + father-50%<br/>weights blended"]
    OFF["🐣 Offspring"]
    SEED["🌱 new Creature(3, 1)<br/>minimal seed — no hidden hint"]
    EVO["🧪 Creature.evolveDir(...)<br/>forward-only, targetError=0.02,<br/>timeoutMinutes=5"]
    OUT["🏆 Evolved champion + CSV + 2 SVGs"]

    PA --> DATA
    DATA --> SCORE
    PA --> SCORE
    PB --> SCORE
    SCORE --> CROSS
    CROSS --> OFF
    DATA --> EVO
    SEED --> EVO
    EVO --> OUT

    style PA fill:#bd10e0,stroke:#333,color:#fff
    style PB fill:#4a90d9,stroke:#333,color:#fff
    style DATA fill:#f5a623,stroke:#333,color:#fff
    style SCORE fill:#f39c12,stroke:#333,color:#fff
    style CROSS fill:#e74c3c,stroke:#333,color:#fff
    style OFF fill:#7ed321,stroke:#333,color:#fff
    style SEED fill:#9013fe,stroke:#333,color:#fff
    style EVO fill:#1abc9c,stroke:#333,color:#fff
    style OUT fill:#50e3c2,stroke:#333,color:#fff
```

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies (Stanley & Miikkulainen 2002). _CSV_
= Comma-Separated Values. _SVG_ = Scalable Vector Graphics.

`crossover_example.ts` runs end-to-end:

1. Build two hand-crafted parent creatures with different activation lineages (TANH/LOGISTIC vs
   SELU/LeakyReLU). Parents are deliberately hand-crafted — that is the breeding demo's exempt state
   per `AGENTS.md`.
2. Generate a binary `.bin` training set from Parent A as label oracle.
3. Score both parents against the `.bin` set.
4. Run `performCrossover(parentA, parentB)` — mother's neurons are always kept, father's unique
   neurons are included with 50% probability, matching weights/biases are blended (averaged).
5. Run **minimal-seed** evolution: seed `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (no hidden hint,
   no pre-built `network.json`, no warm start) and call `Creature.evolveDir(dataDir, options)` over
   the same `.bin` set in forward-only mode until either `targetError` is reached or the
   `timeoutMinutes: 5` backstop fires.
6. Capture per-generation telemetry via `onTrainingEvent` and emit a CSV plus two SVG charts.

## ⚙️ Why `evolveDir` (not per-step `activate()`)

The training labels are fully pre-generated as a binary `.bin` file from Parent A's deterministic
outputs — there is no per-step interactive simulation. That puts the example squarely in the
"binary-data → `evolveDir({"forward-only": true})`" category mandated by issue #213, so the runner
uses `Creature.evolveDir(dataDir, options)` (which defaults to forward-only when `feedbackLoop` is
not set) for orders-of-magnitude faster training than per-call `activate()`.

## 📈 Latest measured run (`./crossover/run.sh`)

> The numbers below come from the most recent local run committed alongside this README. They are
> **measured, not estimated**, per the audit rule in #213.

| Metric                    | Value                 |
| ------------------------- | --------------------- |
| Total generations         | 403                   |
| Wall-clock                | 34.0 s                |
| Final best fitness        | 0.9803                |
| Final per-record error    | 0.0197                |
| Seed neurons / synapses   | 4 / 3                 |
| Final neurons / synapses  | 13 / 34               |
| Stop condition that fired | `targetError` reached |

Topology genuinely grew: NEAT-AI added **9 hidden neurons** and **31 synapses** on top of the
minimal seed. The CSV and the two SVGs below show the trajectory across all 403 generations.

### Best vs mean fitness per generation

![Best vs mean fitness](../docs/screenshots/crossover/fitness.svg)

### Score, neuron, and synapse counts per generation

![Score / neurons / synapses](../docs/screenshots/crossover/topology.svg)

### Per-generation CSV

[`docs/data/crossover/evolution.csv`](../docs/data/crossover/evolution.csv) holds the full
per-generation telemetry with the schema mandated by the audit:

```text
generation,best_fitness,mean_fitness,neuron_count,synapse_count
```

### Crossover comparison (latest run)

| Creature                          | Score        |
| --------------------------------- | ------------ |
| Parent A (label oracle)           | 1.000000     |
| Parent B (different lineage)      | 0.901616     |
| Crossover offspring               | varies\*     |
| **Minimal-seed evolved champion** | **0.980252** |

\*Offspring score depends on the deterministic crossover outcome on the latest run; see the runner's
"Comparison" section for the latest measurement.

## 🧪 What "reasonable solution" means here

The minimal-seed evolved champion's best fitness is **0.9803** against the binary `.bin` training
set (higher is better; the theoretical maximum is 1.0). The final per-record error of **0.0197**
satisfies the `targetError = 0.02` stop condition — the champion is producing labels within
`2 × 10⁻²` of Parent A's outputs on average. That is a reasonable solution to the labelled task: a
creature that started as 4 neurons and 3 synapses (no hidden layer at all) has evolved into a
13-neuron, 34-synapse network that approximates Parent A's nonlinear sigmoid-of-sigmoids behaviour
_without ever seeing Parent A's topology_.

## 🚀 Running the Example

```bash
./crossover/run.sh
```

The script writes all artefacts to `.synthetic-crossover/`, a hidden directory ignored by git. You
will find:

- `data/` — Binary training data for scoring (Parent A as label oracle).
- `creatures/parent_a.json` — The first parent creature (hand-crafted demo state).
- `creatures/parent_b.json` — The second parent creature (hand-crafted demo state).
- `creatures/offspring.json` — The crossover offspring.
- `creatures/evolved.json` — The minimal-seed evolved champion (audit deliverable).
- `output/` — Additional offspring from repeated crossover for inspection.

In addition, the per-generation telemetry artefacts are committed under `docs/`:

- [`docs/data/crossover/evolution.csv`](../docs/data/crossover/evolution.csv)
- [`docs/screenshots/crossover/fitness.svg`](../docs/screenshots/crossover/fitness.svg)
- [`docs/screenshots/crossover/topology.svg`](../docs/screenshots/crossover/topology.svg)

## 🧰 NEAT-AI Features Used

**Acronym.** _NEAT_ = NeuroEvolution of Augmenting Topologies (the Stanley & Miikkulainen 2002
algorithm).

The audit rolls two things into one example:

- **The breeding demo** — `performCrossover` shows NEAT-AI's mother-keep + father-50% blending — the
  simplest of NEAT-AI's breeding strategies (subgraph transplantation, cosine-similarity alignment,
  and diversity-driven cross-population pairing all live upstream).
- **Minimal-seed evolution** — `new Creature(input, output)` with no hidden hint, fed to
  `Creature.evolveDir(...)` over the binary `.bin` training stream (per
  [`docs/binary_training_stream.md`](../docs/binary_training_stream.md)), with per-generation
  telemetry captured via `onTrainingEvent`.

Features exercised (links go to upstream
[`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)):

- **[Advanced Breeding Strategies](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#10--advanced-breeding-strategies)**
  — mother-keep + father-50% blending — the simplest of NEAT-AI's breeding strategies.
- **[Historical Marking](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#what-weve-implemented)**
  — gene history (a standard-NEAT primitive) makes compatible crossover possible across topologies.
- **`Creature.evolveDir`** — orders of magnitude faster than per-call `activate()` for any problem
  whose labels can be pre-generated as a binary `.bin` stream.
- **Forward-only mutation** — `evolveDir` defaults to forward-only when `feedbackLoop` is not set,
  matching the audit's stop-condition + topology contract.
- **`onTrainingEvent` callback** — feeds per-generation telemetry into the CSV and the two SVG
  charts without slowing the run.
