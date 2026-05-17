#!/bin/bash
set -euo pipefail

# Crossover (Breeding) Example Runner
#
# This script demonstrates the crossover (breeding) workflow.
# It creates two parent creatures with different architectures,
# breeds them to produce offspring, and compares performance.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 Crossover (Breeding) Example"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no --allow-run
# (quality.sh injects --allow-run=df via the deno wrapper during the
# full quality run).
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},CROSSOVER_QUICK" \
  --allow-net=jsr.io \
  --allow-ffi \
  crossover/crossover_example.ts \
  "$@"
