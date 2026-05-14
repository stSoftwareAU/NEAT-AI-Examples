#!/bin/bash
set -euo pipefail

# XOR Classification Example Runner
#
# Evolves a NEAT-AI classifier that learns the XOR truth table, saves
# the champion creature, and writes:
#
#   - docs/screenshots/xor_decision_boundary.svg
#   - docs/screenshots/xor_classification/milestones.svg
#       (multi-run error-curve chart — issue #326).
#   - docs/screenshots/xor_classification/complexity.svg
#       (multi-run creature complexity chart — issue #326).

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧠 XOR Classification Example"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  xor_classification/xor_classification.ts \
  "$@"
