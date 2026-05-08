#!/bin/bash
set -euo pipefail

# MNIST Handwritten-Digit Classification Example Runner
#
# Default mode (used by quality.sh): trains the SGD/MLP baseline
# (`evolveMLPClassifier`) on the canonical MNIST 50k / 10k / 10k split,
# saves the champion creature, the confusion matrix, the prediction
# grid SVG (docs/screenshots/mnist_classification.svg) and the
# dual-axis per-epoch evolution chart
# (docs/screenshots/mnist_classification_evolution_chart.svg).
#
# Set MNIST_NEAT_EVOLUTION=1 to instead run the long-form NEAT
# evolution from uniform-random noise (`evolveClassifier`). This is a
# one-off developer screenshot run that may take hours and additionally
# emits the multi-panel evolution-progression strip
# (docs/screenshots/mnist_classification_evolution.svg).
#
# Network access is required on the first run to download the gzipped
# IDX files into .synthetic-mnist/data/; subsequent runs use the cached
# copies.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🔢 MNIST Handwritten-Digit Classification Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  mnist_classification/mnist_classification.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/mnist_classification.svg" ]]; then
  deno fmt docs/screenshots/mnist_classification.svg > /dev/null
fi
