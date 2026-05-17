#!/bin/bash
set -euo pipefail

# Discovery-at-Scale Demo Runner (issue #84)
#
# Builds a deterministic large creature (~200 hidden neurons), injects a
# mix of structural defects (saturated, dead, dormant, dormant synapses,
# bottleneck), runs Creature.discoveryDir to attempt recovery, prints
# baseline / crippled / discovered scores plus a defect tally, and
# renders the before/after topology SVG to:
#
#   .discovery-at-scale/output/discovery_at_scale.svg
#   docs/screenshots/discovery_at_scale.svg
#
# Discovery is wrapped in try/catch in the demo — if the underlying
# NEAT-AI-Discovery FFI library is unavailable, the rest of the pipeline
# (scoring, defect detection, SVG rendering) still runs.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

echo "🔬 Discovery-at-Scale Demo"
echo ""

# Scoped permissions (issue #419): allowlist env vars; --allow-net is
# scoped to jsr.io for the runtime WASM activation fetch; no spawned
# subprocesses.
NEAT_AI_ENV_VARS="HOME,USERPROFILE,DENO_TEST,NEAT_AI_DISCOVERY_LIB_PATH,NEAT_AI_DISCOVERY_VERBOSE,NEAT_AI_TRACE_PREDICTION,NEAT_AI_WORKER_INIT_TIMEOUT_MS,NEAT_DISCOVERY_AWAIT_CLEANUP"

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  --allow-ffi \
  discovery_at_scale/discovery_at_scale.ts \
  "$@"
