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

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no spawned
# subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},DISCOVERY_QUICK" \
  --allow-net=jsr.io \
  --allow-ffi \
  discovery/discover_missing_neuron.ts \
  "$@"
