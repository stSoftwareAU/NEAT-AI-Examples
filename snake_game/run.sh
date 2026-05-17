#!/bin/bash
set -euo pipefail

# Snake Game Example Runner
#
# Evolves a NEAT-AI controller that plays the classic Snake grid game
# via Creature.evolveRL(), saves the champion creature, and writes an
# animated SVG of the champion's playthrough plus the milestone chart.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🐍 Snake Game Example"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no spawned
# subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},SNAKE_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  snake_game/snake_game.ts \
  "$@"
