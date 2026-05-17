#!/bin/bash
set -euo pipefail

# XOR Classification Example Runner
#
# Evolves a NEAT-AI classifier that learns the XOR truth table, saves
# the champion creature, and writes:
#
#   - docs/screenshots/xor_decision_boundary.svg
#   - docs/screenshots/xor_classification/milestones.svg
#       (multi-run error-curve chart — issue #326).
#   - docs/screenshots/xor_classification/complexity.svg
#       (multi-run creature complexity chart — issue #326).

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Add deno to PATH if not already available
if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧠 XOR Classification Example"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no spawned
# subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS},XOR_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  xor_classification/xor_classification.ts \
  "$@"
