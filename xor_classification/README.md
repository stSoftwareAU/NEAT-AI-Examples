# 🧠 XOR Classification — Hello World of NEAT

`xor_classification.ts` evolves a tiny NEAT-AI network that learns the XOR truth table — the
canonical "Hello World" of neuroevolution. The data, the evolutionary loop, and the SVG renderer all
run in pure TypeScript; the only library dependency is NEAT-AI's `Creature.activate`.

![XOR decision boundary](../docs/screenshots/xor_decision_boundary.svg)

![XOR evolution chart — best-fitness score curve on the left axis, neuron and synapse counts on the right axis, with a final-generation annotation showing the champion's score and topology](../docs/screenshots/xor_classification/evolution.svg)

## 🔧 How It Works

```mermaid
flowchart LR
    DATA["📊 XOR Samples<br/>4 truth-table rows"]
    INIT["🎲 Random Population<br/>2-2-1 networks"]
    SCORE["📏 Score by 1 - MSE"]
    SELECT["🏆 Truncation Selection<br/>top 50% are parents"]
    MUTATE["🧬 Mutate Weights & Biases"]
    SOLVED{"Error ≤ threshold?"}
    CHAMP["💾 Save champion.json"]
    RENDER["🖼️ Render SVG<br/>Decision Boundary"]
    SHOT["📸 docs/screenshots/<br/>xor_decision_boundary.svg"]

    DATA --> SCORE
    INIT --> SCORE
    SCORE --> SELECT
    SELECT --> MUTATE
    MUTATE --> SCORE
    SCORE --> SOLVED
    SOLVED -- yes --> CHAMP
    SOLVED -- no, more generations --> SELECT
    CHAMP --> RENDER
    RENDER --> SHOT

    style DATA fill:#4a90d9,stroke:#333,color:#fff
    style INIT fill:#f5a623,stroke:#333,color:#fff
    style SCORE fill:#f39c12,stroke:#333,color:#fff
    style SELECT fill:#e67e22,stroke:#333,color:#fff
    style MUTATE fill:#e74c3c,stroke:#333,color:#fff
    style CHAMP fill:#7ed321,stroke:#333,color:#fff
    style RENDER fill:#bd10e0,stroke:#333,color:#fff
    style SHOT fill:#50e3c2,stroke:#333,color:#fff
```

## 🎯 Inputs and Outputs

| Channel  | Type    | Symbol | Meaning                                     |
| -------- | ------- | ------ | ------------------------------------------- |
| Input 0  | feature | `a`    | First operand of XOR (0 or 1)               |
| Input 1  | feature | `b`    | Second operand of XOR (0 or 1)              |
| Output 0 | scalar  | —      | `>= 0.5` predicts class `1`, else class `0` |

The XOR truth table:

| `a` | `b` | target |
| --- | --- | ------ |
| 0   | 0   | 0      |
| 0   | 1   | 1      |
| 1   | 0   | 1      |
| 1   | 1   | 0      |

Fitness is `1 - MSE` across the four samples; the task is "solved" when the mean squared error drops
below the configured `errorThreshold` (default 0.05) and all four samples are classified correctly.

## 🚀 Running the Example

```bash
./xor_classification/run.sh
```

Artefacts:

- `.synthetic-xor/creatures/champion.json` – the fittest classifier from the run
- `.synthetic-xor/snapshots/snapshot-gen-*.json` – running-champion snapshots captured at the
  configured checkpoints
- `docs/screenshots/xor_decision_boundary.svg` – the committed decision-boundary plot
- `docs/screenshots/xor_classification/evolution.svg` – per-generation evolution chart (best-fitness
  score on the left axis, neuron and synapse counts on the right axis)
- `docs/screenshots/xor_classification_evolution.svg` – multi-panel evolution-progression strip
  rendered from the captured snapshots

> [!TIP]
> The script writes its working data to `.synthetic-xor/`, a hidden directory ignored by git.

## Evolution Progress

![XOR evolution-progression strip — one panel per checkpoint generation showing the running champion's topology and score, linked by a score-progression polyline](../docs/screenshots/xor_classification_evolution.svg)

The runner captures a snapshot of the **running champion** at each of the canonical checkpoint
generations `[1, 10, 100, 500]` (those that fall inside the configured `maxGenerations`). The XOR
example typically solves before generation 100, so the rendered strip usually shows two panels — gen
1 and gen 10 — linked by a score-progression polyline. Each panel displays the champion's topology
(inputs → hidden → output), the generation label, and the score (`1 - MSE`) at that checkpoint; the
bottom strip charts the score over the captured generations.

## 🧠 Tacit Knowledge

A few things that are not obvious from the code alone:

- **Two hidden neurons are the minimum.** A purely linear `w·s + b` cannot represent XOR — the
  classes are not linearly separable. The example uses two TANH hidden neurons feeding a single
  LOGISTIC output, the smallest network that can solve the problem.
- **Reproducibility.** All randomness flows through `common/deterministic_random.ts`. With a fixed
  seed the same champion is produced on every run.
- **Decision boundary, not just labels.** The SVG shades the entire input square `[0, 1]²` by the
  network's continuous output, so you can see the boundary curve. Cleanly-separated XOR shows up as
  four diagonal "quadrants" of alternating colour.
