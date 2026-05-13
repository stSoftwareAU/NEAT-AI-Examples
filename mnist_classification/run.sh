#!/bin/bash
set -euo pipefail

# MNIST Handwritten-Digit Classification Example Runner
#
# Writes the FULL 60 000-record MNIST training set to a binary `.bin`
# file, seeds NEAT-AI with `new Creature(784, 10)` (no hidden hint, no
# warm start), and runs `Creature.evolveDir(dataDir,
# { targetError: 0.001, timeoutMinutes: 10 })` exactly once. Saves the
# evolved champion + a confusion matrix and renders the prediction-grid
# SVG.
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
  deno fmt "docs/screenshots/mnist_classification.svg" > /dev/null
fi
if [[ -f "docs/screenshots/mnist_classification/evolution_summary.svg" ]]; then
  deno fmt "docs/screenshots/mnist_classification/evolution_summary.svg" > /dev/null
fi
