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

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no --allow-run
# (quality.sh injects --allow-run=df via the deno wrapper during the
# full quality run).
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},SYNAPSE_QUICK" \
  --allow-net=jsr.io \
  --allow-ffi \
  synthetic_synapse/synthetic_synapse_example.ts \
  "$@"
