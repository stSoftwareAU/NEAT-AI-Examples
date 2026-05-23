#!/bin/bash
set -euo pipefail

# tsp_two_opt example runner
#
# Evolves a NEAT-AI controller as a learned 2-opt local-search heuristic
# on a TSPLIB instance (burma14 by default; pass --instance=ulysses22 for
# the larger one). Persists the champion and writes a side-by-side SVG
# (NN seed vs improved tour) to docs/screenshots/tsp_two_opt.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧭 tsp_two_opt — learned 2-opt local-search heuristic"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},TSP_TWO_OPT_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  tsp_two_opt/tsp_two_opt.ts \
  "$@"
