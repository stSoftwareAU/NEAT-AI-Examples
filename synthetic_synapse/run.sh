#!/bin/bash
set -euo pipefail

# Synthetic Synapse Training Demo Runner (issue #85)
#
# Runs the densify-then-prune comparison plus a matched-budget control,
# prints summary statistics, and renders the topology / bar-chart SVG to
# .synthetic-synapse/output/synthetic_synapse.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 Synthetic Synapse Training Demo"
echo ""

deno run \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  --allow-run \
  synthetic_synapse/synthetic_synapse_example.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/synthetic_synapse.svg" ]]; then
  deno fmt docs/screenshots/synthetic_synapse.svg > /dev/null
fi
if [[ -f ".synthetic-synapse/output/synthetic_synapse.svg" ]]; then
  deno fmt .synthetic-synapse/output/synthetic_synapse.svg > /dev/null
fi
