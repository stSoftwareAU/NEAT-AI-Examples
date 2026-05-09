# 🧬 CRISPR Gene Injection — Hand-Crafted Subgraph Splicing

**Acronym.** _NEAT_ = NeuroEvolution of Augmenting Topologies. (CRISPR is borrowed as a metaphor
from molecular biology — Clustered Regularly Interspaced Short Palindromic Repeats — where it
describes a precise gene-editing technique. Here it stands for the same idea applied to neural
network topology.)

`crispr_injection.ts` demonstrates a structural intervention that is unique to NEAT-style
neuroevolution: a hand-crafted **edit gene** — a small subgraph of neurons and synapses with
known-good behaviour — is spliced directly into a stalled population, then evolution continues.
Random weight mutation alone cannot construct this structure because the missing topology has no
gradient to follow; CRISPR-style injection bypasses that obstacle by inserting the structure
wholesale.

## 🔧 How It Works

```mermaid
flowchart TD
    TARGET["🎯 Target Creature<br/>2 inputs → 2 TANH hidden → 1 output"]
    DATA["📊 Synthetic Data<br/>generated from target"]
    POP["👥 Baseline Population<br/>no hidden neurons"]
    EVOLVE1["🔁 Pre-injection Evolution<br/>perturb-and-keep<br/>(plateaus quickly)"]
    GENE["🧬 Hand-Crafted Gene<br/>2 TANH hidden + synapses"]
    INJECT["💉 CRISPR Injection<br/>splice into top N members"]
    EVOLVE2["🔁 Post-injection Evolution<br/>fitness lifts as gene<br/>weights are tuned"]
    SVG["🖼️ output/crispr_injection.svg<br/>topology + fitness curve"]

    TARGET --> DATA
    POP --> EVOLVE1
    DATA --> EVOLVE1
    EVOLVE1 --> INJECT
    GENE --> INJECT
    INJECT --> EVOLVE2
    DATA --> EVOLVE2
    EVOLVE2 --> SVG

    style TARGET fill:#16a085,stroke:#333,color:#fff
    style DATA fill:#f5a623,stroke:#333,color:#fff
    style POP fill:#4a90d9,stroke:#333,color:#fff
    style EVOLVE1 fill:#9b59b6,stroke:#333,color:#fff
    style GENE fill:#bd10e0,stroke:#333,color:#fff
    style INJECT fill:#e74c3c,stroke:#333,color:#fff
    style EVOLVE2 fill:#27ae60,stroke:#333,color:#fff
    style SVG fill:#50e3c2,stroke:#333,color:#fff
```

1. Build a target creature with two TANH hidden neurons that compute a non-linear function of two
   inputs. This pair of hidden neurons is the **gene**.
2. Generate synthetic training data from the target — every record is `(input₀, input₁, target_y)`.
3. Build a baseline population whose members have **no hidden neurons** — they cannot capture the
   non-linearity, so a perturb-and-keep evolution loop quickly plateaus.
4. Inject the hand-crafted gene into the top N members of the stalled population, replacing them
   with gene-bearing variants.
5. Resume the same evolution loop. Fitness lifts sharply because the gene has the structure needed
   to fit the target; the loop merely tunes its incoming weights.

## 🔬 Why CRISPR-Style Injection Matters

Pure random mutation explores the structural space one connection at a time, which is fine for local
refinements but very slow when the missing topology requires several coordinated additions
(neurons + their synapses) before any fitness improvement is realised. NEAT-AI's UUID-keyed neurons
make a structural splice well-defined and reversible:

- **Gene identity is portable.** Each gene neuron has a UUID, so the same gene can be injected into
  multiple population members and tracked across generations.
- **Splicing is non-destructive.** Host weights are preserved; the gene's prescribed edges are added
  to the existing graph rather than replacing it.
- **The lift is attributable.** Because the gene is added all at once, the post-injection fitness
  jump is causally tied to the splice — making this a useful debugging and ablation tool.

## 🚀 Running the Example

```bash
./crispr_injection/run.sh
```

The script writes all artefacts to `.synthetic-crispr-injection/`, a hidden directory ignored by
git. You will find:

- `data/` – binary training data generated from the target creature
- `creatures/target.json` – the creature whose outputs define the synthetic task
- `creatures/gene.json` – a baseline-with-gene reference creature
- `creatures/best.json` – the best post-injection creature from the experiment
- `output/crispr_injection.svg` – the rendered topology + fitness chart

A copy of the chart is also written to `docs/screenshots/crispr_injection.svg` for the main README.

## 🧰 NEAT-AI Features Used

CRISPR injection is one of NEAT-AI's gene-level structural operators. This example splices a
hand-crafted edit gene into a stalled population.

Features exercised (links go to upstream
[`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)):

- **[CRISPR Gene Injection](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#5--crispr-gene-injection)**
  — splices a hand-crafted gene (a small sub-network) into evolved descendants by neuron UUID — the
  central technique this example demonstrates.
- **[UUID-Based Extensible Observations](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#3--uuid-based-extensible-observations)**
  — neuron UUIDs make the splice cleanly addressable across crossovers and mutations — without
  UUIDs, gene injection would not survive evolution.
