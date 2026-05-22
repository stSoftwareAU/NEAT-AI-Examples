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

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "✂️  Neuron Pruning Demo"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  neuron_pruning/neuron_pruning.ts \
  "$@"
