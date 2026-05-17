#!/bin/bash
set -euo pipefail

# MCMC Mutation Acceptance Demo Runner
#
# Runs the adaptive Metropolis-Hastings sampler, prints summary
# statistics, and renders the dual-axis acceptance/temperature chart
# to docs/screenshots/mcmc_acceptance.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🌡️  MCMC Mutation Acceptance Demo"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no spawned
# subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  --allow-ffi \
  mcmc_acceptance/mcmc_acceptance.ts \
  "$@"
