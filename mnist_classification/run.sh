#!/bin/bash
set -euo pipefail

# MNIST Classification Example Runner
#
# Downloads a small subset of the classic MNIST handwritten-digit
# dataset, evolves a 196-input/10-output classifier, and writes an
# animated SVG grid to docs/screenshots/mnist_classification.svg.
# Network access is required for the first run; subsequent runs
# reuse the cached CSV under .synthetic-mnist/data/.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🔢 MNIST Classification Example"
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
