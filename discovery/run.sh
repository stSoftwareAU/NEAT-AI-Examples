#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

: "${DISCOVERY_TARGET_UUID:=auto}"
export DISCOVERY_TARGET_UUID

# export DISCOVERY_TARGET_UUID="3b8b89e7-5ceb-4383-a419-0f11c5541ddb"

export NEAT_AI_DISCOVERY_VERBOSE=1  
(cd ../NEAT-AI-Discovery&& ./scripts/runlib.sh)

deno run \
  --v8-flags=--max-old-space-size=12288 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-ffi \
  discovery/discover_missing_neuron.ts \
  "$@"

