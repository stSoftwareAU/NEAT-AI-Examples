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
  mcmc_acceptance/mcmc_acceptance.ts \
  "$@"

# Re-format the regenerated SVG so subsequent `deno fmt --check` runs
# stay clean — the renderer emits compact output for readability, and
# `deno fmt` prefers attributes split across multiple lines.
if [[ -f "docs/screenshots/mcmc_acceptance.svg" ]]; then
  deno fmt docs/screenshots/mcmc_acceptance.svg > /dev/null
fi
