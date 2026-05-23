#!/bin/bash
set -euo pipefail

# TSP Constructive Example Runner
#
# Evolves a NEAT-AI controller that builds a closed Travelling-Salesperson
# tour one city at a time on either `burma14` (default) or `ulysses22`.
# Saves the champion creature, the tour log, the deterministic
# champion-tour SVG, and the milestone-stats SVG.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "📍 TSP Constructive Example"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},TSP_CONSTRUCTIVE_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  tsp_constructive/tsp_constructive.ts \
  "$@"
