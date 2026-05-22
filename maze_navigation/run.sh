#!/bin/bash
set -euo pipefail

# Maze Navigation Example Runner
#
# Evolves a NEAT-AI controller that navigates a fixed grid maze from a
# start cell to a goal cell using local sensor inputs (wall distances
# plus a packed heading-to-goal). Saves the champion creature, the
# trajectory log, and writes an animated SVG of the champion's run to
# docs/screenshots/maze_navigation.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🗺️  Maze Navigation Example"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},MAZE_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  maze_navigation/maze_navigation.ts \
  "$@"
