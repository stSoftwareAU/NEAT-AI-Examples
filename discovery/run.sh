#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

: "${DISCOVERY_TARGET_UUID:=1a814dd3-7238-4cec-beba-10bda54b88d0}"
export DISCOVERY_TARGET_UUID

deno run \
  --v8-flags=--max-old-space-size=12288 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-ffi \
  discovery/discover_missing_neuron.ts \
  "$@"

