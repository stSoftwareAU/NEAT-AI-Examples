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

deno run \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-ffi \
  mcmc_acceptance/mcmc_acceptance.ts \
  "$@"
