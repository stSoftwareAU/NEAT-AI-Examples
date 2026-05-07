# 🔢 MNIST Classification

Evolve a NEAT-AI creature to classify handwritten digits from a small subset of the classic
[MNIST](http://yann.lecun.com/exdb/mnist/) dataset. The 28 × 28 greyscale images are downsampled to
a 14 × 14 grid (196 inputs), and the classifier emits a 10-vector of LOGISTIC outputs — one per
digit class. Training uses truncation selection with per-gene mutation, scored by classification
accuracy on a held-out fold of the data.

## ▶️ How to Run

```bash
./mnist_classification/run.sh
```

Network access is required on the first run to fetch the MNIST CSV. Subsequent runs reuse the file
cached under `.synthetic-mnist/data/`.

## 🔁 Workflow

```mermaid
flowchart LR
    DL["📥 fetchDataset()<br/>MNIST subset CSV"]
    DOWN["🔽 Down-sample<br/>28×28 → 14×14"]
    SCORE["📏 Accuracy on held-out fold"]
    EVOLVE["🧬 Truncation + mutation"]
    CHAMP["💾 champion.json"]
    GRID["🖼️ Animated 5×4 grid SVG<br/>green ✓ / red ✗"]

    DL --> DOWN --> SCORE --> EVOLVE
    EVOLVE -- not solved --> SCORE
    EVOLVE -- solved --> CHAMP --> GRID
```

## 📥 Inputs

The runner downloads a 100-row MNIST sample (~ 180 KB) hosted in the
[`eth-sri/eran`](https://github.com/eth-sri/eran/tree/master/data) repository, into
`.synthetic-mnist/data/mnist_test.csv` via [`common/data_cache.ts`](../common/data_cache.ts). Each
row is `label,p0,p1,...,p783` with pixels in `0..255`. The runner takes the first `TRAIN_ROWS = 80`
rows for the training fold and the next `TEST_ROWS = 20` for the validation / test fold — small
enough to evolve to convergence in seconds while still covering every digit class.

A second mirror (the
[`makeyourownneuralnetwork/mnist_train_100.csv`](https://github.com/makeyourownneuralnetwork/makeyourownneuralnetwork)
sample) is configured as a fallback so a single 404 does not break the example. Each first-time run
fetches the file once; subsequent runs reuse the cached copy under `.synthetic-mnist/data/`.

### 🔽 Down-sampling

To keep evolution tractable each 28 × 28 image is **average-pooled** into a 14 × 14 grid — every
output cell is the mean of a 2 × 2 block of source pixels. The classifier therefore consumes 196
inputs in the range `[0, 1]`. The original 28 × 28 pixels are kept on each sample for the SVG
renderer so the visualisation still shows the full-resolution digit.

## 📤 Outputs

| Path                                        | Contents                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| `.synthetic-mnist/data/mnist_test.csv`      | The cached MNIST subset CSV.                               |
| `.synthetic-mnist/creatures/champion.json`  | The fittest classifier serialised as `CreatureExport`.     |
| `.synthetic-mnist/output/confusion.json`    | A 10 × 10 confusion matrix (`m[actual][predicted]`).       |
| `docs/screenshots/mnist_classification.svg` | Animated 5 × 4 grid of test predictions (green ✓ / red ✗). |

## 🧬 Network

| Layer  | Count | Squash   |
| ------ | ----- | -------- |
| Input  | 196   | LOGISTIC |
| Output | 10    | LOGISTIC |

The classifier is fully connected with no hidden layer — a 196 × 10 weight matrix plus 10 biases,
totalling **1 970 parameters**. Initial weights and biases are drawn from `[-0.1, 0.1]` so the
starting outputs sit near `0.5`.

## 🧪 Tests

```bash
deno test --no-check --allow-read --allow-write --allow-env mnist_classification/
```

The test suite uses a synthetic fixture (10 linearly-separable digit classes with light pixel noise)
so it runs in seconds and never touches the network. Coverage:

- **Happy path** — given a fixed seed and the fixture CSV, the trained champion's accuracy on the
  validation fold meets the documented floor.
- **Edge case** — passing a non-existent dataset path raises a clear error that names
  `loadMnistDataset`.
- **Reproducibility** — two runs with the same seed produce byte-identical champions.

## 🧠 Why a fully-connected single-layer network?

For a tiny demonstration the simplest model that can express the MNIST decision boundary is
multinomial logistic regression — i.e. a 196 → 10 dense layer with LOGISTIC outputs. It evolves
quickly enough to fit inside the 5-minute CI budget and still achieves a respectable accuracy on
this small subset, while keeping the code easy to read.

## 🔁 Reproducibility

The example uses [`common/deterministic_random.ts`](../common/deterministic_random.ts) for both
population initialisation and mutation, so any run with the same seed produces a byte-identical
champion. The default seed is `12345`.
