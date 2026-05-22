#!/bin/bash
set -euo pipefail

# Memetic Evolution Demo Runner (issue #90)
#
# Runs the memetic-vs-control comparison on a synthetic weight-tuning
# task, prints summary statistics, and renders the dual-curve fitness
# chart to docs/screenshots/memetic_evolution.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧠 Memetic Evolution Demo"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  memetic_evolution/memetic_evolution.ts \
  "$@"
