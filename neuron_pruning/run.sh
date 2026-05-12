#!/bin/bash
set -euo pipefail

# Neuron Pruning Demo Runner (issue #87, audited #217)
#
# Evolves a creature from a minimal NEAT-AI seed via Creature.evolveDir(...)
# over a binary `.bin` training set, then injects deliberately constant-output
# hidden neurons into the evolved champion, detects them on a held-out
# dataset, prunes them with bias-fold, prints pre/post statistics and the
# per-neuron pruning report, and renders the topology SVG plus per-generation
# evolution CSV / fitness / topology charts.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "✂️  Neuron Pruning Demo"
echo ""

deno run \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  --allow-run \
  neuron_pruning/neuron_pruning.ts \
  "$@"

# Re-format the regenerated SVGs so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/neuron_pruning.svg" ]]; then
  deno fmt docs/screenshots/neuron_pruning.svg > /dev/null
fi
if [[ -f ".neuron-pruning/output/neuron_pruning.svg" ]]; then
  deno fmt .neuron-pruning/output/neuron_pruning.svg > /dev/null
fi
if [[ -f "docs/screenshots/neuron_pruning/evolution_summary.svg" ]]; then
  deno fmt docs/screenshots/neuron_pruning/evolution_summary.svg > /dev/null
fi
