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

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🚀 Lunar Lander Descent Example"
echo ""

# `LUNAR_QUICK=1` (or `--quick`) forces the runner into the CI/quality
# fast path: tiny iterations cap, no canonical-artefact writes, so
# quality.sh stays inside its tight per-section budget without
# overwriting the docs SVGs checked into the repo.
# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no spawned
# subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=8192 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},LUNAR_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  --allow-ffi \
  lunar_lander/lunar_lander.ts \
  "$@"
