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

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🗺️  Maze Navigation Example"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no spawned
# subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},MAZE_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  maze_navigation/maze_navigation.ts \
  "$@"
