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

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "Discovery Example"

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},DISCOVERY_QUICK" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  discovery/discover_missing_neuron.ts \
  "$@"
