# 🔀 Crossover — Breeding Two Creatures + Factory-Seeded Evolution

**The audit (#213) reframes this example.** The breeding demo (parents A and B → offspring) is
preserved because parents are exempt hand-crafted state per `AGENTS.md` — they are the demo's whole
point. On top of that, the example runs an `evolveDir` against the same `.bin` training set so the
published evolution genuinely _learns_ the network structure.

## 🏭 Factory-seeded evolution (issue #537)

Under the
[factory-adoption tracker (#517)](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/517) the
evolution seed is now built via the data-derived NEAT-AI factory
`Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })`
([`buildFactorySeedCreature`](crossover_example.ts)) instead of a bare `new Creature(3, 1)`. From
problem-intrinsic facts only, the factory:

- couples a **LOGISTIC output** activation to the cost (NEAT-AI #2793) — matching Parent A's
  `(0, 1)` sigmoid labels;
- sizes a **conservative hidden-capacity budget** from the problem shape (Heaton's rule);
- scales the random weight init **per activation** (He / Xavier).

**Only the seed changes; evolution is untouched** — `evolveDir` keeps its default scoring and the
example converges exactly as before (or faster, from the better-scaled seed). Seed weights and
biases stay random; only topology and scaling are factory-derived, and all structural growth beyond
the seed still comes from the unchanged mutation operators. This is a **deliberate, milestone-
sanctioned departure** from the no-warm-start policy documented in `AGENTS.md` and
[`docs/factory_adoption.md`](../docs/factory_adoption.md). The bare-constructor seed is retained as
[`buildRandomSeedCreature`](crossover_example.ts) — the historical baseline for test / resume
fixtures.

### Cost / activation coupling for this example

Parent A is the **label oracle**: its output neuron is a LOGISTIC sigmoid, so every `.bin` target
lives in `(0, 1)`. `BINARY_CROSS_ENTROPY` is the cost whose factory output activation is a LOGISTIC
sigmoid — the exact activation the labelled targets assume. This is the same cost / activation
pairing used by the merged XOR (#520), adaptive_mutation (#533), discovery_at_scale (#535), and
memetic_evolution (#536) adoptions.

Under [#302](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/302) the per-generation
telemetry hook was removed in favour of NEAT-AI's milestone-only telemetry surface (see
[#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298)). The README now references a
single milestone summary SVG sourced from `Creature.evolveDir`'s return value via the shared
[`renderEvolveDirSummarySvg`](../common/evolve_dir_summary.ts) helper.

```mermaid
flowchart TD
    PA["👩 Parent A (hand-crafted)<br/>TANH / LOGISTIC"]
    PB["👨 Parent B (hand-crafted)<br/>SELU / LeakyReLU"]
    DATA["📦 Binary .bin training set<br/>(Parent A as label oracle)"]
    SCORE["📏 Score Both Parents"]
    CROSS["🔀 Crossover<br/>mother-keep + father-50%<br/>weights blended"]
    OFF["🐣 Offspring"]
    SEED["🌱 Creature.forDataset(records,<br/>{ cost: BINARY_CROSS_ENTROPY })<br/>factory seed — LOGISTIC output,<br/>factory hidden layer, He/Xavier init"]
    EVO["🧪 Creature.evolveDir(...)<br/>single call, forward-only,<br/>targetError=0.02, timeoutMinutes=15"]
    SUMMARY["📦 EvolveDirSummary<br/>(error, score, time, generation<br/>+ seed/final topology)"]
    OUT["📈 evolution_summary.svg"]

    PA --> DATA
    DATA --> SCORE
    PA --> SCORE
    PB --> SCORE
    SCORE --> CROSS
    CROSS --> OFF
    DATA --> SEED
    DATA --> EVO
    SEED --> EVO
    EVO --> SUMMARY
    SUMMARY --> OUT

    style PA fill:#bd10e0,stroke:#333,color:#fff
    style PB fill:#4a90d9,stroke:#333,color:#fff
    style DATA fill:#f5a623,stroke:#333,color:#fff
    style SCORE fill:#f39c12,stroke:#333,color:#fff
    style CROSS fill:#e74c3c,stroke:#333,color:#fff
    style OFF fill:#7ed321,stroke:#333,color:#fff
    style SEED fill:#9013fe,stroke:#333,color:#fff
    style EVO fill:#1abc9c,stroke:#333,color:#fff
    style SUMMARY fill:#34495e,stroke:#333,color:#fff
    style OUT fill:#50e3c2,stroke:#333,color:#fff
```

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies (Stanley & Miikkulainen 2002). _SVG_
= Scalable Vector Graphics.

`crossover_example.ts` runs end-to-end:

1. Build two hand-crafted parent creatures with different activation lineages (TANH/LOGISTIC vs
   SELU/LeakyReLU). Parents are deliberately hand-crafted — that is the breeding demo's exempt state
   per `AGENTS.md`.
2. Generate a binary `.bin` training set from Parent A as label oracle.
3. Score both parents against the `.bin` set.
4. Run `performCrossover(parentA, parentB)` — mother's neurons are always kept, father's unique
   neurons are included with 50% probability, matching weights/biases are blended (averaged).
5. Run **factory-seeded** evolution: build the seed via
   `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })` (LOGISTIC output, factory-sized
   hidden layer, He/Xavier weight-init scaling — no pre-built `network.json`, no warm-started
   weights) and make a **single** `Creature.evolveDir(...)` call in forward-only mode until either
   `targetError` is reached or the `timeoutMinutes: 15` backstop fires. The `evolveDir` call is
   unchanged by the factory adoption.
6. Render a milestone summary SVG from the `evolveDir` return value plus the seed and final creature
   topology via `renderEvolveDirSummarySvg`.

## ⚙️ Why `evolveDir` (not per-step `activate()`)

The training labels are fully pre-generated as a binary `.bin` file from Parent A's deterministic
outputs — there is no per-step interactive simulation. That puts the example squarely in the
"binary-data → `evolveDir({"forward-only": true})`" category mandated by issue #213, so the runner
uses `Creature.evolveDir(dataDir, options)` (which defaults to forward-only when `feedbackLoop` is
not set) for orders-of-magnitude faster training than per-call `activate()`.

## 📈 Latest measured run (`./crossover/run.sh`)

The chart is sourced from `Creature.evolveDir`'s return value plus the seed and final creature's
topology — no per-generation telemetry hook.

![Crossover — evolveDir run summary](../docs/screenshots/crossover/evolution_summary.svg)

### Crossover comparison

| Creature                            | Score    |
| ----------------------------------- | -------- |
| Parent A (label oracle)             | 1.000000 |
| Parent B (different lineage)        | varies\* |
| Crossover offspring                 | varies\* |
| **Factory-seeded evolved champion** | varies\* |

\*See the runner's "Comparison" section for the latest measurement.

## 🧪 What "reasonable solution" means here

The factory-seeded evolved champion's score on the binary `.bin` training set should approach Parent
A's score (higher is better; theoretical maximum is 1.0). The final per-record error satisfies the
`targetError = 0.02` stop condition when the run succeeds — the champion is producing labels within
`2 × 10⁻²` of Parent A's outputs on average. That is a reasonable solution to the labelled task: a
creature that started from a factory-derived seed (a LOGISTIC output coupled to the cost plus a
conservative hidden layer, weights still random) has evolved into a network that approximates Parent
A's nonlinear sigmoid-of-sigmoids behaviour _without ever seeing Parent A's topology_.

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
- `creatures/evolved.json` — The factory-seeded evolved champion (audit deliverable).
- `output/` — Additional offspring from repeated crossover for inspection.

The milestone summary SVG is committed under `docs/`:

- [`docs/screenshots/crossover/evolution_summary.svg`](../docs/screenshots/crossover/evolution_summary.svg)

## 🧰 NEAT-AI Features Used

**Acronym.** _NEAT_ = NeuroEvolution of Augmenting Topologies (the Stanley & Miikkulainen 2002
algorithm).

The audit rolls two things into one example:

- **The breeding demo** — `performCrossover` shows NEAT-AI's mother-keep + father-50% blending — the
  simplest of NEAT-AI's breeding strategies (subgraph transplantation, cosine-similarity alignment,
  and diversity-driven cross-population pairing all live upstream).
- **Factory-seeded evolution** — `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })`
  builds the seed (LOGISTIC output coupled to the cost, factory-sized hidden layer, He/Xavier init),
  fed to `Creature.evolveDir(...)` over the binary `.bin` training stream (per
  [`docs/binary_training_stream.md`](../docs/binary_training_stream.md)). The bare
  `new Creature(input, output)` baseline lives on as `buildRandomSeedCreature` for fixtures.

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
- **Milestone-only telemetry** — the chart is sourced from `evolveDir`'s return value via the shared
  `renderEvolveDirSummarySvg` helper, matching NEAT-AI's supported telemetry surface (see
  [`AGENTS.md`](../AGENTS.md)).
