#!/bin/bash
set -euo pipefail

# Intelligent Design Example Runner
#
# This script demonstrates the Intelligent Design squash improvement workflow.
# It creates a synthetic creature, generates test data, and then scans for
# better activation functions.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧬 Intelligent Design Example"

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS}" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  intelligent_design/improve_squash_example.ts \
  "$@"
