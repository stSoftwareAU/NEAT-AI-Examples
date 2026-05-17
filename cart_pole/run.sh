#!/bin/bash
set -euo pipefail

# Cart-Pole Balancing Example Runner
#
# Evolves a NEAT-AI controller that balances an inverted pole on a
# moving cart, saves the champion creature, and writes an SVG snapshot
# of the run to docs/screenshots/cart_pole.svg.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🎢 Cart-Pole Balancing Example"
echo ""

# Scoped permissions (issue #419): allowlist the env vars the example
# and @stsoftware/neat-ai actually read; --allow-net is scoped to jsr.io
# for the runtime WASM activation fetch; no --allow-run.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},CART_POLE_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  cart_pole/cart_pole.ts \
  "$@"
