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

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no --allow-run
# (quality.sh injects --allow-run=df via the deno wrapper during the
# full quality run).
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  --allow-ffi \
  neuron_pruning/neuron_pruning.ts \
  "$@"
