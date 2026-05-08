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
  --allow-read \
  --allow-write \
  --allow-env \
  memetic_evolution/memetic_evolution.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/memetic_evolution.svg" ]]; then
  deno fmt docs/screenshots/memetic_evolution.svg > /dev/null
fi
