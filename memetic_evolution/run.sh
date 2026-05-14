#!/bin/bash
set -euo pipefail

# Memetic Evolution Demo Runner (issue #90)
#
# Runs the memetic-vs-control comparison on a synthetic weight-tuning
# task, prints summary statistics, and renders the dual-curve fitness
# chart to docs/screenshots/memetic_evolution.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧠 Memetic Evolution Demo"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  memetic_evolution/memetic_evolution.ts \
  "$@"
