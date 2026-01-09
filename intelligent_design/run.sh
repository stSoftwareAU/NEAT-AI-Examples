#!/bin/bash
set -euo pipefail

# Intelligent Design Example Runner
#
# This script demonstrates the Intelligent Design squash improvement workflow.
# It creates a synthetic creature, generates test data, and then scans for
# better activation functions.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

# Default squash to try (can be overridden via command line)
SQUASH="${1:-GELU}"

echo "🧬 Intelligent Design Example"
echo "   Target squash: ${SQUASH}"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  intelligent_design/improve_squash_example.ts \
  --squash="${SQUASH}" \
  "${@:2}"

