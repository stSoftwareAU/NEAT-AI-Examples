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

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧬 Synthetic Synapse Training Demo"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},SYNAPSE_QUICK" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  synthetic_synapse/synthetic_synapse_example.ts \
  "$@"
