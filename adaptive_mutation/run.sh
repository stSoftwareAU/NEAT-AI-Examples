#!/bin/bash
set -euo pipefail

# Adaptive Mutation Rate Demo Runner (issue #86, audited #212)
#
# Evolves a NEAT-AI creature from a minimal seed (input + output
# counts only) over a binary `.bin` regression task, captures
# per-generation telemetry, and writes the headline SVG plus the
# fitness and topology charts.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🧬 Adaptive Mutation Rate Demo"
echo ""

# Scoped permissions (issue #419):
#   --allow-env: HOME/USERPROFILE for cache lookups; the NEAT_AI_* vars
#     are read by @stsoftware/neat-ai; DENO_TEST is set by `deno test`.
#   --allow-net=jsr.io: @stsoftware/neat-ai fetches the WASM activation
#     payload from jsr.io at runtime (WasmActivationPayload.ts).
#   --allow-run is not granted — no Deno.run/Command calls. The
#     `quality.sh` wrapper injects --allow-run=df for the NEAT-AI
#     discovery disk-space check during the full quality run.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  --allow-ffi \
  adaptive_mutation/adaptive_mutation.ts \
  "$@"
