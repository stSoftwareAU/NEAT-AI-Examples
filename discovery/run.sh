#!/bin/bash
set -euo pipefail

# Discovery Example Runner
#
# This script demonstrates the NEAT-AI neuron discovery workflow.
# It creates a synthetic creature, generates test data, removes a neuron,
# and then runs discovery to attempt to recover the missing functionality.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

echo "Discovery Example"
echo "   Demonstrating neuron recovery with NEAT-AI"
echo ""

deno run \
  --v8-flags=--max-old-space-size=4096 \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-ffi \
  discovery/discover_missing_neuron.ts \
  "$@"
