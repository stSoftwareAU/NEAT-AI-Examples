# 🔍 Discovery — Recover a Missing Neuron

**Science-driven structural mutation, not random search.** Textbook NEAT searches network structure
with **random** add-node and add-connection mutations and evaluates the result blindly through
fitness. NEAT-AI-Discovery is **error-driven**: it analyses each neuron's activation distribution
across the dataset — flagging **saturated**, **dead**, **dormant**, **bimodal**, and **bottleneck**
neurons — correlates those signals with the loss, and proposes targeted structural changes (rewire,
replace, prune, split) backed by a GPU-accelerated Rust pipeline. See
[`COMPARISON.md` Feature 2](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)
(error-driven structural mutation) and
[`COMPARISON.md` Feature 8](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)
(discovery caching) for the upstream definitions. This example is the simplest possible window onto
that pipeline: remove one neuron, ask Discovery to find a replacement, and watch it recover the lost
behaviour — a contrast you cannot make with random mutation alone.

```mermaid
flowchart LR
    subgraph TXT["📚 Textbook NEAT — random mutation"]
        T1["🎲 Pick mutation<br/>(add-node / add-conn)"]
        T2["🧬 Apply blindly"]
        T3["🏋️ Evaluate fitness"]
        T4{"Better?"}
        T1 --> T2 --> T3 --> T4
        T4 -- "no" --> T1
        T4 -- "yes" --> TKEEP["✅ Keep"]
    end
    subgraph SCI["🔬 Discovery-driven mutation"]
        S1["📊 Activations per neuron"]
        S2["🔍 Classify<br/>saturated · dead · dormant · bimodal · bottleneck"]
        S3["📉 Correlate with loss"]
        S4["🛠 Propose targeted change<br/>rewire · replace · prune · split"]
        S5["🏋️ Evaluate"]
        S1 --> S2 --> S3 --> S4 --> S5 --> SKEEP["✅ Keep best"]
    end
    style TXT fill:#fff7e6,stroke:#e67e22,color:#333
    style SCI fill:#eaf6ff,stroke:#2e86de,color:#333
    style T1 fill:#f5a623,stroke:#333,color:#fff
    style T2 fill:#f5a623,stroke:#333,color:#fff
    style T3 fill:#f5a623,stroke:#333,color:#fff
    style T4 fill:#e74c3c,stroke:#333,color:#fff
    style TKEEP fill:#7ed321,stroke:#333,color:#fff
    style S1 fill:#4a90d9,stroke:#333,color:#fff
    style S2 fill:#9b59b6,stroke:#333,color:#fff
    style S3 fill:#bd10e0,stroke:#333,color:#fff
    style S4 fill:#16a085,stroke:#333,color:#fff
    style S5 fill:#f5a623,stroke:#333,color:#fff
    style SKEEP fill:#50e3c2,stroke:#333,color:#fff
```

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies. _FFI_ = Foreign Function Interface
(Deno's mechanism for calling native libraries from TypeScript).

`discover_missing_neuron.ts` demonstrates the neuron discovery workflow. It creates a simple
creature, generates synthetic training data, removes a hidden neuron to "cripple" the creature, and
then runs discovery to attempt to recover the missing functionality.

## 🔧 How It Works

```mermaid
flowchart TD
    REF["🧬 Reference Creature<br/>4 inputs, 4 hidden, 1 output"]
    DATA["📊 Synthetic Data<br/>Generated from reference"]
    SCORE["📏 Score Baseline"]
    CRIP["💥 Remove Hidden Neuron<br/>Crippled creature"]
    LOSS["📉 Compare Scores<br/>Show performance loss"]
    DISC["🔬 Discovery<br/>Search for replacement"]
    REPORT["📈 Report<br/>Did discovery recover?"]

    REF --> DATA
    DATA --> SCORE
    SCORE --> CRIP
    CRIP --> LOSS
    LOSS --> DISC
    DISC --> REPORT

    style REF fill:#7ed321,stroke:#333,color:#fff
    style DATA fill:#4a90d9,stroke:#333,color:#fff
    style SCORE fill:#f5a623,stroke:#333,color:#fff
    style CRIP fill:#e74c3c,stroke:#333,color:#fff
    style LOSS fill:#e67e22,stroke:#333,color:#fff
    style DISC fill:#bd10e0,stroke:#333,color:#fff
    style REPORT fill:#50e3c2,stroke:#333,color:#fff
```

1. Creates a reference creature with 4 inputs, 4 hidden neurons, and 1 output
2. Generates synthetic training data based on the creature's behaviour
3. Removes a hidden neuron (LeakyReLU) to create a "crippled" creature
4. Compares baseline and crippled scores to show the performance loss
5. Runs `Creature.discoveryDir()` to search for improvements
6. Reports whether discovery found a way to recover performance

## 📋 Prerequisites

> [!WARNING]
> The Discovery example requires a native Rust FFI library. Make sure you have it installed before
> running this example.

- The NEAT-AI-Discovery Rust library must be installed. Build it via `cargo build --release` in the
  NEAT-AI-Discovery repository and copy the resulting library to `~/.cargo/lib/`.
- Deno with FFI permissions enabled.

## 🚀 Running the Example

> ⚡ **Speed note:** this example writes its training data in NEAT-AI's binary format — see
> [`docs/binary_training_stream.md`](../docs/binary_training_stream.md).

```bash
./discovery/run.sh
```

The script writes all artefacts to `.synthetic-discovery/`, a hidden directory ignored by git. You
will find:

- `data/` – Binary training data containing the synthetic observations
- `creatures/baseline.json` – The untouched reference creature
- `creatures/crippled.json` – The creature with the target neuron removed
- `creatures/discovered.json` – The best candidate returned by discovery (when available)

## 🧰 NEAT-AI Features Used

Discovery is NEAT-AI's science-driven structural operator: rather than mutating randomly, it
analyses activations to target the changes worth making.

Features exercised (links go to upstream
[`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)):

- **[Error-Guided Structural Evolution](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#2--error-guided-structural-evolution)**
  — GPU-accelerated discovery of beneficial structural changes
  (saturated/dead/dormant/bottleneck-neuron analysis) — the core capability this example exercises.
