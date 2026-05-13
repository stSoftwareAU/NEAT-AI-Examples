#!/bin/bash
set -euo pipefail

# Discovery Example Runner
#
# This script demonstrates the NEAT-AI neuron discovery workflow.
# It creates a synthetic creature, generates test data, removes a neuron,
# and then runs discovery to attempt to recover the missing functionality.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "Discovery Example"
echo "   Demonstrating neuron discovery with NEAT-AI"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  discovery/discover_missing_neuron.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean.
if [[ -f "docs/screenshots/discovery/evolution_summary.svg" ]]; then
  deno fmt docs/screenshots/discovery/evolution_summary.svg > /dev/null
fi
