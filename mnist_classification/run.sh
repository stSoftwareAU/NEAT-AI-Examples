#!/bin/bash
set -euo pipefail

# MNIST Handwritten-Digit Classification Example Runner
#
# Default mode (audit issue #210): writes a binary `.bin` training
# subset, seeds NEAT-AI with `new Creature(196, 10)` (no hidden hint,
# no warm start) and runs `Creature.evolveDir(...)` over the `.bin`
# stream until either the per-example `targetError` is reached or the
# `timeoutMinutes: 5` backstop fires. Emits per-generation telemetry
# (CSV + best/mean fitness SVG + neuron / synapse SVG) plus the
# prediction grid SVG and a confusion matrix.
#
# Optional modes:
#   - MNIST_MLP_BASELINE=1: SGD/MLP baseline (`evolveMLPClassifier`)
#     for fast comparison; does not start from random noise and does
#     not grow topology.
#   - MNIST_NEAT_EVOLUTION=1: legacy long-form developer screenshot
#     run using the in-process `evolveClassifier` mutation loop.
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

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
for svg in \
  "docs/screenshots/mnist_classification.svg" \
  "docs/screenshots/mnist_classification/evolution.svg" \
  "docs/screenshots/mnist_classification/fitness.svg" \
  "docs/screenshots/mnist_classification/topology.svg" \
  "docs/screenshots/mnist_classification_evolution.svg"; do
  if [[ -f "${svg}" ]]; then
    deno fmt "${svg}" > /dev/null
  fi
done
