#!/bin/bash
set -euo pipefail

# Lunar Lander Descent Example Runner
#
# Evolves a NEAT-AI controller that lands a simplified 2D lunar lander
# on a flat pad, saves the champion creature, and writes an SVG snapshot
# of the descent to docs/screenshots/lunar_lander.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

export NEAT_EXAMPLES_MAX_HEAP_MB=8192
# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🚀 Lunar Lander Descent Example"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},LUNAR_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  lunar_lander/lunar_lander.ts \
  "$@"
