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

# shellcheck source=common/example_runner_preamble.sh
source "${REPO_ROOT}/common/example_runner_preamble.sh"

echo "🧠 XOR Classification Example"
echo ""

# Scoped permissions (issue #419): shared flags via NEAT_EXAMPLE_DENO_FLAGS;
# per-example --allow-env extras and --allow-net hosts below.

deno run \
  "${NEAT_EXAMPLE_DENO_FLAGS[@]}" \
  --allow-env="${NEAT_AI_ENV_VARS},XOR_QUICK,NEAT_MULTI_RUN_BASE_DIR" \
  --allow-net=jsr.io \
  ${ALLOW_RUN_ARGS[@]+"${ALLOW_RUN_ARGS[@]}"} \
  xor_classification/xor_classification.ts \
  "$@"
