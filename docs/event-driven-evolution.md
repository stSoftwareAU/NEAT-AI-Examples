# 🧭 Event-Driven Evolution — Paradigm Split

> **Navigation page.** This doc summarises how the examples in this repository split between
> **supervised batch evolution** (`Creature.evolveDir()`-style) and **reinforcement / event-driven
> evolution** (`Creature.evolveRL()`-style), and links each existing example to its category. The
> full API spec lives upstream — see
> [`stSoftwareAU/NEAT-AI` → `docs/event-driven-evolution.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/docs/event-driven-evolution.md).
> Parent issue: [#230](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/230).

## 🗂️ Two paradigms

NEAT-AI runs the same evolutionary loop in two very different ways. Knowing which fits your problem
is the difference between calling `evolveDir()` and calling `evolveRL()`.

| Example                                                     | Paradigm                        | API                                        |
| ----------------------------------------------------------- | ------------------------------- | ------------------------------------------ |
| [`mnist_classification`](../mnist_classification/README.md) | 📊 Supervised batch             | `Creature.evolveDir()` / `evolveDataSet()` |
| [`xor_classification`](../xor_classification/README.md)     | 📊 Supervised batch             | `Creature.evolveDir()` / `evolveDataSet()` |
| [`stock_market`](../stock_market/README.md)                 | 📊 Supervised batch             | `Creature.evolveDir()` / `evolveDataSet()` |
| [`cart_pole`](../cart_pole/README.md)                       | 🎮 Reinforcement / event-driven | `Creature.evolveRL()`                      |
| [`mountain_car`](../mountain_car/README.md)                 | 🎮 Reinforcement / event-driven | `Creature.evolveRL()`                      |
| [`snake_game`](../snake_game/README.md)                     | 🎮 Reinforcement / event-driven | `Creature.evolveRL()`                      |
| [`maze_navigation`](../maze_navigation/README.md)           | 🎮 Reinforcement / event-driven | `Creature.evolveRL()`                      |
| [`lunar_lander`](../lunar_lander/README.md)                 | 🎮 Reinforcement / event-driven | `Creature.evolveRL()`                      |

```mermaid
flowchart LR
    subgraph supervised ["📊 Supervised batch — evolveDir()"]
        direction TB
        S1["dataset on disk:<br/>(input, target) records"]
        S2["score(creature)<br/>= aggregate error<br/>over every record"]
        S3["select &amp; mutate"]
        S1 --> S2 --> S3 --> S2
    end

    subgraph eventDriven ["🎮 Event-driven — evolveRL()"]
        direction TB
        E1["env: starting observation"]
        E2["activate(observation)<br/>→ action"]
        E3["env.step(action)<br/>→ next observation, reward"]
        E4["fitness =<br/>cumulative reward"]
        E5["select &amp; mutate"]
        E1 --> E2 --> E3 --> E2
        E3 --> E4 --> E5 --> E1
    end

    style supervised fill:#fff3cd,stroke:#f5a623,color:#333
    style eventDriven fill:#d4edda,stroke:#28a745,color:#333
```

## 🔬 Why the split matters

The two paradigms cannot share a scoring loop because they make incompatible assumptions about how
fitness is measured.

- **Supervised batch (`evolveDir()`).** The dataset is a pre-generated, forward-only stream of
  `{input, target}` records sitting on disk as chunked little-endian Float32 (see
  [`docs/binary_training_stream.md`](binary_training_stream.md)). Every creature scores against the
  **same** records; the order is fixed and the inputs do not depend on the creature's previous
  outputs. Fitness is the aggregate error / accuracy over the corpus. Parallelism is trivial because
  each record is independent.

- **Reinforcement / event-driven (`evolveRL()`).** Fitness is a per-trajectory rollout against a
  stepping environment. The next observation is produced by `env.step(action)` and depends on the
  creature's previous output, so once two creatures diverge they see entirely different observation
  streams. There is no on-disk dataset to mmap — the "data" is the trajectory the creature itself
  induces. Fitness is the cumulative reward (or survival score) for the rollout.

Practical consequences:

- A supervised-batch loop cannot score an event-driven example, because the observations a cart-pole
  controller sees on tick `t+1` are determined by what it did on tick `t`. There is no fixed dataset
  to score against.
- An event-driven loop cannot exploit `evolveDir()`'s binary-stream fast path, because the
  trajectory cannot be pre-generated — the creature is part of the data-generating process.
- Both loops parallelise per-creature: each rollout (or each batch sweep) is independent, so workers
  scale linearly with the population size.

## 🚀 What `evolveRL()` provides

This page is just the navigation entry point for Examples readers. The full API spec — argument
shape, termination guards, exception contracts, and worked examples — lives upstream in
[`stSoftwareAU/NEAT-AI`'s `docs/event-driven-evolution.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/docs/event-driven-evolution.md).
Read that doc when you are writing a new event-driven example against the first-class API.

**`evolveRL()` vs `evolveEnv()`.** Upstream `Creature` exposes both. `evolveRL()` takes the
class-shaped `EpisodeAdapter` contract and is what every event-driven example in this repository
calls; `evolveEnv()` is the earlier sibling taking the object-shaped `LegacyEpisodeAdapter`. Both
drive the same `Neat` outer loop with an episodic scorer, so the stop conditions and lifecycle
events match `evolveDir()`. Reach for `evolveRL()`; see the upstream doc for the adapter shapes and
the differences in detail.

**Telemetry is milestone-only.** With `statistics: true`, `evolveRL()` emits an `evolverl_milestone`
event at each milestone generation (1, 2, 5, 10, 20, 50, 100, … then powers of ten) carrying the
best score and topology stats for that milestone, and returns the same milestone sequence as
`milestones` on the run summary. There is no per-generation hook — examples chart these milestones
directly via [`common/milestone_chart.ts`](../common/milestone_chart.ts). See
[#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298) for the canonical decision
record on why every-generation telemetry was retired in favour of milestone-only.

## ✅ Migration status

**All five reinforcement / event-driven examples are migrated.** Each drives `Creature.evolveRL()`
with milestone-only telemetry (`evolverl_milestone` events plus the milestone sequence returned by
the call); see [#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298) for the decision
record. The per-example hand-rolled generation loops are gone.

| Example                                                    | Migration issue                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`cart_pole`](../cart_pole/cart_pole.ts)                   | [#236](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/236)                   |
| [`mountain_car`](../mountain_car/mountain_car.ts)          | [#290](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/290) (supersedes #237) |
| [`snake_game`](../snake_game/snake_game.ts)                | [#238](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/238)                   |
| [`maze_navigation`](../maze_navigation/maze_navigation.ts) | [#239](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/239)                   |
| [`lunar_lander`](../lunar_lander/lunar_lander.ts)          | [#292](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/292) (supersedes #240) |
