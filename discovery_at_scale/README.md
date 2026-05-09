# 🔬 Discovery at Scale — Evolve Network Structure From a Minimal Seed

**The audit (#208) reframes this example.** The published evolution now genuinely _learns_ the
network structure from a minimal NEAT-AI seed, with no hand-tuned topology and no pre-built
`network.json`. NEAT discovers on its own how many hidden neurons and synapses are needed to fit a
larger ground-truth function — and the README quotes the _measured_ numbers from the latest run.

```mermaid
flowchart LR
    REF["🧬 Hand-crafted reference creature<br/>(buildLargeCreature — only used to label the .bin set)"]
    DATA["📦 Binary .bin training set"]
    SEED["🌱 new Creature(6, 3)<br/>minimal seed — no hidden hint"]
    EVOLVE["🧪 Creature.evolveDir(...)<br/>forward-only, targetError=0.005,<br/>timeoutMinutes=5"]
    OUT["🏆 Evolved champion + CSV + 2 SVGs"]
    REF --> DATA
    DATA --> EVOLVE
    SEED --> EVOLVE
    EVOLVE --> OUT
    style REF fill:#7ed321,stroke:#333,color:#fff
    style DATA fill:#4a90d9,stroke:#333,color:#fff
    style SEED fill:#bd10e0,stroke:#333,color:#fff
    style EVOLVE fill:#f5a623,stroke:#333,color:#fff
    style OUT fill:#50e3c2,stroke:#333,color:#fff
```

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies. _CSV_ = Comma-Separated Values.
_SVG_ = Scalable Vector Graphics. _FFI_ = Foreign Function Interface.

`discovery_at_scale.ts` runs end-to-end:

1. Build a moderately-large hand-crafted reference creature with `buildLargeCreature(...)` and use
   it to synthesise a deterministic binary `.bin` training set. The reference is only the _label
   oracle_ — NEAT-AI never sees it.
2. Seed evolution with `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — six inputs, three outputs, no
   hidden neurons, no warm start.
3. Call `Creature.evolveDir(dataDir, options)` over the `.bin` directory in forward-only mode until
   either the per-example `targetError` is reached or the `timeoutMinutes: 5` backstop fires (issue
   #208 stop-condition rule).
4. Capture per-generation telemetry via `onTrainingEvent` and emit a CSV plus two SVG charts.

## 📈 Latest measured run (`./discovery_at_scale/run.sh`)

> The numbers below come from the most recent local run committed alongside this README. They are
> **measured, not estimated**, per the audit rule in #208.

| Metric                    | Value                 |
| ------------------------- | --------------------- |
| Total generations         | 186                   |
| Wall-clock                | 11.3 s                |
| Final best fitness        | 0.9960                |
| Final per-record error    | 0.0040 (target met)   |
| Seed neurons / synapses   | 9 / 18                |
| Final neurons / synapses  | 14 / 32               |
| Stop condition that fired | `targetError` reached |

Topology genuinely grew: NEAT-AI added **5 hidden neurons** and **14 synapses** on top of the
minimal seed. The CSV and the two SVGs below show the trajectory across all 186 generations.

### Best vs mean fitness per generation

![Best vs mean fitness](../docs/screenshots/discovery_at_scale/fitness.svg)

### Score, neuron, and synapse counts per generation

![Score / neurons / synapses](../docs/screenshots/discovery_at_scale/topology.svg)

### Per-generation CSV

[`docs/data/discovery_at_scale/evolution.csv`](../docs/data/discovery_at_scale/evolution.csv) holds
the full per-generation telemetry with the schema mandated by the audit:

```text
generation,best_fitness,mean_fitness,neuron_count,synapse_count
```

## 🧪 What "reasonable solution" means here

The evolved champion's best fitness is **0.9960** against the binary `.bin` training set (higher is
better; the theoretical maximum is 1.0). The final per-record error of **0.0040** is below the
`targetError` stop condition — evolution stopped because the champion is producing labels within
`5 × 10⁻³` of the larger reference creature's outputs on average. That is a reasonable solution to
the labelled task: a single 9-neuron seed has been grown into a 14-neuron / 32-synapse champion that
reproduces the input → output behaviour of a 33-neuron / ~165-synapse reference _without ever seeing
its topology_.

## 🚀 Running the example

```bash
./discovery_at_scale/run.sh
```

The script writes all artefacts to `.discovery-at-scale/`, a hidden directory ignored by git. You
will find:

- `data/synthetic_*.bin` — Binary training files derived from the reference creature.
- `creatures/reference.json` — The hand-crafted reference creature (label oracle only).
- `creatures/champion.json` — The evolved champion produced from the minimal seed.

In addition, the per-generation telemetry artefacts are committed under `docs/`:

- [`docs/data/discovery_at_scale/evolution.csv`](../docs/data/discovery_at_scale/evolution.csv)
- [`docs/screenshots/discovery_at_scale/fitness.svg`](../docs/screenshots/discovery_at_scale/fitness.svg)
- [`docs/screenshots/discovery_at_scale/topology.svg`](../docs/screenshots/discovery_at_scale/topology.svg)

The legacy `docs/screenshots/discovery_at_scale.svg` showcase mirror is updated by the runner with
the same topology chart so the main README's "Unique Features Showcase" entry continues to render.

## 🧰 NEAT-AI features used

- **Minimal NEAT seed** — `new Creature(input, output)` with no hidden hint, no pre-built
  `network.json` seed; NEAT-AI random-initialises the rest.
- **`Creature.evolveDir`** over the binary `.bin` training stream (per
  [`docs/binary_training_stream.md`](../docs/binary_training_stream.md)) — orders of magnitude
  faster than per-call `activate()`.
- **Forward-only mutation** — `evolveDir` defaults to forward-only when `feedbackLoop` is not set,
  matching the audit's stop-condition + topology contract.
- **`onTrainingEvent` callback** — feeds per-generation telemetry into the CSV and the two SVG
  charts without slowing the run.
- **`buildLargeCreature`** (from `common/`) — produces the moderately-large hand-crafted reference
  whose outputs label the `.bin` set. The reference is the demo's hand-crafted state; NEAT-AI never
  sees it.

See upstream [`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)
for the broader feature catalogue. The pre-audit "Discovery-driven structural mutation" framing of
this example used Features 2 (error-guided structural evolution) and 8 (discovery caching) directly
via `Creature.discoveryDir(...)`; after the audit the runner uses random NEAT mutation, but those
features remain available for callers who want to compose them with the evolved champion.
