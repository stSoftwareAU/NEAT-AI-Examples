# 🔢 MNIST — Handwritten Digit Classification

`mnist_classification.ts` evolves a small NEAT-AI network to classify handwritten digits from a 1000
/ 200 / 200 slice of the canonical MNIST test set. The IDX-format files are downloaded once into
`.synthetic-mnist/data/` (with SHA-256 digests pinned so runs are byte-stable), down-sampled from 28
× 28 to 14 × 14, and the evolutionary loop runs entirely in pure TypeScript.

![Animated grid of MNIST champion predictions, with green ticks for correct classifications and red crosses for misclassifications](../docs/screenshots/mnist_classification.svg)

## 🔧 How It Works

```mermaid
flowchart LR
    DL["📥 fetchDataset()<br/>MNIST IDX (pinned)"]
    DOWN["🔽 Down-sample<br/>28×28 → 14×14"]
    SPLIT["✂️ train / val / test<br/>contiguous slice"]
    INIT["🌱 Template warm-start<br/>per-class mean image"]
    EVOLVE["🧬 Truncation + mutation"]
    SCORE["📏 Accuracy on held-out fold"]
    CHAMP["💾 champion.json"]
    CONF["🧮 confusion.json"]
    GRID["🖼️ Animated 5×4 grid SVG<br/>green ✓ / red ✗"]

    DL --> DOWN --> SPLIT --> INIT --> EVOLVE --> SCORE
    SCORE -- not solved --> EVOLVE
    SCORE -- solved --> CHAMP --> CONF --> GRID

    style DL fill:#4a90d9,stroke:#333,color:#fff
    style DOWN fill:#f5a623,stroke:#333,color:#fff
    style SPLIT fill:#f39c12,stroke:#333,color:#fff
    style INIT fill:#1abc9c,stroke:#333,color:#fff
    style EVOLVE fill:#e74c3c,stroke:#333,color:#fff
    style SCORE fill:#9b59b6,stroke:#333,color:#fff
    style CHAMP fill:#7ed321,stroke:#333,color:#fff
    style CONF fill:#bd10e0,stroke:#333,color:#fff
    style GRID fill:#2ecc71,stroke:#333,color:#fff
```

## 📊 Dataset

| Field             | Value                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Source            | [`storage.googleapis.com/cvdf-datasets/mnist`](https://storage.googleapis.com/cvdf-datasets/mnist) (CVDF-hosted MNIST mirror) |
| Files used        | `t10k-images-idx3-ubyte.gz` (10 000 images) + `t10k-labels-idx1-ubyte.gz`                                                     |
| Format            | IDX-3 / IDX-1 binary, gzip-compressed                                                                                         |
| Cache path        | `.synthetic-mnist/data/`                                                                                                      |
| Integrity         | SHA-256 verified by `common/data_cache.ts`                                                                                    |
| Native resolution | 28 × 28 greyscale pixels (8-bit per pixel)                                                                                    |
| Down-sampled      | 14 × 14 (mean-pool over 2 × 2 source blocks, normalised to `[0, 1]`)                                                          |

> **Why IDX, not CSV?** The issue text suggested a "stable public CSV mirror"; the IDX gzip pair is
> the canonical primary distribution of MNIST and weighs ~1.6 MB compared to ~18 MB for the
> equivalent CSV. The CVDF Google-Cloud mirror is widely used by ML libraries and digest-pinnable.
> Using it keeps both the example download and the cached file small without sacrificing
> reproducibility.

## 🎯 Inputs and Outputs

| Channel      | Type     | Meaning                                                                |
| ------------ | -------- | ---------------------------------------------------------------------- |
| Input 0..195 | feature  | Down-sampled pixel intensity (`[0, 1]`) at the 14 × 14 grid position   |
| Output 0..9  | LOGISTIC | Per-class score; the predicted digit is the argmax over the 10 outputs |

The fitness signal during evolution is **classification accuracy on the validation slice** (a
held-out fold of the training set). The runner reports the run as solved once the champion's
held-out accuracy crosses the configurable `accuracyThreshold` (default `0.70`).

## 🚦 Train / Validation / Test Split

The samples are sliced **in source order** (no shuffling) so two runs over the same IDX bytes
produce byte-identical folds.

| Slice      | Count | Role                                                    |
| ---------- | ----- | ------------------------------------------------------- |
| Train      | 1 000 | Source for the per-class mean templates (warm start)    |
| Validation | 200   | Fitness signal scored once per candidate per generation |
| Test       | 200   | Held out for the confusion matrix and SVG grid          |

## 🌱 Template Warm-Start

Pure mutation of 1960 weights from random initialisation barely beats 10 % within the CI 5-minute
budget. Instead, every population member starts at a **per-class mean image template**: each
output's weights are set to `(class_mean − grand_mean)` plus a small uniform perturbation.

This is mathematically a "nearest-template" classifier — already 55–60 % accurate on MNIST — and
mutation refines from there. Documented because the warm-start is non-obvious from the gene-tweak
loop alone.

## 🚀 Running the Example

```bash
./mnist_classification/run.sh
```

Artefacts:

- `.synthetic-mnist/data/t10k-images-idx3-ubyte.gz` — cached gzipped images
- `.synthetic-mnist/data/t10k-labels-idx1-ubyte.gz` — cached gzipped labels
- `.synthetic-mnist/creatures/champion.json` — fittest classifier from the run
- `.synthetic-mnist/output/confusion.json` — 10 × 10 confusion matrix on the held-out test set
- `docs/screenshots/mnist_classification.svg` — animated 5 × 4 grid of test predictions

## 🖼️ Reading the Grid

Each of the 20 grid cells cross-fades through three held-out test digits over the 9-second animation
loop. The label below each cell shows `T:<true> P:<predicted>` — green when the prediction is
correct, red when it is wrong.

| Symbol  | Colour  | Meaning            |
| ------- | ------- | ------------------ |
| ✓ green | #2ecc71 | Correct prediction |
| ✗ red   | #e74c3c | Misclassification  |

The pixel intensity of each digit is mapped through a purple → teal → yellow ramp so the SVG stays
"fun and colourful" even at small sizes.

## 🧠 Tacit Knowledge

A few things that are not obvious from the code alone:

- **IDX over CSV.** Smaller, canonical, and digest-pinnable. The repo deliberately stays away from
  third-party CSV mirrors that can be unpublished without notice.
- **Down-sample, do not interpolate.** 2 × 2 mean-pooling keeps the operation deterministic and
  makes 196 features (vs 784) tractable for the evolutionary loop. Higher-resolution features would
  4× the weight count without proportionally improving accuracy in this teaching setting.
- **Template warm-start.** Random init + mutation is hopeless on 1960 weights inside a 5-minute
  budget. Starting at per-class means gets the search into a useful neighbourhood before the first
  generation runs.
- **Reproducibility.** All randomness flows through `common/deterministic_random.ts`. With a fixed
  seed and the pinned IDX digests, the same champion is produced on every run.
- **Held-out scoring.** The validation slice is what the score function looks at — the train slice
  is only used to compute the warm-start template, so candidates never overfit to a per-sample
  fitness signal.
