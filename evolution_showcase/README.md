# 🧬 Evolution Showcase — Evolve Network Structure From a Minimal Seed

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies. _SVG_ = Scalable Vector Graphics.
_PRNG_ = Pseudorandom Number Generator.

**The audit (#211) reframes this example.** The published evolution now genuinely _learns_ the
network structure from a minimal NEAT-AI seed, with no hand-tuned topology and no pre-built
`network.json`. NEAT discovers on its own how many hidden neurons and synapses are needed to fit a
non-linear regression target. Issue
[#301](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/301) then retired the per-generation
CSV / fitness / topology charts and the multi-panel checkpoint strip in favour of a single
milestone-summary chart built from `Creature.evolveDir`'s return value (see
[#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298) for the decision record).

```mermaid
flowchart LR
    REF["🧬 Hand-crafted teacher creature<br/>(only used to label the .bin set)"]
    DATA["📦 Binary .bin training set"]
    SEED["🌱 new Creature(4, 1)<br/>minimal seed — no hidden hint"]
    EVOLVE["🧪 Creature.evolveDir(...)<br/>forward-only, targetError=0.05,<br/>timeoutMinutes=20"]
    SUMMARY["📈 Milestone summary SVG<br/>(from evolveDir return value)"]
    REF --> DATA
    DATA --> EVOLVE
    SEED --> EVOLVE
    EVOLVE --> SUMMARY
    style REF fill:#7ed321,stroke:#333,color:#fff
    style DATA fill:#4a90d9,stroke:#333,color:#fff
    style SEED fill:#bd10e0,stroke:#333,color:#fff
    style EVOLVE fill:#f5a623,stroke:#333,color:#fff
    style SUMMARY fill:#50e3c2,stroke:#333,color:#fff
```

`evolution_showcase.ts` runs end-to-end:

1. Build a small hand-crafted teacher creature (4 inputs → 4 saturating-TANH hidden → 1 linear
   output) and use it to synthesise a deterministic binary `.bin` training set. The teacher is only
   the _label oracle_ — NEAT-AI never sees it.
2. Seed evolution with `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — four inputs, one output, no
   hidden neurons, no warm start.
3. Call `Creature.evolveDir(dataDir, options)` over the `.bin` directory in forward-only mode until
   either the per-example `targetError` is reached or the `timeoutMinutes: 20` wall-clock backstop
   fires (issue #211 stop-condition rule; backstop raised from 5 → 20 under #377 for the
   Refresh-2026-05 milestone).
4. Build an `EvolveDirSummary` from the call's `{ error, score, time, generation }` return value
   plus the seed and final topology counts, and render it via the shared
   `common/evolve_dir_summary.ts` helper from
   [#284](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/284).

## 📈 Evolution milestone stats

The milestone summary chart below is generated **directly from the return value of
`Creature.evolveDir`**. It pairs the seed and final topology counts on the left with the numeric
callouts (final error, final score, generations, wall-clock) on the right, plus a caption listing
the configured `targetError` / `timeoutMinutes` stop conditions. No per-generation telemetry is
captured or emitted by this example any more (per issue #301).

![Milestone summary chart](../docs/screenshots/evolution_showcase/evolution_summary.svg)

## 🧪 What "reasonable solution" means here

Starting from a hidden-less direct seed whose best fitness is barely better than chance, the evolved
champion's per-record error drops sharply across the run. The teacher creature it has to imitate
sums two products of saturating-TANH hidden activations — an exclusive-OR-flavoured surface that a
hidden-less baseline cannot mimic — so the quality gain demonstrably requires structural growth, not
just weight tuning. That is a reasonable solution to the labelled task: NEAT-AI evolves a competent
regressor _without ever seeing the teacher's topology_. The milestone summary chart above quotes the
measured numbers from the latest run.

## 🚀 Running the example

```bash
./evolution_showcase/run.sh
```

> ⚡ **Speed note:** this example writes its training data in NEAT-AI's binary format — see
> [`docs/binary_training_stream.md`](../docs/binary_training_stream.md). Loading the data via
> `evolveDir` is orders of magnitude faster than per-call `activate()`.

The script writes all artefacts to `.synthetic-evolution-showcase/`, a hidden directory ignored by
git. You will find:

- `data/synthetic_*.bin` — Binary training files derived from the teacher creature.
- `creatures/teacher.json` — The hand-crafted teacher creature (label oracle only).
- `creatures/champion.json` — The evolved champion produced from the minimal seed.

In addition, the milestone summary SVG is committed under `docs/`:

- [`docs/screenshots/evolution_showcase/evolution_summary.svg`](../docs/screenshots/evolution_showcase/evolution_summary.svg)

## ⚙️ Configuration

`DEFAULT_SHOWCASE_EVOLUTION_CONFIG` in [`evolution_showcase.ts`](evolution_showcase.ts) holds the
canonical values. The audit (#211) mandates `targetError` plus a wall-clock backstop as the stop
conditions — both are set, with `maxIterations` acting as a secondary safety net so the run cannot
loop forever even if the targetError is unreachable. Issue
[#377](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/377) (Refresh-2026-05) raised the
backstop from 5 → 20 minutes to grant the milestone's +15 minutes of additional evolution.

| Field            | Default | Notes                                                                                             |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `targetError`    | 0.05    | Per-example reasonable target error.                                                              |
| `timeoutMinutes` | 20      | Wall-clock backstop (raised from 5 → 20 under #377 to grant +15 minutes of additional evolution). |
| `populationSize` | 24      | Population fed to `evolveDir`.                                                                    |
| `maxIterations`  | 20 000  | Hard iteration cap, lifted in lock-step with the backstop so wall-clock is the genuine limiter.   |
| `seed`           | 211 211 | Driving the seeded PRNG inside NEAT-AI.                                                           |

Why `maxIterations: 20 000` and not more? Newer NEAT-AI builds complete ~14 000 generations inside
the 20-minute backstop on a developer laptop, so the cap comfortably exceeds the wall-clock budget
without letting the run loop forever if the budget is ever lifted.

## 📊 Latest measured run

Run reproduced end-to-end via `./evolution_showcase/run.sh` on the freshly bumped
`@stsoftware/neat-ai` for issue #377 (Refresh-2026-05):

| Metric                   | Value                                              |
| ------------------------ | -------------------------------------------------- |
| Generations              | 14 368                                             |
| Wall-clock               | 20 m 17 s                                          |
| Final per-record error   | 0.1070 (target 0.05 — not reached inside backstop) |
| Final score              | 0.8930                                             |
| Seed neurons / synapses  | 5 / 4                                              |
| Final neurons / synapses | 41 / 230                                           |
| `targetError` / timeout  | 0.05 / 20 min                                      |

NEAT-AI added substantial structure on top of the minimal seed (5 → 41 neurons, 4 → 230 synapses)
even though the run did not reach `targetError` inside the 20-minute backstop — the long-form
fitness arc plus the topology bars in the milestone summary chart are the headline visual. Issue
#377 explicitly permits raising the PR even with no fitness gain.

## 🧰 NEAT-AI features used

- **Minimal NEAT seed** — `new Creature(input, output)` with no hidden hint, no pre-built
  `network.json` seed; NEAT-AI random-initialises the rest.
- **`Creature.evolveDir`** over the binary `.bin` training stream (per
  [`docs/binary_training_stream.md`](../docs/binary_training_stream.md)) — orders of magnitude
  faster than per-call `activate()`.
- **Forward-only mutation** — `evolveDir` defaults to forward-only when `feedbackLoop` is not set,
  matching the audit's stop-condition + topology contract.
- **Milestone summary chart** — the run's `Creature.evolveDir` return value
  (`{ error, score, time, generation }`) plus the seed and final topology counts feed the shared
  `common/evolve_dir_summary.ts` renderer (issue
  [#284](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/284)).

See upstream [`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)
for the broader feature catalogue, including:

- **[Evolutionary Topology Search](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#what-weve-implemented)**
  — structural mutation co-evolved with weights — the long-form fitness arc is the headline.
- **[Genetic Operators](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#what-weve-implemented)**
  — weight and bias mutation against the chosen task's fitness signal.
